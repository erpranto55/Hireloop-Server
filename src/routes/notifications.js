import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, notFound } from "../utils/http.js";
import { sseHub } from "../services/sseHub.js";
import {
  listUserNotifications,
  getUnreadCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
} from "../services/notificationService.js";
import {
  isPushConfigured,
  getVapidPublicKey,
  savePushSubscription,
  removePushSubscription,
} from "../services/pushService.js";
import {
  getUserPreferences,
  updateUserPreferences,
  resetUserPreferences,
  verifyUnsubscribeToken,
  applyUnsubscribe,
} from "../services/preferenceService.js";

const router = Router();

// GET /api/notifications/preferences - Fetch authenticated user's notification preferences
router.get("/preferences", requireAuth, asyncHandler(async (req, res) => {
  const result = await getUserPreferences(req.user.email);
  res.json(result);
}));

// PATCH /api/notifications/preferences - Update notification preferences
router.patch("/preferences", requireAuth, asyncHandler(async (req, res) => {
  try {
    const updated = await updateUserPreferences(req.user.email, req.body);
    res.json({ success: true, preferences: updated });
  } catch (err) {
    return badRequest(res, err.message);
  }
}));

// POST /api/notifications/preferences/reset - Reset preferences to system defaults
router.post("/preferences/reset", requireAuth, asyncHandler(async (req, res) => {
  const defaults = await resetUserPreferences(req.user.email);
  res.json({ success: true, message: "Notification preferences reset to default.", preferences: defaults });
}));

// GET /api/notifications/unsubscribe/verify - Verify unsubscribe token (read-only, safe for scanners)
router.get("/unsubscribe/verify", asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return badRequest(res, "Missing unsubscribe token.");
  }

  const result = await verifyUnsubscribeToken(token);
  if (!result.valid) {
    return badRequest(res, result.error);
  }

  res.json({
    valid: true,
    maskedEmail: result.maskedEmail,
    scope: result.scope,
    expiresAt: result.expiresAt,
  });
}));

// POST /api/notifications/unsubscribe - Apply unsubscribe action from web interface
router.post("/unsubscribe", asyncHandler(async (req, res) => {
  const { token, category } = req.body;
  if (!token) {
    return badRequest(res, "Missing unsubscribe token.");
  }

  try {
    const result = await applyUnsubscribe(token, category);
    res.json(result);
  } catch (err) {
    return badRequest(res, err.message);
  }
}));

// POST /api/notifications/unsubscribe/one-click - RFC 8058 One-Click unsubscribe header handler
router.post("/unsubscribe/one-click", asyncHandler(async (req, res) => {
  const token = req.query.token || req.body?.token;
  if (!token) {
    return badRequest(res, "Missing unsubscribe token.");
  }

  try {
    const result = await applyUnsubscribe(token, "all");
    res.json({ success: true, message: "Successfully unsubscribed via one-click header.", result });
  } catch (err) {
    return badRequest(res, err.message);
  }
}));

// GET /api/notifications - List authenticated user's notifications
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const { page, limit, unreadOnly } = req.query;
  const result = await listUserNotifications(req.user.email, {
    page,
    limit,
    unreadOnly: unreadOnly === "true",
  });
  res.json(result);
}));

// GET /api/notifications/unread-count - Badge count of unread notifications
router.get("/unread-count", requireAuth, asyncHandler(async (req, res) => {
  const count = await getUnreadCount(req.user.email);
  res.json({ unreadCount: count });
}));

// GET /api/notifications/stream - Real-Time Server-Sent Events (SSE) feed
router.get("/stream", requireAuth, (req, res) => {
  sseHub.registerClient(req.user.email, req, res);
});

// PATCH /api/notifications/mark-all-read - Mark all user notifications as read
router.patch("/mark-all-read", requireAuth, asyncHandler(async (req, res) => {
  const count = await markAllNotificationsAsRead(req.user.email);
  res.json({ message: "All notifications marked as read.", modifiedCount: count });
}));

// PATCH /api/notifications/:id/read - Mark individual notification as read
router.patch("/:id/read", requireAuth, asyncHandler(async (req, res) => {
  const updated = await markNotificationAsRead(req.params.id, req.user.email);
  if (!updated) {
    return notFound(res, "Notification not found or access denied.");
  }
  res.json(updated);
}));

// DELETE /api/notifications/:id - Dismiss / delete a notification
router.delete("/:id", requireAuth, asyncHandler(async (req, res) => {
  const deleted = await deleteNotification(req.params.id, req.user.email);
  if (!deleted) {
    return notFound(res, "Notification not found or access denied.");
  }
  res.status(204).send();
}));

// GET /api/notifications/push/public-key - Check Push status and get public VAPID key
router.get("/push/public-key", requireAuth, (req, res) => {
  const isConfigured = isPushConfigured();
  const publicKey = getVapidPublicKey();
  res.json({
    configured: isConfigured,
    publicKey,
  });
});

// POST /api/notifications/push/subscribe - Register browser push subscription
router.post("/push/subscribe", requireAuth, asyncHandler(async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) {
    return badRequest(res, "Invalid subscription payload: endpoint is required.");
  }

  const saved = await savePushSubscription(req.user.email, subscription);
  res.json({ success: true, subscription: saved });
}));

// POST /api/notifications/push/unsubscribe - Unregister browser push subscription
router.post("/push/unsubscribe", requireAuth, asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return badRequest(res, "endpoint is required to unsubscribe.");
  }

  const count = await removePushSubscription(req.user.email, endpoint);
  res.json({ success: true, removed: count });
}));

export default router;
