import { Router } from "express";
import { getDb } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created } from "../utils/http.js";

const router = Router();

router.get("/", asyncHandler(async (req, res) => {
  const { userEmail, role, status } = req.query;
  const filter = {};

  if (userEmail) filter.userEmail = userEmail;
  if (role) filter.role = role;
  if (status) filter.status = status;

  const payments = await getDb().collection("payments").find(filter).sort({ createdAt: -1 }).toArray();
  res.json(payments);
}));

router.post("/", asyncHandler(async (req, res) => {
  const required = ["userEmail", "plan", "amount", "transactionId"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const payment = {
    ...req.body,
    status: req.body.status || "paid",
    createdAt: new Date(),
  };

  const result = await getDb().collection("payments").insertOne(payment);
  created(res, { ...payment, _id: result.insertedId });
}));

export default router;