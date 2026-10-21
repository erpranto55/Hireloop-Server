import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { optionalAuth, requireAuth, requireRole } from "../middleware/auth.js";
import { recordAuditLog } from "../services/auditService.js";

const router = Router();

// GET /api/companies - Public view of approved companies, recruiter's own, or admin full list
router.get("/", optionalAuth, asyncHandler(async (req, res) => {
  const { status = "approved", industry, recruiterEmail } = req.query;
  const filter = {};
  const isAdmin = req.user && (req.user.role || "").toLowerCase() === "admin";
  const isOwnerRecruiter = req.user && recruiterEmail && req.user.email.toLowerCase() === recruiterEmail.toLowerCase();

  if (isAdmin) {
    if (status !== "all") filter.status = status;
  } else if (isOwnerRecruiter) {
    // A recruiter can see their own company regardless of whether it's pending or approved
    if (status !== "all") filter.status = status;
  } else {
    // General public and other users only see approved companies
    filter.status = "approved";
  }

  if (industry) filter.industry = industry;
  if (recruiterEmail) filter.recruiterEmail = new RegExp(`^${recruiterEmail}$`, "i");

  const companies = await getDb()
    .collection("companies")
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray();

  res.json(companies);
}));

// GET /api/companies/:id - Public company profile
router.get("/:id", asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid company id");

  const company = await getDb().collection("companies").findOne({ _id });
  if (!company) return notFound(res, "Company not found");

  res.json(company);
}));

// POST /api/companies - Create company (Recruiter or Admin)
router.post("/", requireAuth, requireRole("recruiter", "admin"), asyncHandler(async (req, res) => {
  const required = ["name", "industry", "location"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const recruiterEmail = isAdmin && req.body.recruiterEmail ? req.body.recruiterEmail : req.user.email;

  const company = {
    ...req.body,
    recruiterEmail,
    status: isAdmin && req.body.status ? req.body.status : "pending",
    openJobs: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await getDb().collection("companies").insertOne(company);
  created(res, { ...company, _id: result.insertedId });
}));

// PATCH /api/companies/:id - Update company or approve standing
router.patch("/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid company id");

  const db = getDb();
  const existingCompany = await db.collection("companies").findOne({ _id });
  if (!existingCompany) return notFound(res, "Company not found");

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const isOwner = existingCompany.recruiterEmail?.toLowerCase() === req.user.email?.toLowerCase();

  if (!isAdmin && !isOwner) {
    return res.status(403).json({
      message: "Forbidden: You do not have permission to edit this company.",
    });
  }

  const updateFields = { ...req.body };
  delete updateFields._id;

  // Only admin can change company moderation status
  if (updateFields.status !== undefined && !isAdmin) {
    return res.status(403).json({
      message: "Forbidden: Only platform administrators can update company verification status.",
    });
  }

  // Non-admins cannot transfer company ownership
  if (!isAdmin) {
    delete updateFields.recruiterEmail;
  }

  updateFields.updatedAt = new Date();

  const result = await db.collection("companies").findOneAndUpdate(
    { _id },
    { $set: updateFields },
    { returnDocument: "after" },
  );

  if (isAdmin && updateFields.status && updateFields.status !== existingCompany.status) {
    recordAuditLog({
      actor: req.user,
      action: "company_moderated",
      targetType: "company",
      targetId: existingCompany._id.toString(),
      targetIdentifier: existingCompany.name,
      before: { status: existingCompany.status },
      after: { status: updateFields.status },
    });
  }

  res.json(result);
}));

export default router;