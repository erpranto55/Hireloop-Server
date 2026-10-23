/**
 * Presence & Inactivity Tracking Service for HireLoop
 * Tracks authenticated user activity and SSE presence to reliably identify
 * offline recipients for unread message digests.
 */

import { getDb } from "../db.js";
import { sseHub } from "./sseHub.js";

// In-memory throttle map to prevent high-frequency DB writes: email -> lastLoggedTimestamp
const activityThrottle = new Map();
const THROTTLE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Wire up sseHub disconnection hook
sseHub.onUserDisconnect = (email) => {
  recordUserDisconnect(email);
};

/**
 * Records user activity on authenticated API requests, throttled to at most once per 5 minutes.
 */
export async function recordUserActivity(email) {
  if (!email || typeof email !== "string") return;
  const normalizedEmail = email.toLowerCase().trim();
  const now = Date.now();

  const lastRecorded = activityThrottle.get(normalizedEmail) || 0;
  if (now - lastRecorded < THROTTLE_INTERVAL_MS) {
    return;
  }

  activityThrottle.set(normalizedEmail, now);

  try {
    const db = getDb();
    await db.collection("user").updateOne(
      { email: normalizedEmail },
      { $set: { lastActiveAt: new Date(now), updatedAt: new Date(now) } }
    );
  } catch (err) {
    // Non-blocking: background activity recording should not disrupt API flow
    console.error("[PresenceService] Error updating lastActiveAt:", err.message);
  }
}

/**
 * Records user disconnection timestamp when an SSE connection closes.
 */
export async function recordUserDisconnect(email) {
  if (!email || typeof email !== "string") return;
  const normalizedEmail = email.toLowerCase().trim();
  const now = new Date();

  // If user still has other open tabs / connections, they are not disconnected
  if (sseHub.isUserOnline(normalizedEmail)) {
    return;
  }

  try {
    const db = getDb();
    await db.collection("user").updateOne(
      { email: normalizedEmail },
      { $set: { lastDisconnectedAt: now, updatedAt: now } }
    );
  } catch (err) {
    console.error("[PresenceService] Error updating lastDisconnectedAt:", err.message);
  }
}

/**
 * Checks if a user is currently offline and has been inactive for at least durationMs (default: 2 hours).
 * Rule:
 * 1. Must NOT have any active SSE connection.
 * 2. Most recent authenticated activity (lastActiveAt) must be >= durationMs ago.
 * 3. Most recent disconnection (lastDisconnectedAt), if recorded, must be >= durationMs ago.
 */
export async function isUserOfflineForDuration(email, durationMs = 2 * 60 * 60 * 1000) {
  if (!email) return false;
  const normalizedEmail = email.toLowerCase().trim();

  // 1. Live SSE check
  if (sseHub.isUserOnline(normalizedEmail)) {
    return false;
  }

  // 2. Fetch persistent activity timestamps from database
  const db = getDb();
  const user = await db.collection("user").findOne(
    { email: normalizedEmail },
    { projection: { lastActiveAt: 1, lastDisconnectedAt: 1, lastMessageDigestAt: 1 } }
  );

  if (!user) {
    return false;
  }

  const now = Date.now();

  // If user had authenticated activity within the threshold, they are not considered offline
  if (user.lastActiveAt) {
    const elapsedActive = now - new Date(user.lastActiveAt).getTime();
    if (elapsedActive < durationMs) {
      return false;
    }
  }

  // If user disconnected within the threshold, they are not considered offline for 2+ hours
  if (user.lastDisconnectedAt) {
    const elapsedDisconnect = now - new Date(user.lastDisconnectedAt).getTime();
    if (elapsedDisconnect < durationMs) {
      return false;
    }
  }

  return true;
}

/**
 * Retrieves user's presence summary for diagnostics.
 */
export async function getUserPresence(email) {
  if (!email) return null;
  const normalizedEmail = email.toLowerCase().trim();
  const isOnline = sseHub.isUserOnline(normalizedEmail);

  const db = getDb();
  const user = await db.collection("user").findOne(
    { email: normalizedEmail },
    { projection: { lastActiveAt: 1, lastDisconnectedAt: 1, lastMessageDigestAt: 1 } }
  );

  const now = Date.now();
  const lastActive = user?.lastActiveAt ? new Date(user.lastActiveAt) : null;
  const lastDisconnected = user?.lastDisconnectedAt ? new Date(user.lastDisconnectedAt) : null;
  const lastDigest = user?.lastMessageDigestAt ? new Date(user.lastMessageDigestAt) : null;

  const offlineMs = !isOnline && lastActive ? now - lastActive.getTime() : 0;

  return {
    email: normalizedEmail,
    isOnline,
    lastActiveAt: lastActive,
    lastDisconnectedAt: lastDisconnected,
    lastMessageDigestAt: lastDigest,
    offlineHours: isOnline ? 0 : Number((offlineMs / (1000 * 60 * 60)).toFixed(2)),
  };
}

/**
 * Resets in-memory throttle cache (primarily for unit tests).
 */
export function resetPresenceThrottle() {
  activityThrottle.clear();
}
