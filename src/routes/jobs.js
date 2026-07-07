import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";

const router = Router();

router.get("/", asyncHandler(async (req, res) => {
  const { q, type, location, category, status = "active", recruiterEmail, companyId, limit = 30 } = req.query;
  const filter = {};

  if (q) filter.$text = { $search: q };
  if (type) filter.type = type;
  if (location) filter.location = new RegExp(location, "i");
  if (category) filter.category = category;
  if (status !== "all") filter.status = status;
  if (recruiterEmail) filter.recruiterEmail = recruiterEmail;
  if (companyId) filter.companyId = companyId;

  const jobs = await getDb()
    .collection("jobs")
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 30, 100))
    .toArray();

  res.json(jobs);
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid job id");

  const job = await getDb().collection("jobs").findOne({ _id });
  if (!job) return notFound(res, "Job not found");

  res.json(job);
}));

router.post("/", asyncHandler(async (req, res) => {
  const required = ["title", "category", "type", "companyId", "companyName", "recruiterEmail"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const job = {
    ...req.body,
    status: req.body.status || "active",
    applicantsCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await getDb().collection("jobs").insertOne(job);
  created(res, { ...job, _id: result.insertedId });
}));

router.patch("/:id", asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid job id");

  const result = await getDb()
    .collection("jobs")
    .findOneAndUpdate(
      { _id },
      { $set: { ...req.body, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

  if (!result) return notFound(res, "Job not found");
  res.json(result);
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid job id");

  const result = await getDb().collection("jobs").deleteOne({ _id });
  if (!result.deletedCount) return notFound(res, "Job not found");

  res.status(204).send();
}));

export default router;