import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

// GET /api/applications - List applications with strict role scoping
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const { seekerEmail, jobId, recruiterEmail, status } = req.query;
  const filter = {};
  const userRole = (req.user.role || "seeker").toLowerCase();
  const db = getDb();

  if (userRole === "admin") {
    // Admin can filter by any parameter
    if (seekerEmail) filter.seekerEmail = new RegExp(`^${seekerEmail}$`, "i");
    if (jobId) filter.jobId = jobId;
    if (recruiterEmail) filter.recruiterEmail = new RegExp(`^${recruiterEmail}$`, "i");
  } else if (userRole === "recruiter") {
    // Recruiter can only view applications for their posted jobs
    if (jobId) {
      // Verify recruiter owns this job
      const jobObjectId = toObjectId(jobId);
      const job = await db.collection("jobs").findOne(jobObjectId ? { _id: jobObjectId } : { id: jobId });
      if (!job || job.recruiterEmail?.toLowerCase() !== req.user.email.toLowerCase()) {
        return res.status(403).json({
          message: "Forbidden: You can only view applications for jobs posted by your account.",
        });
      }
      filter.jobId = jobId;
    } else {
      filter.recruiterEmail = new RegExp(`^${req.user.email}$`, "i");
    }
  } else {
    // Seeker can strictly only view their own applications
    filter.seekerEmail = new RegExp(`^${req.user.email}$`, "i");
    if (jobId) filter.jobId = jobId;
  }

  if (status) filter.status = status;

  const applications = await db
    .collection("applications")
    .find(filter)
    .sort({ appliedAt: -1 })
    .toArray();

  res.json(applications);
}));

// POST /api/applications - Submit application (Seekers or Admin)
router.post("/", requireAuth, requireRole("seeker", "admin"), asyncHandler(async (req, res) => {
  const required = ["jobId", "jobTitle", "companyName"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const seekerEmail = isAdmin && req.body.seekerEmail ? req.body.seekerEmail : req.user.email;

  const db = getDb();
  // Fetch job to ensure it exists, is active, and copy recruiterEmail
  const jobObjectId = toObjectId(req.body.jobId);
  const job = await db.collection("jobs").findOne(jobObjectId ? { _id: jobObjectId } : { id: req.body.jobId });
  if (!job) return notFound(res, "Job listing not found");

  const application = {
    ...req.body,
    seekerEmail,
    seekerName: req.body.seekerName || req.user.name,
    recruiterEmail: job.recruiterEmail || req.body.recruiterEmail,
    status: "applied",
    appliedAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection("applications").insertOne(application);

  if (jobObjectId) {
    await db.collection("jobs").updateOne({ _id: jobObjectId }, { $inc: { applicantsCount: 1 } });
  }

  created(res, { ...application, _id: result.insertedId });
}));

// PATCH /api/applications/:id/status - Review application (Recruiter or Admin only)
router.patch("/:id/status", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid application id");
  if (!req.body.status) return badRequest(res, "Status is required");

  const db = getDb();
  const application = await db.collection("applications").findOne({ _id });
  if (!application) return notFound(res, "Application not found");

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const isRecruiterOwner = application.recruiterEmail?.toLowerCase() === req.user.email?.toLowerCase();

  if (!isAdmin && !isRecruiterOwner) {
    return res.status(403).json({
      message: "Forbidden: Only the recruiter for this job or an administrator can update application status.",
    });
  }

  const result = await db
    .collection("applications")
    .findOneAndUpdate(
      { _id },
      { $set: { status: req.body.status, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

  res.json(result);
}));

export default router;