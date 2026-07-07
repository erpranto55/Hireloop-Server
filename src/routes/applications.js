import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";

const router = Router();

router.get("/", asyncHandler(async (req, res) => {
  const { seekerEmail, jobId, recruiterEmail, status } = req.query;
  const filter = {};

  if (seekerEmail) filter.seekerEmail = seekerEmail;
  if (jobId) filter.jobId = jobId;
  if (recruiterEmail) filter.recruiterEmail = recruiterEmail;
  if (status) filter.status = status;

  const applications = await getDb()
    .collection("applications")
    .find(filter)
    .sort({ appliedAt: -1 })
    .toArray();

  res.json(applications);
}));

router.post("/", asyncHandler(async (req, res) => {
  const required = ["jobId", "jobTitle", "companyName", "seekerEmail"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const application = {
    ...req.body,
    status: "applied",
    appliedAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await getDb().collection("applications").insertOne(application);

  const jobObjectId = toObjectId(req.body.jobId);
  if (jobObjectId) {
    await getDb().collection("jobs").updateOne({ _id: jobObjectId }, { $inc: { applicantsCount: 1 } });
  }

  created(res, { ...application, _id: result.insertedId });
}));

router.patch("/:id/status", asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid application id");
  if (!req.body.status) return badRequest(res, "Status is required");

  const result = await getDb()
    .collection("applications")
    .findOneAndUpdate(
      { _id },
      { $set: { status: req.body.status, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

  if (!result) return notFound(res, "Application not found");
  res.json(result);
}));

export default router;