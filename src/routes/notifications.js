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

const router = Router();

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

export default router;
