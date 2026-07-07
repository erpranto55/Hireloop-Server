import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";

const router = Router();

router.get("/", asyncHandler(async (req, res) => {
  const { status = "approved", industry, recruiterEmail } = req.query;
  const filter = {};

  if (status !== "all") filter.status = status;
  if (industry) filter.industry = industry;
  if (recruiterEmail) filter.recruiterEmail = recruiterEmail;

  const companies = await getDb().collection("companies").find(filter).sort({ createdAt: -1 }).toArray();
  res.json(companies);
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid company id");

  const company = await getDb().collection("companies").findOne({ _id });
  if (!company) return notFound(res, "Company not found");

  res.json(company);
}));

router.post("/", asyncHandler(async (req, res) => {
  const required = ["name", "industry", "location", "recruiterEmail"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const company = {
    ...req.body,
    status: "pending",
    openJobs: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await getDb().collection("companies").insertOne(company);
  created(res, { ...company, _id: result.insertedId });
}));

router.patch("/:id", asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid company id");

  const result = await getDb()
    .collection("companies")
    .findOneAndUpdate(
      { _id },
      { $set: { ...req.body, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

  if (!result) return notFound(res, "Company not found");
  res.json(result);
}));

export default router;