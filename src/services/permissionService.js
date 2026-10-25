import { getDb, toObjectId } from "../db.js";
import { recordAuditLog } from "./auditService.js";

/**
 * Enterprise Administrative Roles supported by HireLoop
 */
export const ADMIN_ROLES = {
  SUPER_ADMIN: "super_admin",
  SUPPORT_MODERATOR: "support_moderator",
  COMPLIANCE_OFFICER: "compliance_officer",
  BILLING_ADMIN: "billing_admin",
};

export const SUPPORTED_ADMIN_ROLES = Object.values(ADMIN_ROLES);

/**
 * Explicit granular permissions
 */
export const PERMISSIONS = {
  // Moderation & Reports
  REPORTS_READ: "reports:read",
  REPORTS_WRITE: "reports:write",
  MODERATION_JOBS: "moderation:jobs",
  MODERATION_USERS: "moderation:users",

  // Company verification
  COMPANIES_REVIEW: "companies:review",
  COMPANIES_WRITE: "companies:write",

  // Compliance & Audit
  AUDIT_READ: "audit:read",
  AUDIT_READ_BILLING: "audit:read_billing",
  AUDIT_EXPORT: "audit:export",

  // Billing & Subscriptions
  BILLING_READ: "billing:read",
  BILLING_WRITE: "billing:write",
  BILLING_ENTITLEMENTS: "billing:entitlements",

  // System Administration & Announcements
  ANNOUNCEMENTS_CREATE: "announcements:create",
  ADMIN_MANAGE_ROLES: "admin:manage_roles",
  ADMIN_CONFIG: "admin:config",
  USERS_READ_ALL: "users:read_all",
};

/**
 * Single source of truth permission matrix
 */
export const ROLE_PERMISSIONS = {
  [ADMIN_ROLES.SUPER_ADMIN]: Object.values(PERMISSIONS),

  [ADMIN_ROLES.SUPPORT_MODERATOR]: [
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.REPORTS_WRITE,
    PERMISSIONS.MODERATION_JOBS,
    PERMISSIONS.MODERATION_USERS,
    PERMISSIONS.COMPANIES_REVIEW,
    PERMISSIONS.USERS_READ_ALL,
  ],

  [ADMIN_ROLES.COMPLIANCE_OFFICER]: [
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.COMPANIES_REVIEW,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.AUDIT_EXPORT,
    PERMISSIONS.USERS_READ_ALL,
  ],

  [ADMIN_ROLES.BILLING_ADMIN]: [
    PERMISSIONS.BILLING_READ,
    PERMISSIONS.BILLING_WRITE,
    PERMISSIONS.BILLING_ENTITLEMENTS,
    PERMISSIONS.AUDIT_READ_BILLING,
    PERMISSIONS.USERS_READ_ALL,
  ],
};

/**
 * Resolves the canonical admin role for an authenticated user.
 * If user.role === "admin" but adminRole is missing or invalid,
 * falls back to super_admin for backwards compatibility.
 */
export function resolveAdminRole(user) {
  if (!user || (user.role || "").toLowerCase() !== "admin") {
    return null;
  }
  const roleCandidate = (user.adminRole || "").toLowerCase();
  if (SUPPORTED_ADMIN_ROLES.includes(roleCandidate)) {
    return roleCandidate;
  }
  // Default legacy unassigned admin to super_admin
  return ADMIN_ROLES.SUPER_ADMIN;
}

/**
 * Returns list of effective permissions granted to a user.
 */
export function getEffectivePermissions(user) {
  if (!user || user.status === "suspended") {
    return [];
  }
  const adminRole = resolveAdminRole(user);
  if (!adminRole) {
    return [];
  }
  return ROLE_PERMISSIONS[adminRole] || [];
}

/**
 * Evaluates whether a user possesses a specific permission.
 */
export function hasPermission(user, permission) {
  if (!user || user.status === "suspended") return false;
  const permissions = getEffectivePermissions(user);
  return permissions.includes(permission);
}

/**
 * Express middleware that checks if authenticated user has one of the required permissions.
 * Usage: requirePermission(PERMISSIONS.REPORTS_READ)
 * Or: requirePermission(PERMISSIONS.AUDIT_READ, PERMISSIONS.AUDIT_READ_BILLING)
 */
export function requirePermission(...requiredPermissions) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        message: "Authentication required.",
      });
    }

    if (req.user.status === "suspended") {
      return res.status(403).json({
        message: "Forbidden: Account is suspended.",
      });
    }

    if ((req.user.role || "").toLowerCase() !== "admin") {
      return res.status(403).json({
        message: "Forbidden: Administrative privileges required.",
      });
    }

    const userPermissions = getEffectivePermissions(req.user);
    const hasAny = requiredPermissions.some((perm) => userPermissions.includes(perm));

    if (!hasAny) {
      return res.status(403).json({
        message: `Forbidden: Missing required administrative permission: [${requiredPermissions.join(", ")}]. Your effective role is '${resolveAdminRole(req.user)}'.`,
      });
    }

    next();
  };
}

/**
 * Prevents lockout: Checks whether an update would demote, remove, or suspend the last active Super Admin.
 * Returns { allowed: boolean, reason?: string }
 */
export async function validateSuperAdminLockout({ targetEmail, nextRole, nextAdminRole, nextStatus }) {
  const db = getDb();
  const normalizedEmail = targetEmail.toLowerCase();

  // Find target user
  const targetUser = await db.collection("user").findOne({
    email: new RegExp(`^${normalizedEmail}$`, "i"),
  });

  if (!targetUser) {
    return { allowed: true };
  }

  const isCurrentSuperAdmin =
    (targetUser.role || "").toLowerCase() === "admin" &&
    resolveAdminRole(targetUser) === ADMIN_ROLES.SUPER_ADMIN &&
    targetUser.status !== "suspended";

  // If target is not currently an active super_admin, no lockout risk
  if (!isCurrentSuperAdmin) {
    return { allowed: true };
  }

  // Check if proposed change would remove super_admin status
  const willLoseRole = nextRole !== undefined && nextRole.toLowerCase() !== "admin";
  const willLoseAdminRole =
    nextAdminRole !== undefined && nextAdminRole.toLowerCase() !== ADMIN_ROLES.SUPER_ADMIN;
  const willBeSuspended = nextStatus !== undefined && nextStatus.toLowerCase() === "suspended";

  if (!willLoseRole && !willLoseAdminRole && !willBeSuspended) {
    return { allowed: true };
  }

  // Count other active super admins
  const otherSuperAdminsCount = await db.collection("user").countDocuments({
    email: { $not: new RegExp(`^${normalizedEmail}$`, "i") },
    role: "admin",
    status: { $ne: "suspended" },
    $or: [{ adminRole: ADMIN_ROLES.SUPER_ADMIN }, { adminRole: { $exists: false } }, { adminRole: null }],
  });

  if (otherSuperAdminsCount < 1) {
    return {
      allowed: false,
      reason: "Cannot demote, reassign, or suspend the last active Super Administrator. Designate another Super Administrator before modifying this account.",
    };
  }

  return { allowed: true };
}

/**
 * Migration helper to ensure legacy admin users have a canonical adminRole.
 * Safe and idempotent to run on server startup.
 */
export async function migrateLegacyAdmins() {
  const db = getDb();
  const unmigratedAdmins = await db
    .collection("user")
    .find({
      role: "admin",
      $or: [{ adminRole: { $exists: false } }, { adminRole: null }, { adminRole: "" }],
    })
    .toArray();

  if (unmigratedAdmins.length === 0) {
    return { migratedCount: 0 };
  }

  let count = 0;
  for (const admin of unmigratedAdmins) {
    await db.collection("user").updateOne(
      { _id: admin._id },
      {
        $set: {
          adminRole: ADMIN_ROLES.SUPER_ADMIN,
          updatedAt: new Date(),
        },
      }
    );

    recordAuditLog({
      actor: { email: "system@hireloop.internal", role: "system" },
      action: "admin_role_migrated",
      targetType: "user",
      targetId: admin._id?.toString(),
      targetIdentifier: admin.email,
      before: { role: admin.role, adminRole: admin.adminRole || null },
      after: { role: "admin", adminRole: ADMIN_ROLES.SUPER_ADMIN },
      reason: "Automated backward-compatible migration of legacy admin account to super_admin.",
    });

    count++;
  }

  return { migratedCount: count };
}
