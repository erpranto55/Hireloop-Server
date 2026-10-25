import { Router } from "express";
import { getDb } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, notFound } from "../utils/http.js";
import { requireAuth, sanitizeUser } from "../middleware/auth.js";
import { recordAuditLog } from "../services/auditService.js";
import { hasPermission, PERMISSIONS, validateSuperAdminLockout } from "../services/permissionService.js";

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
    // Admin can update status, role, and profile fields subject to role permissions
    if (req.body.status !== undefined) {
      if (!hasPermission(req.user, PERMISSIONS.MODERATION_USERS) && !hasPermission(req.user, PERMISSIONS.ADMIN_MANAGE_ROLES)) {
        return res.status(403).json({
          message: "Forbidden: Insufficient permissions to modify user account standing.",
        });
      }

      const allowedStatuses = ["active", "suspended"];
      if (!allowedStatuses.includes(req.body.status)) {
        return badRequest(res, `Invalid status. Must be one of: ${allowedStatuses.join(", ")}`);
      }

      // Check lockout prevention
      const lockoutCheck = await validateSuperAdminLockout({
        targetEmail,
        nextStatus: req.body.status,
      });
      if (!lockoutCheck.allowed) {
        return res.status(403).json({
          message: `Forbidden: ${lockoutCheck.reason}`,
        });
      }

      updateData.status = req.body.status;
    }

    if (req.body.role !== undefined) {
      if (!hasPermission(req.user, PERMISSIONS.ADMIN_MANAGE_ROLES)) {
        return res.status(403).json({
          message: "Forbidden: Only a Super Administrator can assign or modify user roles.",
        });
      }

      const allowedRoles = ["seeker", "recruiter", "admin"];
      if (!allowedRoles.includes(req.body.role)) {
        return badRequest(res, `Invalid role. Must be one of: ${allowedRoles.join(", ")}`);
      }

      // Check lockout prevention
      const lockoutCheck = await validateSuperAdminLockout({
        targetEmail,
        nextRole: req.body.role,
      });
      if (!lockoutCheck.allowed) {
        return res.status(403).json({
          message: `Forbidden: ${lockoutCheck.reason}`,
        });
      }

      updateData.role = req.body.role;
    }

    if (req.body.plan !== undefined) {
      if (!hasPermission(req.user, PERMISSIONS.BILLING_ENTITLEMENTS) && !hasPermission(req.user, PERMISSIONS.ADMIN_MANAGE_ROLES)) {
        return res.status(403).json({
          message: "Forbidden: Insufficient permissions to modify user billing plan.",
        });
      }
      updateData.plan = req.body.plan;
    }
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
    if (req.body.plan !== undefined && req.body.plan !== req.user.plan) {
      return res.status(403).json({
        message: "Forbidden: You cannot modify your own subscription plan directly.",
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

  const db = getDb();
  const existingUser = await db.collection("user").findOne({ email: new RegExp(`^${targetEmail}$`, "i") });
  if (!existingUser) return notFound(res, "User not found");

  const result = await db
    .collection("user")
    .findOneAndUpdate(
      { email: new RegExp(`^${targetEmail}$`, "i") },
      { $set: updateData },
      { returnDocument: "after", projection: { password: 0 } },
    );

  if (!result) return notFound(res, "User not found");

  // Record audit logs for sensitive administrator actions
  if (isAdmin) {
    if (updateData.status && updateData.status !== existingUser.status) {
      recordAuditLog({
        actor: req.user,
        action: "user_status_changed",
        targetType: "user",
        targetId: existingUser._id?.toString(),
        targetIdentifier: existingUser.email,
        before: { status: existingUser.status },
        after: { status: updateData.status },
      });
    }

    if (updateData.role && updateData.role !== existingUser.role) {
      recordAuditLog({
        actor: req.user,
        action: "user_role_changed",
        targetType: "user",
        targetId: existingUser._id?.toString(),
        targetIdentifier: existingUser.email,
        before: { role: existingUser.role },
        after: { role: updateData.role },
      });
    }

    if (updateData.plan && updateData.plan !== existingUser.plan) {
      recordAuditLog({
        actor: req.user,
        action: "admin_plan_updated",
        targetType: "user",
        targetId: existingUser._id?.toString(),
        targetIdentifier: existingUser.email,
        before: { plan: existingUser.plan || "Free" },
        after: { plan: updateData.plan },
      });
    }
  }

  res.json(sanitizeUser(result));
}));

export default router;