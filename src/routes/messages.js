/**
 * Messaging Route for HireLoop
 * Persistent, real-time messaging between recruiters and candidates on eligible job applications.
 *
 * CRITICAL INTEGRITY RULE: Candidate-visible messages and private recruiter screening notes
 * are completely decoupled. Private screening notes are NEVER exposed in any conversation,
 * message, notification payload, or SSE event.
 */

import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { sseHub } from "../services/sseHub.js";
import { createNotification } from "../services/notificationService.js";

const router = Router();

// Permitted recruitment statuses for messaging eligibility
export const ELIGIBLE_MESSAGING_STATUSES = [
  "Shortlisted",
  "Interview Scheduled",
  "Offered",
  "Accepted",
];

// Helper to normalize email for keys
function normalizeEmailKey(email = "") {
  return email.toLowerCase().trim().replace(/\./g, "_");
}

// Helper to sanitize plain text (strips HTML and trims to 2000 chars)
function sanitizeMessageBody(raw = "") {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, 2000);
}

// GET /api/messages/conversations - List conversations accessible to authenticated user
router.get("/conversations", requireAuth, asyncHandler(async (req, res) => {
  const userEmail = req.user.email.toLowerCase().trim();
  const userRole = (req.user.role || "").toLowerCase();
  const db = getDb();

  const filter = {};
  if (userRole === "recruiter") {
    filter.recruiterEmail = new RegExp(`^${userEmail}$`, "i");
  } else {
    filter.seekerEmail = new RegExp(`^${userEmail}$`, "i");
  }

  const conversations = await db
    .collection("conversations")
    .find(filter)
    .sort({ updatedAt: -1 })
    .toArray();

  // Enrich with application statuses and compute user-specific unread count
  const appIds = conversations.map((c) => toObjectId(c.applicationId)).filter(Boolean);
  const applications = await db
    .collection("applications")
    .find({ _id: { $in: appIds } })
    .project({ _id: 1, status: 1 })
    .toArray();

  const appStatusMap = new Map();
  applications.forEach((a) => {
    appStatusMap.set(a._id.toString(), a.status);
  });

  const emailKey = normalizeEmailKey(userEmail);

  const enriched = conversations.map((conv) => {
    const currentStatus = appStatusMap.get(conv.applicationId) || "Applied";
    const isClosed = currentStatus === "Rejected";
    const unreadCount = conv.unreadCounts?.[emailKey] || 0;

    return {
      _id: conv._id.toString(),
      applicationId: conv.applicationId,
      jobId: conv.jobId,
      jobTitle: conv.jobTitle,
      companyName: conv.companyName,
      recruiterEmail: conv.recruiterEmail,
      recruiterName: conv.recruiterName || "Recruiter",
      seekerEmail: conv.seekerEmail,
      seekerName: conv.seekerName || "Candidate",
      lastMessage: conv.lastMessage || null,
      unreadCount,
      applicationStatus: currentStatus,
      isMessagingClosed: isClosed,
      updatedAt: conv.updatedAt || conv.createdAt,
    };
  });

  res.json(enriched);
}));

// GET /api/messages/unread-count - Total unread message badge count
router.get("/unread-count", requireAuth, asyncHandler(async (req, res) => {
  const userEmail = req.user.email.toLowerCase().trim();
  const userRole = (req.user.role || "").toLowerCase();
  const db = getDb();

  const filter = userRole === "recruiter"
    ? { recruiterEmail: new RegExp(`^${userEmail}$`, "i") }
    : { seekerEmail: new RegExp(`^${userEmail}$`, "i") };

  const conversations = await db.collection("conversations").find(filter).toArray();
  const emailKey = normalizeEmailKey(userEmail);

  const totalUnread = conversations.reduce((acc, conv) => {
    return acc + (conv.unreadCounts?.[emailKey] || 0);
  }, 0);

  res.json({ unreadCount: totalUnread });
}));

// POST /api/messages/conversations - Initiate or find conversation for an application
router.post("/conversations", requireAuth, asyncHandler(async (req, res) => {
  const { applicationId } = req.body;
  if (!applicationId) return badRequest(res, "applicationId is required.");

  const appObjectId = toObjectId(applicationId);
  if (!appObjectId) return badRequest(res, "Invalid applicationId identifier.");

  const db = getDb();
  const application = await db.collection("applications").findOne({ _id: appObjectId });
  if (!application) return notFound(res, "Job application not found.");

  const userEmail = req.user.email.toLowerCase().trim();
  const userRole = (req.user.role || "").toLowerCase();

  const isRecruiterOwner = application.recruiterEmail?.toLowerCase() === userEmail;
  const isSeekerOwner = application.seekerEmail?.toLowerCase() === userEmail;

  if (!isRecruiterOwner && !isSeekerOwner) {
    return res.status(403).json({
      message: "Forbidden: You are not authorized to access conversations for this application.",
    });
  }

  // Check application status eligibility
  const currentStatus = application.status || "Applied";

  if (currentStatus === "Rejected") {
    // If conversation already exists, return it as read-only. Otherwise reject new conversation.
    const existing = await db.collection("conversations").findOne({ applicationId: application._id.toString() });
    if (existing) {
      return res.json({ conversation: existing, isMessagingClosed: true });
    }
    return res.status(400).json({
      message: "Cannot initiate new conversation because this job application has been rejected.",
    });
  }

  // Initial workflow: candidate must be Shortlisted or in interview stages
  const isEligible = ELIGIBLE_MESSAGING_STATUSES.includes(currentStatus);
  if (!isEligible) {
    return res.status(400).json({
      message: `Messaging is not yet active for this candidate. Application status is currently "${currentStatus}". Candidate must be Shortlisted or in interview stages before direct chat can begin.`,
    });
  }

  // Check for existing conversation (strictly 1 conversation per application)
  const existingConv = await db.collection("conversations").findOne({
    applicationId: application._id.toString(),
  });

  if (existingConv) {
    return res.json({ conversation: existingConv, isNew: false, isMessagingClosed: false });
  }

  // Create new conversation
  const newConv = {
    applicationId: application._id.toString(),
    jobId: application.jobId,
    jobTitle: application.jobTitle,
    companyName: application.companyName,
    recruiterEmail: (application.recruiterEmail || "").toLowerCase(),
    recruiterName: isRecruiterOwner ? (req.user.name || "Recruiter") : "Recruiter",
    seekerEmail: (application.seekerEmail || "").toLowerCase(),
    seekerName: application.seekerName || "Candidate",
    lastMessage: null,
    unreadCounts: {
      [normalizeEmailKey(application.recruiterEmail)]: 0,
      [normalizeEmailKey(application.seekerEmail)]: 0,
    },
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection("conversations").insertOne(newConv);
  created(res, { conversation: { ...newConv, _id: result.insertedId }, isNew: true, isMessagingClosed: false });
}));

// GET /api/messages/conversations/:id - Retrieve specific conversation
router.get("/conversations/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid conversation id");

  const db = getDb();
  const conv = await db.collection("conversations").findOne({ _id });
  if (!conv) return notFound(res, "Conversation not found");

  const userEmail = req.user.email.toLowerCase().trim();
  const isParticipant =
    conv.recruiterEmail?.toLowerCase() === userEmail ||
    conv.seekerEmail?.toLowerCase() === userEmail;

  if (!isParticipant) {
    return res.status(403).json({
      message: "Forbidden: You are not a participant in this conversation.",
    });
  }

  // Lookup application status
  const appObjectId = toObjectId(conv.applicationId);
  const application = appObjectId
    ? await db.collection("applications").findOne({ _id: appObjectId })
    : null;

  const currentStatus = application?.status || "Applied";
  const isClosed = currentStatus === "Rejected";

  res.json({
    ...conv,
    applicationStatus: currentStatus,
    isMessagingClosed: isClosed,
  });
}));

// GET /api/messages/conversations/:id/messages - Retrieve paginated chronological message history
router.get("/conversations/:id/messages", requireAuth, asyncHandler(async (req, res) => {
  const convId = req.params.id;
  const _id = toObjectId(convId);
  if (!_id) return badRequest(res, "Invalid conversation id");

  const db = getDb();
  const conv = await db.collection("conversations").findOne({ _id });
  if (!conv) return notFound(res, "Conversation not found");

  const userEmail = req.user.email.toLowerCase().trim();
  const isParticipant =
    conv.recruiterEmail?.toLowerCase() === userEmail ||
    conv.seekerEmail?.toLowerCase() === userEmail;

  if (!isParticipant) {
    return res.status(403).json({
      message: "Forbidden: You are not authorized to view messages in this conversation.",
    });
  }

  const { limit = 50, page = 1 } = req.query;
  const pageLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const pageNum = Math.max(1, Number(page) || 1);
  const skip = (pageNum - 1) * pageLimit;

  const [messages, total] = await Promise.all([
    db.collection("messages")
      .find({ conversationId: convId })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(pageLimit)
      .toArray(),
    db.collection("messages").countDocuments({ conversationId: convId }),
  ]);

  res.json({
    messages,
    total,
    page: pageNum,
    limit: pageLimit,
    hasMore: skip + messages.length < total,
  });
}));

// POST /api/messages/conversations/:id/messages - Send message in conversation
router.post("/conversations/:id/messages", requireAuth, asyncHandler(async (req, res) => {
  const convId = req.params.id;
  const _id = toObjectId(convId);
  if (!_id) return badRequest(res, "Invalid conversation id");

  const { text, idempotencyKey } = req.body;
  const sanitizedText = sanitizeMessageBody(text);

  if (!sanitizedText) {
    return badRequest(res, "Message body cannot be empty or whitespace only.");
  }

  const db = getDb();
  const conv = await db.collection("conversations").findOne({ _id });
  if (!conv) return notFound(res, "Conversation not found");

  const userEmail = req.user.email.toLowerCase().trim();
  const userRole = (req.user.role || "").toLowerCase();
  const isRecruiter = conv.recruiterEmail?.toLowerCase() === userEmail;
  const isSeeker = conv.seekerEmail?.toLowerCase() === userEmail;

  if (!isRecruiter && !isSeeker) {
    return res.status(403).json({
      message: "Forbidden: You are not an authorized participant in this conversation.",
    });
  }

  // Check application status eligibility
  const appObjectId = toObjectId(conv.applicationId);
  const application = appObjectId
    ? await db.collection("applications").findOne({ _id: appObjectId })
    : null;

  if (application && application.status === "Rejected") {
    return res.status(400).json({
      message: "Messaging is closed for this application because the hiring process has finalized as Rejected.",
    });
  }

  // Idempotency check to prevent duplicate message sends on network retries
  if (idempotencyKey) {
    const existingMsg = await db.collection("messages").findOne({
      conversationId: convId,
      idempotencyKey,
    });
    if (existingMsg) {
      return res.json(existingMsg);
    }
  }

  // Recipient details
  const recipientEmail = isRecruiter ? conv.seekerEmail : conv.recruiterEmail;
  const recipientRole = isRecruiter ? "seeker" : "recruiter";
  const recipientKey = normalizeEmailKey(recipientEmail);
  const senderRole = isRecruiter ? "recruiter" : "seeker";
  const senderName = req.user.name || (isRecruiter ? "Recruiter" : "Candidate");

  // 1. Persist message durably in MongoDB
  const messageDoc = {
    conversationId: convId,
    applicationId: conv.applicationId,
    senderEmail: userEmail,
    senderName,
    senderRole,
    body: sanitizedText,
    createdAt: new Date(),
    readAt: null,
    idempotencyKey: idempotencyKey || null,
  };

  const insertResult = await db.collection("messages").insertOne(messageDoc);
  const savedMessage = { ...messageDoc, _id: insertResult.insertedId };

  // 2. Update conversation latest message metadata and increment recipient's unread count
  await db.collection("conversations").updateOne(
    { _id },
    {
      $set: {
        lastMessage: {
          text: sanitizedText.slice(0, 150),
          senderEmail: userEmail,
          senderRole,
          sentAt: new Date(),
        },
        updatedAt: new Date(),
      },
      $inc: {
        [`unreadCounts.${recipientKey}`]: 1,
      },
    }
  );

  // 3. Emit real-time message event to recipient via SSE (isolated to recipient channel)
  sseHub.sendToUser(recipientEmail, {
    type: "new_message",
    conversationId: convId,
    message: savedMessage,
  }, "message");

  // 4. Trigger in-app notification & transactional email to recipient
  createNotification({
    recipientEmail,
    role: recipientRole,
    type: "new_message",
    title: `New message from ${senderName}`,
    message: sanitizedText.slice(0, 80) + (sanitizedText.length > 80 ? "..." : ""),
    link: `/dashboard/${recipientRole}/messages?conversationId=${convId}`,
    referenceId: convId,
    referenceType: "conversation",
    idempotencyKey: `msg_notif_${savedMessage._id}`,
    sendEmail: true,
    emailTemplate: "newMessageReceived",
    emailData: {
      senderName,
      jobTitle: conv.jobTitle,
      companyName: conv.companyName,
      previewText: sanitizedText.slice(0, 120),
      viewUrl: `/dashboard/${recipientRole}/messages?conversationId=${convId}`,
    },
  }).catch((err) => {
    console.error("[Messaging] Notification error:", err.message);
  });

  created(res, savedMessage);
}));

// POST /api/messages/conversations/:id/read - Mark messages as read by recipient
router.post("/conversations/:id/read", requireAuth, asyncHandler(async (req, res) => {
  const convId = req.params.id;
  const _id = toObjectId(convId);
  if (!_id) return badRequest(res, "Invalid conversation id");

  const db = getDb();
  const conv = await db.collection("conversations").findOne({ _id });
  if (!conv) return notFound(res, "Conversation not found");

  const userEmail = req.user.email.toLowerCase().trim();
  const isParticipant =
    conv.recruiterEmail?.toLowerCase() === userEmail ||
    conv.seekerEmail?.toLowerCase() === userEmail;

  if (!isParticipant) {
    return res.status(403).json({
      message: "Forbidden: You are not authorized to modify read state in this conversation.",
    });
  }

  // Update messages sent by the other participant where readAt is null
  const updateResult = await db.collection("messages").updateMany(
    {
      conversationId: convId,
      senderEmail: { $ne: userEmail },
      readAt: null,
    },
    {
      $set: { readAt: new Date() },
    }
  );

  // Reset current user's unread count on conversation
  const emailKey = normalizeEmailKey(userEmail);
  await db.collection("conversations").updateOne(
    { _id },
    {
      $set: {
        [`unreadCounts.${emailKey}`]: 0,
      },
    }
  );

  res.json({
    conversationId: convId,
    markedReadCount: updateResult.modifiedCount,
  });
}));

export default router;
