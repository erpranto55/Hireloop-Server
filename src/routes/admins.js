import { Router } from "express";
import { getDb } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, notFound } from "../utils/http.js";
import { requireAuth, sanitizeUser } from "../middleware/auth.js";
import {
  ADMIN_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  SUPPORTED_ADMIN_ROLES,
  getEffectivePermissions,
  requirePermission,
  resolveAdminRole,
  validateSuperAdminLockout,
} from "../services/permissionService.js";
import { recordAuditLog } from "../services/auditService.js";

const router = Router();

// All routes in this router require super_admin (ADMIN_MANAGE_ROLES)
router.use(requireAuth, requirePermission(PERMISSIONS.ADMIN_MANAGE_ROLES));

/**
 * GET /api/admin/admins - List all administrative accounts
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = getDb();
    const admins = await db
      .collection("user")
      .find({ role: "admin" }, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray();

    const enriched = admins.map((admin) => {
      const sanitized = sanitizeUser(admin);
      const adminRole = resolveAdminRole(admin);
      return {
        ...sanitized,
        adminRole,
        permissions: getEffectivePermissions({ ...admin, adminRole }),
      };
    });

    res.json(enriched);
  })
);

/**
 * GET /api/admin/admins/roles - Supported roles and their permissions
 */
router.get(
  "/roles",
  asyncHandler(async (_req, res) => {
    const rolesMetadata = [
      {
        id: ADMIN_ROLES.SUPER_ADMIN,
        name: "Super Administrator",
        description: "Full platform oversight, role delegation, announcements, and configuration.",
        permissions: ROLE_PERMISSIONS[ADMIN_ROLES.SUPER_ADMIN],
      },
      {
        id: ADMIN_ROLES.SUPPORT_MODERATOR,
        name: "Support Moderator",
        description: "Routine platform safety, user reports, and job/content moderation.",
        permissions: ROLE_PERMISSIONS[ADMIN_ROLES.SUPPORT_MODERATOR],
      },
      {
        id: ADMIN_ROLES.COMPLIANCE_OFFICER,
        name: "Compliance Officer",
        description: "Regulatory compliance, audit log review, and export generation.",
        permissions: ROLE_PERMISSIONS[ADMIN_ROLES.COMPLIANCE_OFFICER],
      },
      {
        id: ADMIN_ROLES.BILLING_ADMIN,
        name: "Billing Administrator",
        description: "Financial records, payment investigations, and subscription adjustments.",
        permissions: ROLE_PERMISSIONS[ADMIN_ROLES.BILLING_ADMIN],
      },
    ];

    res.json(rolesMetadata);
  })
);

/**
 * GET /api/admin/admins/:email/history - Audit trail for admin role changes
 */
router.get(
  "/:email/history",
  asyncHandler(async (req, res) => {
    const targetEmail = req.params.email;
    if (!targetEmail) return badRequest(res, "Email parameter is required");

    const db = getDb();
    const history = await db
      .collection("audit_logs")
      .find({
        targetIdentifier: new RegExp(`^${targetEmail}$`, "i"),
        action: { $in: ["admin_role_assigned", "admin_role_changed", "admin_role_revoked", "user_role_changed", "admin_role_migrated"] },
      })
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();

    res.json(history);
  })
);

/**
 * PATCH /api/admin/admins/:email/role - Assign, change, or revoke administrative role
 */
router.patch(
  "/:email/role",
  asyncHandler(async (req, res) => {
    const targetEmail = req.params.email;
    const { adminRole, reason } = req.body;

    if (!targetEmail) return badRequest(res, "Target email is required");
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return badRequest(res, "A documented reason is required to modify administrative roles");
    }

    const trimmedReason = reason.trim();
    const isRevocation = adminRole === "revoked" || adminRole === null;

    if (!isRevocation && !SUPPORTED_ADMIN_ROLES.includes(adminRole)) {
      return badRequest(
        res,
        `Invalid administrative role. Supported: ${SUPPORTED_ADMIN_ROLES.join(", ")} or 'revoked'`
      );
    }

    const db = getDb();
    const targetUser = await db
      .collection("user")
      .findOne({ email: new RegExp(`^${targetEmail}$`, "i") });

    if (!targetUser) {
      return notFound(res, "Target user not found");
    }

    const currentAdminRole = resolveAdminRole(targetUser);

    // Prevent self-demotion or self-revocation if they are the last active super_admin
    const lockoutCheck = await validateSuperAdminLockout({
      targetEmail,
      nextRole: isRevocation ? "seeker" : "admin",
      nextAdminRole: isRevocation ? null : adminRole,
      nextStatus: targetUser.status,
    });

    if (!lockoutCheck.allowed) {
      return res.status(403).json({
        message: `Forbidden: ${lockoutCheck.reason}`,
      });
    }

    const updateFields = {
      updatedAt: new Date(),
    };

    let action = "admin_role_changed";
    if (isRevocation) {
      action = "admin_role_revoked";
      updateFields.role = "seeker";
      updateFields.adminRole = null;
    } else {
      action = targetUser.role === "admin" ? "admin_role_changed" : "admin_role_assigned";
      updateFields.role = "admin";
      updateFields.adminRole = adminRole;
    }

    const result = await db.collection("user").findOneAndUpdate(
      { email: new RegExp(`^${targetEmail}$`, "i") },
      { $set: updateFields },
      { returnDocument: "after", projection: { password: 0 } }
    );

    // Revoke active sessions if demoted or revoked so stale tokens cannot operate
    if (isRevocation || updateFields.adminRole !== currentAdminRole) {
      await db.collection("session").deleteMany({
        $or: [{ userId: targetUser._id }, { userId: targetUser._id?.toString() }],
      });
    }

    // Record audit event
    recordAuditLog({
      actor: req.user,
      action,
      targetType: "user",
      targetId: targetUser._id?.toString(),
      targetIdentifier: targetUser.email,
      before: {
        role: targetUser.role,
        adminRole: currentAdminRole,
      },
      after: {
        role: updateFields.role,
        adminRole: updateFields.adminRole,
      },
      reason: trimmedReason,
    });

    const sanitized = sanitizeUser(result);
    res.json({
      ...sanitized,
      adminRole: resolveAdminRole(result),
      permissions: getEffectivePermissions(result),
      message: `Administrative role successfully updated to ${adminRole}`,
    });
  })
);

export default router;
