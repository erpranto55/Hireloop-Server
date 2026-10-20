import { Router } from "express";
import { getDb } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, notFound } from "../utils/http.js";
import { requireAuth, sanitizeUser } from "../middleware/auth.js";

const router = Router();

// GET /api/users - List users (Admin only) or fetch own profile
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const { email, role, status } = req.query;
  const isAdmin = (req.user.role || "").toLowerCase() === "admin";

  // Non-admins can only query their own record
  if (!isAdmin) {
    if (!email || email.toLowerCase() !== req.user.email.toLowerCase()) {
      return res.status(403).json({
        message: "Forbidden: Administrator privileges required to list all user accounts.",
      });
    }
  }

  const filter = {};
  if (email) filter.email = new RegExp(`^${email}$`, "i");
  if (role) filter.role = role;
  if (status) filter.status = status;

  const users = await getDb()
    .collection("user")
    .find(filter, { projection: { password: 0 } })
    .sort({ createdAt: -1 })
    .toArray();

  res.json(users.map(sanitizeUser));
}));

// PATCH /api/users/:email - Update profile or manage role/standing
router.patch("/:email", requireAuth, asyncHandler(async (req, res) => {
  const targetEmail = req.params.email;
  if (!targetEmail) return badRequest(res, "Email parameter is required");

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const isSelf = req.user.email.toLowerCase() === targetEmail.toLowerCase();

  if (!isAdmin && !isSelf) {
    return res.status(403).json({
      message: "Forbidden: You cannot modify another user's account.",
    });
  }

  const updateData = {};

  if (isAdmin) {
    // Admin can update status, role, and profile fields
    if (req.body.status !== undefined) {
      const allowedStatuses = ["active", "suspended"];
      if (!allowedStatuses.includes(req.body.status)) {
        return badRequest(res, `Invalid status. Must be one of: ${allowedStatuses.join(", ")}`);
      }
      updateData.status = req.body.status;
    }

    if (req.body.role !== undefined) {
      const allowedRoles = ["seeker", "recruiter", "admin"];
      if (!allowedRoles.includes(req.body.role)) {
        return badRequest(res, `Invalid role. Must be one of: ${allowedRoles.join(", ")}`);
      }
      updateData.role = req.body.role;
    }

    if (req.body.plan !== undefined) updateData.plan = req.body.plan;
  } else {
    // Non-admin attempting to modify role or status must be rejected
    if (req.body.role !== undefined && req.body.role !== req.user.role) {
      return res.status(403).json({
        message: "Forbidden: You cannot modify your own role or privileges.",
      });
    }
    if (req.body.status !== undefined && req.body.status !== req.user.status) {
      return res.status(403).json({
        message: "Forbidden: You cannot modify your own account standing.",
      });
    }
  }

  // Permitted profile fields for both self and admin
  const allowedProfileFields = ["name", "headline", "image", "bio", "resumeUrl", "skills", "companyId"];
  for (const field of allowedProfileFields) {
    if (req.body[field] !== undefined) {
      updateData[field] = req.body[field];
    }
  }

  if (Object.keys(updateData).length === 0) {
    return badRequest(res, "No valid fields provided to update");
  }

  updateData.updatedAt = new Date();

  const result = await getDb()
    .collection("user")
    .findOneAndUpdate(
      { email: new RegExp(`^${targetEmail}$`, "i") },
      { $set: updateData },
      { returnDocument: "after", projection: { password: 0 } },
    );

  if (!result) return notFound(res, "User not found");
  res.json(sanitizeUser(result));
}));

export default router;