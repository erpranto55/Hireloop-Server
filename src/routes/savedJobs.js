import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";

const router = Router();

router.get("/", asyncHandler(async (req, res) => {
  const { seekerEmail } = req.query;
  if (!seekerEmail) return badRequest(res, "seekerEmail query parameter is required");

  const savedJobs = await getDb()
    .collection("savedJobs")
    .find({ seekerEmail })
    .sort({ savedAt: -1 })
    .toArray();

  res.json(savedJobs);
}));

router.post("/", asyncHandler(async (req, res) => {
  const required = ["jobId", "jobTitle", "companyName", "seekerEmail"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const savedJob = {
    ...req.body,
    savedAt: new Date(),
  };

  const result = await getDb().collection("savedJobs").insertOne(savedJob);
  created(res, { ...savedJob, _id: result.insertedId });
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid saved job id");

  const result = await getDb().collection("savedJobs").deleteOne({ _id });
  if (!result.deletedCount) return notFound(res, "Saved job not found");

  res.status(204).send();
}));

export default router;