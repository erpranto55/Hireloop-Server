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
  "unsubscribeToken",
  "tokenHash",
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

/**
 * Safely escapes a string value for CSV output with formula injection mitigation.
 * If a value starts with =, +, -, @, \t, or \r, prepend a single quote (').
 */
export function sanitizeCsvCell(value) {
  if (value === null || value === undefined) return "";
  let str = typeof value === "object" ? JSON.stringify(value) : String(value);

  // Formula injection prevention (OWASP CSV Injection guidelines)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  // Wrap in double quotes and escape internal quotes if special chars exist
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Exports audit logs bounded to maxRecords (default 5000) in CSV or JSON.
 */
export async function exportAuditLogs({
  format = "csv",
  action,
  targetType,
  actorEmail,
  startDate,
  endDate,
  q,
  maxRecords = 5000,
} = {}) {
  const db = getDb();
  const filter = {};

  if (action && action !== "all") filter.action = action;
  if (targetType && targetType !== "all") filter.targetType = targetType;
  if (actorEmail) filter.actorEmail = new RegExp(`^${actorEmail.trim()}$`, "i");

  if (startDate || endDate) {
    filter.timestamp = {};
    if (startDate) filter.timestamp.$gte = new Date(startDate);
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

  const logs = await db.collection("audit_logs")
    .find(filter)
    .sort({ timestamp: -1 })
    .limit(Math.min(maxRecords, 5000))
    .toArray();

  if (format === "json") {
    return {
      contentType: "application/json",
      filename: `audit-logs-${Date.now()}.json`,
      data: JSON.stringify(logs, null, 2),
      count: logs.length,
    };
  }

  // CSV Generation
  const headers = [
    "Timestamp",
    "Actor Email",
    "Actor Role",
    "Action",
    "Target Type",
    "Target ID",
    "Target Identifier",
    "Outcome",
    "Before",
    "After",
    "Metadata",
  ];

  const rows = [headers.join(",")];

  for (const log of logs) {
    const row = [
      sanitizeCsvCell(log.timestamp ? new Date(log.timestamp).toISOString() : ""),
      sanitizeCsvCell(log.actorEmail || ""),
      sanitizeCsvCell(log.actorRole || ""),
      sanitizeCsvCell(log.action || ""),
      sanitizeCsvCell(log.targetType || ""),
      sanitizeCsvCell(log.targetId || ""),
      sanitizeCsvCell(log.targetIdentifier || ""),
      sanitizeCsvCell(log.outcome || "success"),
      sanitizeCsvCell(log.before || ""),
      sanitizeCsvCell(log.after || ""),
      sanitizeCsvCell(log.metadata || ""),
    ];
    rows.push(row.join(","));
  }

  return {
    contentType: "text/csv; charset=utf-8",
    filename: `audit-logs-${Date.now()}.csv`,
    data: rows.join("\r\n"),
    count: logs.length,
  };
}
