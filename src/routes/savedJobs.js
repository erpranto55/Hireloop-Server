import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// GET /api/saved-jobs - View saved jobs (Scoped to current authenticated user)
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const seekerEmail = isAdmin && req.query.seekerEmail ? req.query.seekerEmail : req.user.email;

  const savedJobs = await getDb()
    .collection("savedJobs")
    .find({ seekerEmail: new RegExp(`^${seekerEmail}$`, "i") })
    .sort({ savedAt: -1 })
    .toArray();

  res.json(savedJobs);
}));

// POST /api/saved-jobs - Save a job (Scoped to current user)
router.post("/", requireAuth, asyncHandler(async (req, res) => {
  const required = ["jobId", "jobTitle", "companyName"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const seekerEmail = isAdmin && req.body.seekerEmail ? req.body.seekerEmail : req.user.email;

  const savedJob = {
    ...req.body,
    seekerEmail,
    savedAt: new Date(),
  };

  const result = await getDb().collection("savedJobs").insertOne(savedJob);
  created(res, { ...savedJob, _id: result.insertedId });
}));

// DELETE /api/saved-jobs/:id - Remove saved job (Owner or Admin only)
router.delete("/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid saved job id");

  const db = getDb();
  const existing = await db.collection("savedJobs").findOne({ _id });
  if (!existing) return notFound(res, "Saved job not found");

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const isOwner = existing.seekerEmail?.toLowerCase() === req.user.email?.toLowerCase();

  if (!isAdmin && !isOwner) {
    return res.status(403).json({
      message: "Forbidden: You cannot remove bookmarks belonging to another user.",
    });
  }

  const result = await db.collection("savedJobs").deleteOne({ _id });
  if (!result.deletedCount) return notFound(res, "Saved job not found");

  res.status(204).send();
}));

export default router;