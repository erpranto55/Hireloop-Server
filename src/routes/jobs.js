import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { requireAuth, requireRole, optionalAuth } from "../middleware/auth.js";
import { getRecruiterJobLimit } from "../config/plans.js";
import { recordAuditLog } from "../services/auditService.js";
import { recordJobViewHandler } from "./analytics.js";
import {
  verifyCompanyAccess,
  verifyVacancyAccess,
  assignVacancyMembers,
  COMPANY_ROLES,
} from "../services/companyWorkspaceService.js";

const router = Router();

// POST /api/jobs/:id/view - Public privacy-conscious job view tracking
router.post("/:id/view", optionalAuth, asyncHandler(recordJobViewHandler));

// GET /api/jobs - Public job browsing
router.get("/", asyncHandler(async (req, res) => {
  const { q, type, location, category, status = "active", recruiterEmail, companyId, limit = 30 } = req.query;
  const filter = {};

  if (q) filter.$text = { $search: q };
  if (type) filter.type = type;
  if (location) filter.location = new RegExp(location, "i");
  if (category) filter.category = category;
  if (status !== "all") filter.status = status;
  if (recruiterEmail) filter.recruiterEmail = new RegExp(`^${recruiterEmail}$`, "i");
  if (companyId) filter.companyId = companyId;

  const jobs = await getDb()
    .collection("jobs")
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 30, 100))
    .toArray();

  res.json(jobs);
}));

// GET /api/jobs/:id - Public job detail
router.get("/:id", asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid job id");

  const job = await getDb().collection("jobs").findOne({ _id });
  if (!job) return notFound(res, "Job not found");

  res.json(job);
}));

// POST /api/jobs - Recruiter or Admin can post jobs
router.post("/", requireAuth, requireRole("recruiter", "admin"), asyncHandler(async (req, res) => {
  const required = ["title", "category", "type", "companyId", "companyName"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const recruiterEmail = isAdmin && req.body.recruiterEmail ? req.body.recruiterEmail : req.user.email;
  const status = req.body.status || "active";

  const db = getDb();

  // Enforce company workspace authorization and active job limits on non-admins
  if (!isAdmin) {
    const access = await verifyCompanyAccess(req.user, req.body.companyId, COMPANY_ROLES.HIRING_MANAGER);
    if (!access.authorized) {
      return res.status(403).json({
        message: "Forbidden: You must be a Company Owner or Hiring Manager to post vacancies for this company.",
      });
    }

    if (status === "active") {
      // Authoritative company quota is based on the company owner's subscription plan
      const compObjectId = toObjectId(req.body.companyId);
      const company = compObjectId ? await db.collection("companies").findOne({ _id: compObjectId }) : null;
      const ownerEmail = company?.recruiterEmail || recruiterEmail;
      const ownerUser = await db.collection("user").findOne({ email: new RegExp(`^${ownerEmail}$`, "i") });
      const planName = ownerUser?.plan || "Free";
      const limit = getRecruiterJobLimit(planName);

      const activeCount = await db.collection("jobs").countDocuments({
        companyId: req.body.companyId,
        status: "active",
      });

      if (activeCount >= limit) {
        return res.status(403).json({
          message: `Active job post limit reached for your company workspace (${limit} active jobs allowed on the ${planName} plan). Please upgrade your plan or archive an existing listing.`,
          limit,
          activeCount,
          plan: planName,
        });
      }
    }
  }

  const assignedMemberEmails = Array.isArray(req.body.assignedMemberEmails) && req.body.assignedMemberEmails.length > 0
    ? req.body.assignedMemberEmails.map((e) => e.toLowerCase().trim())
    : [recruiterEmail.toLowerCase().trim()];

  const job = {
    ...req.body,
    recruiterEmail,
    assignedMemberEmails,
    status,
    applicantsCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection("jobs").insertOne(job);
  created(res, { ...job, _id: result.insertedId });
}));

// PATCH /api/jobs/:id - Update job (Authorized recruiter or Admin)
router.patch("/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid job id");

  const db = getDb();
  const existingJob = await db.collection("jobs").findOne({ _id });
  if (!existingJob) return notFound(res, "Job not found");

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";

  if (!isAdmin) {
    const access = await verifyVacancyAccess(req.user, existingJob, "edit");
    if (!access.authorized) {
      return res.status(403).json({
        message: `Forbidden: ${access.reason}`,
      });
    }
  }

  // If activating an inactive job, verify active job limit
  if (!isAdmin && req.body.status === "active" && existingJob.status !== "active") {
    const compObjectId = toObjectId(existingJob.companyId);
    const company = compObjectId ? await db.collection("companies").findOne({ _id: compObjectId }) : null;
    const ownerEmail = company?.recruiterEmail || existingJob.recruiterEmail;
    const ownerUser = await db.collection("user").findOne({ email: new RegExp(`^${ownerEmail}$`, "i") });
    const planName = ownerUser?.plan || "Free";
    const limit = getRecruiterJobLimit(planName);

    const activeCount = await db.collection("jobs").countDocuments({
      companyId: existingJob.companyId,
      status: "active",
    });

    if (activeCount >= limit) {
      return res.status(403).json({
        message: `Active job post limit reached for your company workspace (${limit} active jobs allowed on the ${planName} plan). Please upgrade your plan to activate this job.`,
        limit,
        activeCount,
        plan: planName,
      });
    }
  }

  const updateFields = { ...req.body };
  delete updateFields._id;
  // Non-admins cannot transfer ownership to another recruiter
  if (!isAdmin) {
    delete updateFields.recruiterEmail;
  }
  updateFields.updatedAt = new Date();

  const result = await db.collection("jobs").findOneAndUpdate(
    { _id },
    { $set: updateFields },
    { returnDocument: "after" },
  );

  if (isAdmin && updateFields.status && updateFields.status !== existingJob.status) {
    recordAuditLog({
      actor: req.user,
      action: "job_moderated",
      targetType: "job",
      targetId: existingJob._id.toString(),
      targetIdentifier: existingJob.title,
      before: { status: existingJob.status },
      after: { status: updateFields.status },
    });
  }

  res.json(result);
}));

// DELETE /api/jobs/:id - Delete job (Company owner or Admin only)
router.delete("/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid job id");

  const db = getDb();
  const existingJob = await db.collection("jobs").findOne({ _id });
  if (!existingJob) return notFound(res, "Job not found");

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";

  if (!isAdmin) {
    const access = await verifyVacancyAccess(req.user, existingJob, "delete");
    if (!access.authorized) {
      return res.status(403).json({
        message: `Forbidden: ${access.reason}`,
      });
    }
  } else {
    const { hasPermission, PERMISSIONS } = await import("../services/permissionService.js");
    if (!hasPermission(req.user, PERMISSIONS.MODERATION_JOBS)) {
      return res.status(403).json({
        message: "Forbidden: Insufficient permissions to moderate or delete job listings.",
      });
    }
  }

  const result = await db.collection("jobs").deleteOne({ _id });
  if (!result.deletedCount) return notFound(res, "Job not found");

  if (isAdmin) {
    recordAuditLog({
      actor: req.user,
      action: "job_deleted",
      targetType: "job",
      targetId: existingJob._id.toString(),
      targetIdentifier: existingJob.title,
      companyId: existingJob.companyId?.toString(),
      before: {
        title: existingJob.title,
        companyName: existingJob.companyName,
        recruiterEmail: existingJob.recruiterEmail,
        status: existingJob.status,
      },
      after: null,
    });
  }

  res.status(204).send();
}));

// PATCH /api/jobs/:id/members - Assign/unassign team members to vacancy
router.patch("/:id/members", requireAuth, asyncHandler(async (req, res) => {
  const { memberEmails } = req.body;
  if (!Array.isArray(memberEmails)) {
    return badRequest(res, "memberEmails must be an array of email addresses.");
  }

  try {
    const result = await assignVacancyMembers({
      jobId: req.params.id,
      memberEmails,
      actorUser: req.user,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}));

export default router;