import { Router } from "express";
import { getDb } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// GET /api/payments - Payment history (Owner or Admin only)
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const { role, status } = req.query;
  const filter = {};
  const isAdmin = (req.user.role || "").toLowerCase() === "admin";

  if (isAdmin) {
    if (req.query.userEmail) filter.userEmail = new RegExp(`^${req.query.userEmail}$`, "i");
  } else {
    // Non-admins can only see their own payment history
    filter.userEmail = new RegExp(`^${req.user.email}$`, "i");
  }

  if (role) filter.role = role;
  if (status) filter.status = status;

  const payments = await getDb().collection("payments").find(filter).sort({ createdAt: -1 }).toArray();
  res.json(payments);
}));

// POST /api/payments - Record payment (Scoped to current user)
router.post("/", requireAuth, asyncHandler(async (req, res) => {
  const required = ["plan", "amount", "transactionId"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const userEmail = isAdmin && req.body.userEmail ? req.body.userEmail : req.user.email;

  const payment = {
    ...req.body,
    userEmail,
    role: req.user.role,
    status: req.body.status || "paid",
    createdAt: new Date(),
  };

  const result = await getDb().collection("payments").insertOne(payment);
  created(res, { ...payment, _id: result.insertedId });
}));

export default router;