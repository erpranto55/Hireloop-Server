/**
 * Notification Service for HireLoop
 * Handles in-app notification persistence, real-time SSE distribution,
 * and reliable transactional email triggering.
 */

import { getDb, toObjectId } from "../db.js";
import { sseHub } from "./sseHub.js";
import { queueTransactionalEmail } from "./emailService.js";

/**
 * Creates and delivers an in-app notification with deduplication and real-time push.
 */
export async function createNotification({
  recipientEmail,
  role = "seeker",
  type,
  title,
  message,
  link = "",
  referenceId = "",
  referenceType = "",
  idempotencyKey = null,
  sendEmail = true,
  emailTemplate = null,
  emailData = null,
}) {
  if (!recipientEmail) return null;
  const normalizedEmail = recipientEmail.toLowerCase().trim();
  const db = getDb();

  // Deduplication check via idempotency key
  if (idempotencyKey) {
    const existing = await db.collection("notifications").findOne({
      recipientEmail: normalizedEmail,
      idempotencyKey,
    });
    if (existing) {
      return existing;
    }
  }

  const notificationDoc = {
    recipientEmail: normalizedEmail,
    role,
    type, // e.g. "application_received", "application_status_changed", "subscription_activated"
    title,
    message,
    link,
    referenceId,
    referenceType,
    idempotencyKey: idempotencyKey || null,
    read: false,
    readAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const result = await db.collection("notifications").insertOne(notificationDoc);
    notificationDoc._id = result.insertedId;
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate idempotencyKey conflict
      return await db.collection("notifications").findOne({
        recipientEmail: normalizedEmail,
        idempotencyKey,
      });
    }
    throw err;
  }

  // Real-time broadcast to active browser sessions
  sseHub.sendToUser(normalizedEmail, notificationDoc);

  // Queue transactional email alert if requested
  if (sendEmail && emailTemplate && emailData) {
    try {
      await queueTransactionalEmail({
        to: normalizedEmail,
        type: emailTemplate,
        templateData: emailData,
        idempotencyKey: idempotencyKey ? `email_${idempotencyKey}` : null,
      });
    } catch (emailErr) {
      // Notification created successfully; email failure must not roll back notification or core flow
      console.error(`[NotificationService] Email queueing failed for ${normalizedEmail}:`, emailErr.message);
    }
  }

  return notificationDoc;
}

/**
 * Lists notifications with pagination and unread filters for an authenticated user.
 */
export async function listUserNotifications(userEmail, { page = 1, limit = 20, unreadOnly = false } = {}) {
  const db = getDb();
  const normalizedEmail = userEmail.toLowerCase().trim();
  const pageNum = Math.max(1, Number(page) || 1);
  const pageLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * pageLimit;

  const filter = { recipientEmail: normalizedEmail };
  if (unreadOnly) {
    filter.read = false;
  }

  const [notifications, total, unreadCount] = await Promise.all([
    db.collection("notifications")
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageLimit)
      .toArray(),
    db.collection("notifications").countDocuments(filter),
    db.collection("notifications").countDocuments({ recipientEmail: normalizedEmail, read: false }),
  ]);

  return {
    notifications,
    total,
    unreadCount,
    page: pageNum,
    limit: pageLimit,
    totalPages: Math.ceil(total / pageLimit) || 1,
  };
}

/**
 * Returns total unread notifications count for badge display.
 */
export async function getUnreadCount(userEmail) {
  const db = getDb();
  const normalizedEmail = userEmail.toLowerCase().trim();
  return await db.collection("notifications").countDocuments({
    recipientEmail: normalizedEmail,
    read: false,
  });
}

/**
 * Marks a single notification as read if owned by the user.
 */
export async function markNotificationAsRead(notificationId, userEmail) {
  const _id = toObjectId(notificationId);
  if (!_id) return null;

  const db = getDb();
  const normalizedEmail = userEmail.toLowerCase().trim();

  const result = await db.collection("notifications").findOneAndUpdate(
    { _id, recipientEmail: normalizedEmail },
    { $set: { read: true, readAt: new Date(), updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  return result;
}

/**
 * Marks all notifications for a user as read.
 */
export async function markAllNotificationsAsRead(userEmail) {
  const db = getDb();
  const normalizedEmail = userEmail.toLowerCase().trim();

  const result = await db.collection("notifications").updateMany(
    { recipientEmail: normalizedEmail, read: false },
    { $set: { read: true, readAt: new Date(), updatedAt: new Date() } }
  );

  return result.modifiedCount;
}

/**
 * Deletes / dismisses a single notification.
 */
export async function deleteNotification(notificationId, userEmail) {
  const _id = toObjectId(notificationId);
  if (!_id) return false;

  const db = getDb();
  const normalizedEmail = userEmail.toLowerCase().trim();

  const result = await db.collection("notifications").deleteOne({
    _id,
    recipientEmail: normalizedEmail,
  });

  return result.deletedCount > 0;
}
