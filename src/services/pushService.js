/**
 * Web Push Notification Service for HireLoop
 * Manages push subscriptions and delivers browser notifications when VAPID keys are configured.
 * Safely degrades when push credentials or provider infrastructure are not configured.
 */

import { getDb } from "../db.js";

/**
 * Checks if Web Push is configured with valid server-side VAPID credentials.
 */
export function isPushConfigured() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  return Boolean(
    publicKey &&
    privateKey &&
    publicKey !== "vapid_public_placeholder" &&
    privateKey !== "vapid_private_placeholder"
  );
}

/**
 * Returns the public VAPID key for client browser subscription, or null if unconfigured.
 */
export function getVapidPublicKey() {
  if (!isPushConfigured()) return null;
  return process.env.VAPID_PUBLIC_KEY;
}

/**
 * Stores or updates a user's browser push subscription.
 */
export async function savePushSubscription(userEmail, subscription) {
  if (!userEmail || !subscription || !subscription.endpoint) {
    throw new Error("Invalid push subscription payload: endpoint is required.");
  }

  const db = getDb();
  const normalizedEmail = userEmail.toLowerCase().trim();

  const doc = {
    userEmail: normalizedEmail,
    endpoint: subscription.endpoint,
    keys: subscription.keys || {},
    userAgent: subscription.userAgent || "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.collection("push_subscriptions").updateOne(
    { endpoint: subscription.endpoint },
    { $set: doc },
    { upsert: true }
  );

  return doc;
}

/**
 * Removes an active push subscription by endpoint.
 */
export async function removePushSubscription(userEmail, endpoint) {
  if (!endpoint) return 0;
  const db = getDb();
  const normalizedEmail = userEmail.toLowerCase().trim();

  const result = await db.collection("push_subscriptions").deleteOne({
    userEmail: normalizedEmail,
    endpoint,
  });

  return result.deletedCount;
}

/**
 * Sends a push notification to all registered subscriptions for a given user.
 * Gracefully logs and falls back if VAPID keys are not configured or if endpoints expire (404/410 Gone).
 */
export async function sendPushNotification(userEmail, { title, message, url = "/dashboard", tag = "hireloop" }) {
  if (!userEmail) return { sent: 0, status: "skipped", reason: "missing_recipient" };
  const normalizedEmail = userEmail.toLowerCase().trim();

  let db;
  try {
    db = getDb();
  } catch {
    return { sent: 0, status: "skipped", reason: "no_db" };
  }

  const subscriptions = await db.collection("push_subscriptions").find({
    userEmail: normalizedEmail,
  }).toArray();

  if (!subscriptions.length) {
    return { sent: 0, status: "skipped", reason: "no_subscriptions" };
  }

  if (!isPushConfigured()) {
    return {
      sent: 0,
      status: "unconfigured",
      reason: "VAPID keys not configured in environment (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)",
      subscriptionsCount: subscriptions.length,
    };
  }

  // If VAPID is configured, dynamically use web-push
  try {
    const webPushModule = await import("web-push");
    const webPush = webPushModule.default || webPushModule;

    webPush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:notifications@hireloop.dev",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const payload = JSON.stringify({
      title,
      body: message,
      icon: "/images/logo.png",
      badge: "/images/badge.png",
      data: { url },
      tag,
    });

    let sent = 0;

    for (const sub of subscriptions) {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: sub.keys,
          },
          payload
        );
        sent++;
      } catch (err) {
        // HTTP 404 or 410 indicates the push subscription has expired or been revoked by the browser
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.log(`[PushService] Removing expired push subscription: ${sub.endpoint}`);
          await db.collection("push_subscriptions").deleteOne({ _id: sub._id });
        } else {
          console.error(`[PushService] Push error for ${sub.endpoint}:`, err.message);
        }
      }
    }

    return { sent, status: "delivered", total: subscriptions.length };
  } catch (err) {
    console.error("[PushService] Dynamic push delivery error:", err.message);
    return { sent: 0, status: "failed", error: err.message };
  }
}
