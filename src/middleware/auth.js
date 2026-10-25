import { getDb, toObjectId } from "../db.js";
import { recordUserActivity } from "../services/presenceService.js";

/**
 * Extracts session token from either Authorization header or Cookie header.
 */
export function extractSessionToken(req) {
  // 1. Check Authorization: Bearer <token>
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader && typeof authHeader === "string") {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      return parts[1].trim();
    }
  }

  // 2. Check Cookies (better-auth.session_token or __Secure-better-auth.session_token)
  const cookieHeader = req.headers.cookie;
  if (cookieHeader && typeof cookieHeader === "string") {
    const match = cookieHeader.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/);
    if (match) {
      const rawValue = decodeURIComponent(match[1]);
      // Handle signed cookie: <token>.<signature>
      const lastDot = rawValue.lastIndexOf(".");
      return lastDot > 0 ? rawValue.substring(0, lastDot) : rawValue;
    }
  }

  return null;
}

import { resolveAdminRole, getEffectivePermissions, requirePermission } from "../services/permissionService.js";

/**
 * Sanitizes user document to prevent exposing sensitive fields.
 */
export function sanitizeUser(user) {
  if (!user) return null;
  const { password, ...sanitized } = user;
  if ((user.role || "").toLowerCase() === "admin") {
    sanitized.adminRole = resolveAdminRole(user);
    sanitized.permissions = getEffectivePermissions(user);
  }
  return sanitized;
}

/**
 * Authenticates user session against MongoDB session collection.
 * Attaches req.user and req.session if valid.
 */
export async function authenticate(req) {
  const token = extractSessionToken(req);
  if (!token) return null;

  const db = getDb();
  const session = await db.collection("session").findOne({
    token,
    expiresAt: { $gt: new Date() },
  });

  if (!session) return null;

  // Find user by userId (handling both ObjectId and string representation)
  const userQuery = toObjectId(session.userId)
    ? { $or: [{ _id: toObjectId(session.userId) }, { _id: session.userId }] }
    : { _id: session.userId };

  const user = await db.collection("user").findOne(userQuery);
  if (!user) return null;

  return { user: sanitizeUser(user), session };
}

/**
 * Express middleware requiring a valid authenticated session.
 */
export async function requireAuth(req, res, next) {
  try {
    const authData = await authenticate(req);
    if (!authData) {
      return res.status(401).json({
        message: "Authentication required. Please sign in to access this resource.",
      });
    }

    if (authData.user.status === "suspended") {
      return res.status(403).json({
        message: "Forbidden: Your account has been suspended. Please contact support.",
      });
    }

    req.user = authData.user;
    req.session = authData.session;

    // Track user authenticated activity (throttled)
    if (authData.user?.email) {
      recordUserActivity(authData.user.email);
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Optional authentication middleware: populates req.user if session exists,
 * but allows unauthenticated requests to proceed.
 */
export async function optionalAuth(req, res, next) {
  try {
    const authData = await authenticate(req);
    if (authData) {
      req.user = authData.user;
      req.session = authData.session;
    } else {
      req.user = null;
      req.session = null;
    }
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Express middleware enforcing role-based authorization.
 * Usage: requireRole("admin") or requireRole("recruiter", "admin")
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        message: "Authentication required.",
      });
    }

    const userRole = (req.user.role || "seeker").toLowerCase();
    const hasRole = allowedRoles.some((r) => r.toLowerCase() === userRole);

    if (!hasRole) {
      return res.status(403).json({
        message: `Forbidden: Access requires one of the following roles: [${allowedRoles.join(", ")}]. Current role: ${userRole}`,
      });
    }

    next();
  };
}

export { requirePermission };
