import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getRecruiterJobLimit } from "../config/plans.js";

const router = Router();

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
  // Enforce recruiter email matches authenticated user unless admin
  const recruiterEmail = isAdmin && req.body.recruiterEmail ? req.body.recruiterEmail : req.user.email;
  const status = req.body.status || "active";

  const db = getDb();

  // Enforce recruiter active job limits on non-admins
  if (!isAdmin && status === "active") {
    const user = await db.collection("user").findOne({ email: new RegExp(`^${recruiterEmail}$`, "i") });
    const planName = user?.plan || "Free";
    const limit = getRecruiterJobLimit(planName);

    const activeCount = await db.collection("jobs").countDocuments({
      recruiterEmail: new RegExp(`^${recruiterEmail}$`, "i"),
      status: "active",
    });

    if (activeCount >= limit) {
      return res.status(403).json({
        message: `Active job post limit reached for your ${planName} plan (${limit} active jobs allowed). Please upgrade your plan or archive an existing job.`,
        limit,
        activeCount,
        plan: planName,
      });
    }
  }

  const job = {
    ...req.body,
    recruiterEmail,
    status,
    applicantsCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection("jobs").insertOne(job);
  created(res, { ...job, _id: result.insertedId });
}));

// PATCH /api/jobs/:id - Update job (Owner recruiter or Admin only)
router.patch("/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid job id");

  const db = getDb();
  const existingJob = await db.collection("jobs").findOne({ _id });
  if (!existingJob) return notFound(res, "Job not found");

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const isOwner = existingJob.recruiterEmail?.toLowerCase() === req.user.email?.toLowerCase();

  if (!isAdmin && !isOwner) {
    return res.status(403).json({
      message: "Forbidden: You can only edit jobs posted by your account.",
    });
  }

  // If activating an inactive job, verify active job limit
  if (!isAdmin && req.body.status === "active" && existingJob.status !== "active") {
    const user = await db.collection("user").findOne({ email: new RegExp(`^${existingJob.recruiterEmail}$`, "i") });
    const planName = user?.plan || "Free";
    const limit = getRecruiterJobLimit(planName);

    const activeCount = await db.collection("jobs").countDocuments({
      recruiterEmail: new RegExp(`^${existingJob.recruiterEmail}$`, "i"),
      status: "active",
    });

    if (activeCount >= limit) {
      return res.status(403).json({
        message: `Active job post limit reached for your ${planName} plan (${limit} active jobs allowed). Please upgrade your plan to activate this job.`,
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

  res.json(result);
}));

// DELETE /api/jobs/:id - Delete job (Owner recruiter or Admin only)
router.delete("/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid job id");

  const db = getDb();
  const existingJob = await db.collection("jobs").findOne({ _id });
  if (!existingJob) return notFound(res, "Job not found");

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const isOwner = existingJob.recruiterEmail?.toLowerCase() === req.user.email?.toLowerCase();

  if (!isAdmin && !isOwner) {
    return res.status(403).json({
      message: "Forbidden: You can only delete jobs posted by your account.",
    });
  }

  const result = await db.collection("jobs").deleteOne({ _id });
  if (!result.deletedCount) return notFound(res, "Job not found");

  res.status(204).send();
}));

export default router;