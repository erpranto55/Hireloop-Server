import { Router } from "express";
import { getDb } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, notFound } from "../utils/http.js";

const router = Router();

router.get("/", asyncHandler(async (req, res) => {
  const { email, role, status } = req.query;
  const filter = {};

  if (email) filter.email = new RegExp(email, "i");
  if (role) filter.role = role;
  if (status) filter.status = status;

  const users = await getDb().collection("user").find(filter).sort({ createdAt: -1 }).toArray();
  res.json(users);
}));

router.patch("/:email", asyncHandler(async (req, res) => {
  if (!req.params.email) return badRequest(res, "Email is required");

  const result = await getDb()
    .collection("user")
    .findOneAndUpdate(
      { email: req.params.email },
      { $set: { ...req.body, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

  if (!result) return notFound(res, "User not found");
  res.json(result);
}));

export default router;