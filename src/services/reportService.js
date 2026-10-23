/**
 * Report & Moderation Service for HireLoop
 * Handles user-submitted violation reports, validation of reported entities,
 * contextual access boundaries, and administrator moderation workflows.
 */

import { getDb, toObjectId } from "../db.js";
import { recordAuditLog } from "./auditService.js";
import { createNotification } from "./notificationService.js";

export const SUPPORTED_TARGET_TYPES = ["job", "company", "user", "message"];

export const SUPPORTED_CATEGORIES = [
  "fraudulent_job",
  "company_impersonation",
  "abusive_behavior",
  "inappropriate_message",
  "policy_violation",
  "other",
];

export const REPORT_STATUSES = ["pending", "in_review", "resolved", "dismissed"];

export const MODERATION_ACTIONS = [
  "suspend_user",
  "close_job",
  "reject_company",
  "warn_user",
  "dismiss_report",
];

/**
 * Validates and creates a user-submitted report.
 */
export async function createReport({
  reporterEmail,
  targetType,
  targetId,
  category,
  reason,
}) {
  if (!reporterEmail) throw new Error("Authenticated reporter email is required.");
  const normalizedReporter = reporterEmail.toLowerCase().trim();

  if (!SUPPORTED_TARGET_TYPES.includes(targetType)) {
    throw new Error(`Invalid targetType. Supported types: ${SUPPORTED_TARGET_TYPES.join(", ")}`);
  }

  if (!SUPPORTED_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category. Supported categories: ${SUPPORTED_CATEGORIES.join(", ")}`);
  }

  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("A description of the violation is required.");
  }

  if (reason.trim().length > 1000) {
    throw new Error("Description exceeds maximum length of 1000 characters.");
  }

  const db = getDb();
  let targetIdentifier = "";
  let reportedUserEmail = null;

  // Validate referenced entity existence and ownership boundaries
  if (targetType === "job") {
    const jobObjectId = toObjectId(targetId);
    if (!jobObjectId) throw new Error("Invalid job ID format.");
    const job = await db.collection("jobs").findOne({ _id: jobObjectId });
    if (!job) throw new Error("Referenced job listing does not exist.");
    targetIdentifier = `${job.title} at ${job.companyName}`;
    reportedUserEmail = job.recruiterEmail;
  } else if (targetType === "company") {
    const companyObjectId = toObjectId(targetId);
    if (!companyObjectId) throw new Error("Invalid company ID format.");
    const company = await db.collection("companies").findOne({ _id: companyObjectId });
    if (!company) throw new Error("Referenced company does not exist.");
    targetIdentifier = company.name;
    reportedUserEmail = company.recruiterEmail;
  } else if (targetType === "user") {
    const user = await db.collection("user").findOne({
      $or: [
        { email: targetId.toLowerCase().trim() },
        ...(toObjectId(targetId) ? [{ _id: toObjectId(targetId) }] : []),
      ],
    });
    if (!user) throw new Error("Referenced user account does not exist.");
    if (user.email.toLowerCase() === normalizedReporter) {
      throw new Error("You cannot submit a report against yourself.");
    }
    targetIdentifier = user.name ? `${user.name} (${user.email})` : user.email;
    reportedUserEmail = user.email;
  } else if (targetType === "message") {
    const messageObjectId = toObjectId(targetId);
    if (!messageObjectId) throw new Error("Invalid message ID format.");
    const message = await db.collection("messages").findOne({ _id: messageObjectId });
    if (!message) throw new Error("Referenced message does not exist.");

    // Verification of participant privacy boundary:
    // Reporter MUST be a legitimate participant in the conversation!
    const conversationObjectId = toObjectId(message.conversationId);
    const conv = conversationObjectId
      ? await db.collection("conversations").findOne({ _id: conversationObjectId })
      : null;

    if (!conv) throw new Error("Parent conversation does not exist.");

    const isRecruiter = conv.recruiterEmail?.toLowerCase() === normalizedReporter;
    const isSeeker = conv.seekerEmail?.toLowerCase() === normalizedReporter;

    if (!isRecruiter && !isSeeker) {
      throw new Error("Forbidden: You cannot report private messages from a conversation you are not a party to.");
    }

    targetIdentifier = `Message in conversation regarding ${conv.jobTitle || "application"}`;
    reportedUserEmail = message.senderEmail;
  }

  // Deduplication / rate-limiting check:
  // Disallow duplicate pending/in_review reports by the same user for the same entity within 24 hours
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const existingReport = await db.collection("reports").findOne({
    reporterEmail: normalizedReporter,
    targetType,
    targetId: targetId.toString(),
    status: { $in: ["pending", "in_review"] },
    createdAt: { $gte: twentyFourHoursAgo },
  });

  if (existingReport) {
    throw new Error("You have already submitted a pending report for this item. Our moderation team is currently reviewing it.");
  }

  const reportDoc = {
    reporterEmail: normalizedReporter,
    targetType,
    targetId: targetId.toString(),
    targetIdentifier,
    reportedUserEmail: reportedUserEmail ? reportedUserEmail.toLowerCase().trim() : null,
    category,
    reason: reason.trim(),
    status: "pending", // "pending" | "in_review" | "resolved" | "dismissed"
    assignedAdminEmail: null,
    decision: null,
    resolutionNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    resolvedAt: null,
    resolvedBy: null,
  };

  const insertResult = await db.collection("reports").insertOne(reportDoc);
  return { ...reportDoc, _id: insertResult.insertedId };
}

/**
 * Lists reports with server-side pagination, sorting, and filters. Admin-only.
 */
export async function listReports({
  page = 1,
  limit = 20,
  status,
  category,
  targetType,
  startDate,
  endDate,
  q,
} = {}) {
  const db = getDb();
  const pageNum = Math.max(1, Number(page) || 1);
  const pageLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * pageLimit;

  const filter = {};

  if (status && status !== "all") {
    filter.status = status;
  }

  if (category && category !== "all") {
    filter.category = category;
  }

  if (targetType && targetType !== "all") {
    filter.targetType = targetType;
  }

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) {
      filter.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = end;
    }
  }

  if (q) {
    const searchRegex = new RegExp(q.trim(), "i");
    filter.$or = [
      { targetIdentifier: searchRegex },
      { reporterEmail: searchRegex },
      { reportedUserEmail: searchRegex },
      { targetId: searchRegex },
      { reason: searchRegex },
    ];
  }

  const [reports, total] = await Promise.all([
    db.collection("reports")
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageLimit)
      .toArray(),
    db.collection("reports").countDocuments(filter),
  ]);

  return {
    reports,
    total,
    page: pageNum,
    limit: pageLimit,
    totalPages: Math.ceil(total / pageLimit) || 1,
  };
}

/**
 * Retrieves a single report with relevant context for authorized admin inspection.
 */
export async function getReportDetails(reportId, actingAdmin) {
  const db = getDb();
  const _id = toObjectId(reportId);
  if (!_id) return null;

  const report = await db.collection("reports").findOne({ _id });
  if (!report) return null;

  // Retrieve minimal relevant context based on targetType
  let contextData = null;
  if (report.targetType === "job") {
    const jobObjectId = toObjectId(report.targetId);
    contextData = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;
  } else if (report.targetType === "company") {
    const companyObjectId = toObjectId(report.targetId);
    contextData = companyObjectId ? await db.collection("companies").findOne({ _id: companyObjectId }) : null;
  } else if (report.targetType === "user") {
    contextData = await db.collection("user").findOne(
      { email: report.reportedUserEmail || report.targetId },
      { projection: { password: 0 } }
    );
  } else if (report.targetType === "message") {
    // Auditable restricted message view
    const messageObjectId = toObjectId(report.targetId);
    const targetMsg = messageObjectId ? await db.collection("messages").findOne({ _id: messageObjectId }) : null;
    if (targetMsg) {
      // Find conversation for metadata without exposing recruiter screening notes
      const conv = await db.collection("conversations").findOne(
        { _id: toObjectId(targetMsg.conversationId) },
        { projection: { notesHistory: 0 } }
      );
      contextData = {
        message: targetMsg,
        conversation: conv,
      };

      // Record audit entry for administrative inspection of reported message content
      if (actingAdmin) {
        await recordAuditLog({
          actor: actingAdmin,
          action: "reported_content_viewed",
          targetType: "message",
          targetId: report.targetId,
          targetIdentifier: `Report ${report._id.toString()}`,
          outcome: "success",
        });
      }
    }
  }

  return {
    report,
    contextData,
  };
}

/**
 * Updates report status (claim, in_review, etc.)
 */
export async function updateReportStatus(reportId, actingAdmin, { status, assignedAdminEmail, resolutionNotes }) {
  const db = getDb();
  const _id = toObjectId(reportId);
  if (!_id) throw new Error("Invalid report ID.");

  const existingReport = await db.collection("reports").findOne({ _id });
  if (!existingReport) throw new Error("Report not found.");

  if (status && !REPORT_STATUSES.includes(status)) {
    throw new Error(`Invalid report status. Allowed: ${REPORT_STATUSES.join(", ")}`);
  }

  const updateFields = {
    updatedAt: new Date(),
  };

  if (status) updateFields.status = status;
  if (assignedAdminEmail !== undefined) updateFields.assignedAdminEmail = assignedAdminEmail;
  if (resolutionNotes !== undefined) updateFields.resolutionNotes = resolutionNotes;

  const result = await db.collection("reports").findOneAndUpdate(
    { _id },
    { $set: updateFields },
    { returnDocument: "after" }
  );

  await recordAuditLog({
    actor: actingAdmin,
    action: "report_status_changed",
    targetType: "report",
    targetId: existingReport._id.toString(),
    targetIdentifier: existingReport.targetIdentifier,
    before: { status: existingReport.status, assignedAdminEmail: existingReport.assignedAdminEmail },
    after: { status: result.status, assignedAdminEmail: result.assignedAdminEmail },
  });

  return result;
}

/**
 * Executes a definitive moderation action on a report and its target entity.
 */
export async function executeModerationAction(reportId, actingAdmin, { actionType, resolutionNotes }) {
  const db = getDb();
  const _id = toObjectId(reportId);
  if (!_id) throw new Error("Invalid report ID.");

  const report = await db.collection("reports").findOne({ _id });
  if (!report) throw new Error("Report not found.");

  if (!MODERATION_ACTIONS.includes(actionType)) {
    throw new Error(`Invalid actionType. Allowed: ${MODERATION_ACTIONS.join(", ")}`);
  }

  if (!resolutionNotes || resolutionNotes.trim().length === 0) {
    throw new Error("Resolution notes explaining the moderation decision are required.");
  }

  const now = new Date();
  let actionOutcome = { targetModified: false, action: actionType };

  // 1. Execute action on underlying target entity
  if (actionType === "suspend_user") {
    const userEmail = report.reportedUserEmail || (report.targetType === "user" ? report.targetId : null);
    if (!userEmail) throw new Error("Cannot identify user to suspend from report.");

    const user = await db.collection("user").findOneAndUpdate(
      { email: userEmail.toLowerCase().trim() },
      { $set: { status: "suspended", updatedAt: now } },
      { returnDocument: "after" }
    );

    if (user) {
      actionOutcome.targetModified = true;
      await recordAuditLog({
        actor: actingAdmin,
        action: "user_status_changed",
        targetType: "user",
        targetId: user._id?.toString(),
        targetIdentifier: user.email,
        before: { status: "active" },
        after: { status: "suspended" },
        metadata: { reportId: report._id.toString(), reason: resolutionNotes },
      });
    }
  } else if (actionType === "close_job") {
    const jobObjectId = toObjectId(report.targetId);
    if (!jobObjectId) throw new Error("Invalid job ID.");

    const job = await db.collection("jobs").findOneAndUpdate(
      { _id: jobObjectId },
      { $set: { status: "closed", updatedAt: now } },
      { returnDocument: "after" }
    );

    if (job) {
      actionOutcome.targetModified = true;
      await recordAuditLog({
        actor: actingAdmin,
        action: "job_moderated",
        targetType: "job",
        targetId: job._id.toString(),
        targetIdentifier: job.title,
        before: { status: "active" },
        after: { status: "closed" },
        metadata: { reportId: report._id.toString(), reason: resolutionNotes },
      });
    }
  } else if (actionType === "reject_company") {
    const companyObjectId = toObjectId(report.targetId);
    if (!companyObjectId) throw new Error("Invalid company ID.");

    const company = await db.collection("companies").findOneAndUpdate(
      { _id: companyObjectId },
      { $set: { status: "rejected", updatedAt: now } },
      { returnDocument: "after" }
    );

    if (company) {
      actionOutcome.targetModified = true;
      await recordAuditLog({
        actor: actingAdmin,
        action: "company_moderated",
        targetType: "company",
        targetId: company._id.toString(),
        targetIdentifier: company.name,
        before: { status: "approved" },
        after: { status: "rejected" },
        metadata: { reportId: report._id.toString(), reason: resolutionNotes },
      });
    }
  } else if (actionType === "warn_user") {
    const userEmail = report.reportedUserEmail || (report.targetType === "user" ? report.targetId : null);
    if (userEmail) {
      await createNotification({
        recipientEmail: userEmail,
        role: "seeker",
        type: "platform_warning",
        title: "Platform Policy Reminder",
        message: `A recent activity on your account was flagged for policy review. Reason: ${resolutionNotes}`,
        link: "/dashboard",
        sendEmail: false,
      });
      actionOutcome.targetModified = true;
    }
  }

  // 2. Mark report status as resolved or dismissed
  const finalStatus = actionType === "dismiss_report" ? "dismissed" : "resolved";

  const updatedReport = await db.collection("reports").findOneAndUpdate(
    { _id },
    {
      $set: {
        status: finalStatus,
        decision: actionType,
        resolutionNotes: resolutionNotes.trim(),
        resolvedAt: now,
        resolvedBy: actingAdmin.email,
        updatedAt: now,
      },
    },
    { returnDocument: "after" }
  );

  // 3. Record overall moderation decision audit event
  await recordAuditLog({
    actor: actingAdmin,
    action: "moderation_action_executed",
    targetType: "report",
    targetId: report._id.toString(),
    targetIdentifier: report.targetIdentifier,
    before: { status: report.status },
    after: { status: finalStatus, decision: actionType },
    metadata: {
      resolutionNotes: resolutionNotes.trim(),
      targetType: report.targetType,
      targetId: report.targetId,
      actionOutcome,
    },
  });

  return {
    success: true,
    report: updatedReport,
    actionOutcome,
  };
}
