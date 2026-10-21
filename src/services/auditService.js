/**
 * Audit Service for HireLoop
 * Maintains an append-only, tamper-resistant record of sensitive administrative,
 * moderation, and billing operations.
 */

import { getDb } from "../db.js";

// Fields strictly excluded from audit snapshots to prevent sensitive leaks
const SENSITIVE_FIELDS = new Set([
  "password",
  "token",
  "sessionToken",
  "stripeSecretKey",
  "secret",
  "creditCard",
  "cardNumber",
  "cvv",
  "notesHistory",
]);

/**
 * Sanitizes object data, stripping sensitive fields and keeping only relevant modified values.
 */
export function sanitizeAuditData(data) {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(sanitizeAuditData);

  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_FIELDS.has(key)) continue;
    if (value && typeof value === "object" && !(value instanceof Date)) {
      clean[key] = sanitizeAuditData(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Records an immutable audit log entry.
 */
export async function recordAuditLog({
  actor,
  action,
  targetType,
  targetId = "",
  targetIdentifier = "",
  before = null,
  after = null,
  outcome = "success",
  metadata = {},
}) {
  try {
    const db = getDb();
    const actorEmail = actor?.email ? actor.email.toLowerCase().trim() : "system";
    const actorId = actor?._id?.toString() || actor?.id || "system";
    const actorRole = (actor?.role || "admin").toLowerCase();

    const auditEntry = {
      timestamp: new Date(),
      actorId,
      actorEmail,
      actorRole,
      action,
      targetType,
      targetId: targetId ? targetId.toString() : "",
      targetIdentifier: targetIdentifier || "",
      before: sanitizeAuditData(before),
      after: sanitizeAuditData(after),
      outcome,
      metadata: sanitizeAuditData(metadata),
    };

    const result = await db.collection("audit_logs").insertOne(auditEntry);
    return { ...auditEntry, _id: result.insertedId };
  } catch (err) {
    // Audit logging should not crash the primary operational transaction, but must be logged
    console.error("[AuditService] Failed to record audit log:", err.message);
    return null;
  }
}

/**
 * Queries audit logs with pagination and filters. Admin-only.
 */
export async function listAuditLogs({
  page = 1,
  limit = 20,
  action,
  targetType,
  actorEmail,
  startDate,
  endDate,
  q,
} = {}) {
  const db = getDb();
  const pageNum = Math.max(1, Number(page) || 1);
  const pageLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * pageLimit;

  const filter = {};

  if (action && action !== "all") {
    filter.action = action;
  }

  if (targetType && targetType !== "all") {
    filter.targetType = targetType;
  }

  if (actorEmail) {
    filter.actorEmail = new RegExp(`^${actorEmail.trim()}$`, "i");
  }

  if (startDate || endDate) {
    filter.timestamp = {};
    if (startDate) {
      filter.timestamp.$gte = new Date(startDate);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.timestamp.$lte = end;
    }
  }

  if (q) {
    const searchRegex = new RegExp(q.trim(), "i");
    filter.$or = [
      { targetIdentifier: searchRegex },
      { actorEmail: searchRegex },
      { targetId: searchRegex },
      { action: searchRegex },
    ];
  }

  const [logs, total] = await Promise.all([
    db.collection("audit_logs")
      .find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(pageLimit)
      .toArray(),
    db.collection("audit_logs").countDocuments(filter),
  ]);

  return {
    logs,
    total,
    page: pageNum,
    limit: pageLimit,
    totalPages: Math.ceil(total / pageLimit) || 1,
  };
}
