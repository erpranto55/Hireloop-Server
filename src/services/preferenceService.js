/**
 * User Notification & Delivery Preferences Service for HireLoop
 * Manages per-category alerts, reminder lead times, digest frequencies,
 * email suppression checks, and cryptographically secure unsubscribe tokens.
 */

import crypto from "crypto";
import { getDb } from "../db.js";
import { isPushConfigured } from "./pushService.js";

export const ALLOWED_REMINDER_LEAD_TIMES = ["48h", "24h", "12h", "2h", "1h"];
export const ALLOWED_DIGEST_FREQUENCIES = ["every_4h", "every_12h", "daily"];

export const DEFAULT_PREFERENCES = Object.freeze({
  applications: {
    applicationReceived: true,
    applicationStatusChanged: true,
    interviewInvites: true,
  },
  messaging: {
    newMessage: true,
    offlineDigest: true,
    digestFrequency: "every_4h",
  },
  reminders: {
    interviewReminders: true,
    reminderLeadTimes: ["24h", "1h"],
  },
  billing: {
    paymentReceipts: true,
    subscriptionAlerts: true,
  },
  channels: {
    inApp: true,
    email: true,
    webPush: false,
  },
});

/**
 * Mapping of transactional email template names to preference categories.
 * Critical security/account communications are explicitly excluded from suppression.
 */
export const TEMPLATE_TO_PREFERENCE_MAP = {
  applicationReceived: { category: "applications", key: "applicationReceived" },
  applicationStatusChanged: { category: "applications", key: "applicationStatusChanged" },
  interviewInvitation: { category: "applications", key: "interviewInvites" },
  interviewRescheduled: { category: "applications", key: "interviewInvites" },
  interviewStatusUpdated: { category: "applications", key: "interviewInvites" },
  newMessageReceived: { category: "messaging", key: "newMessage" },
  offlineMessageDigest: { category: "messaging", key: "offlineDigest" },
  interviewReminder24h: { category: "reminders", key: "interviewReminders" },
  interviewReminder1h: { category: "reminders", key: "interviewReminders" },
  paymentSucceeded: { category: "billing", key: "paymentReceipts" },
  subscriptionActivated: { category: "billing", key: "subscriptionAlerts" },
  subscriptionCanceled: { category: "billing", key: "subscriptionAlerts" },
};

/**
 * Essential transactional communications that can NEVER be suppressed by user preference.
 */
export const ESSENTIAL_TEMPLATES = new Set([
  "paymentFailed", // Critical billing failure / service disruption notice
  "interviewCanceled", // Direct cancellation notice
  "accountSecurity", // Password reset, verification, suspension
]);

/**
 * Deep merges stored user preferences with system defaults.
 */
export function mergeWithDefaults(stored = {}) {
  return {
    applications: {
      applicationReceived: stored?.applications?.applicationReceived ?? DEFAULT_PREFERENCES.applications.applicationReceived,
      applicationStatusChanged: stored?.applications?.applicationStatusChanged ?? DEFAULT_PREFERENCES.applications.applicationStatusChanged,
      interviewInvites: stored?.applications?.interviewInvites ?? DEFAULT_PREFERENCES.applications.interviewInvites,
    },
    messaging: {
      newMessage: stored?.messaging?.newMessage ?? DEFAULT_PREFERENCES.messaging.newMessage,
      offlineDigest: stored?.messaging?.offlineDigest ?? DEFAULT_PREFERENCES.messaging.offlineDigest,
      digestFrequency: ALLOWED_DIGEST_FREQUENCIES.includes(stored?.messaging?.digestFrequency)
        ? stored.messaging.digestFrequency
        : DEFAULT_PREFERENCES.messaging.digestFrequency,
    },
    reminders: {
      interviewReminders: stored?.reminders?.interviewReminders ?? DEFAULT_PREFERENCES.reminders.interviewReminders,
      reminderLeadTimes: Array.isArray(stored?.reminders?.reminderLeadTimes) && stored.reminders.reminderLeadTimes.length > 0
        ? stored.reminders.reminderLeadTimes.filter((t) => ALLOWED_REMINDER_LEAD_TIMES.includes(t))
        : [...DEFAULT_PREFERENCES.reminders.reminderLeadTimes],
    },
    billing: {
      paymentReceipts: stored?.billing?.paymentReceipts ?? DEFAULT_PREFERENCES.billing.paymentReceipts,
      subscriptionAlerts: stored?.billing?.subscriptionAlerts ?? DEFAULT_PREFERENCES.billing.subscriptionAlerts,
    },
    channels: {
      inApp: stored?.channels?.inApp ?? DEFAULT_PREFERENCES.channels.inApp,
      email: stored?.channels?.email ?? DEFAULT_PREFERENCES.channels.email,
      webPush: stored?.channels?.webPush ?? DEFAULT_PREFERENCES.channels.webPush,
    },
  };
}

/**
 * Validates preference update payload on the server.
 * Rejects unknown properties or invalid data types.
 */
export function validatePreferencesPayload(updates) {
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    return { valid: false, error: "Invalid payload: must be an object." };
  }

  const allowedSections = ["applications", "messaging", "reminders", "billing", "channels"];
  for (const section of Object.keys(updates)) {
    if (!allowedSections.includes(section)) {
      return { valid: false, error: `Unsupported preference section: "${section}".` };
    }

    const sectionData = updates[section];
    if (typeof sectionData !== "object" || sectionData === null || Array.isArray(sectionData)) {
      return { valid: false, error: `Section "${section}" must be an object.` };
    }

    if (section === "applications") {
      for (const [k, v] of Object.entries(sectionData)) {
        if (!["applicationReceived", "applicationStatusChanged", "interviewInvites"].includes(k)) {
          return { valid: false, error: `Unsupported applications preference: "${k}".` };
        }
        if (typeof v !== "boolean") return { valid: false, error: `${k} must be a boolean.` };
      }
    }

    if (section === "messaging") {
      for (const [k, v] of Object.entries(sectionData)) {
        if (!["newMessage", "offlineDigest", "digestFrequency"].includes(k)) {
          return { valid: false, error: `Unsupported messaging preference: "${k}".` };
        }
        if (["newMessage", "offlineDigest"].includes(k) && typeof v !== "boolean") {
          return { valid: false, error: `${k} must be a boolean.` };
        }
        if (k === "digestFrequency" && !ALLOWED_DIGEST_FREQUENCIES.includes(v)) {
          return { valid: false, error: `Invalid digestFrequency. Allowed: ${ALLOWED_DIGEST_FREQUENCIES.join(", ")}.` };
        }
      }
    }

    if (section === "reminders") {
      for (const [k, v] of Object.entries(sectionData)) {
        if (!["interviewReminders", "reminderLeadTimes"].includes(k)) {
          return { valid: false, error: `Unsupported reminders preference: "${k}".` };
        }
        if (k === "interviewReminders" && typeof v !== "boolean") {
          return { valid: false, error: `${k} must be a boolean.` };
        }
        if (k === "reminderLeadTimes") {
          if (!Array.isArray(v) || v.length === 0) {
            return { valid: false, error: "reminderLeadTimes must be a non-empty array." };
          }
          for (const item of v) {
            if (!ALLOWED_REMINDER_LEAD_TIMES.includes(item)) {
              return { valid: false, error: `Invalid lead time: "${item}". Allowed: ${ALLOWED_REMINDER_LEAD_TIMES.join(", ")}.` };
            }
          }
        }
      }
    }

    if (section === "billing") {
      for (const [k, v] of Object.entries(sectionData)) {
        if (!["paymentReceipts", "subscriptionAlerts"].includes(k)) {
          return { valid: false, error: `Unsupported billing preference: "${k}".` };
        }
        if (typeof v !== "boolean") return { valid: false, error: `${k} must be a boolean.` };
      }
    }

    if (section === "channels") {
      for (const [k, v] of Object.entries(sectionData)) {
        if (!["inApp", "email", "webPush"].includes(k)) {
          return { valid: false, error: `Unsupported channel preference: "${k}".` };
        }
        if (typeof v !== "boolean") return { valid: false, error: `${k} must be a boolean.` };
      }
    }
  }

  return { valid: true };
}

/**
 * Retrieves the effective notification preferences for a user, along with channel operational status.
 */
export async function getUserPreferences(userEmail) {
  if (!userEmail) return mergeWithDefaults();
  const normalizedEmail = userEmail.toLowerCase().trim();

  let user = null;
  try {
    const db = getDb();
    user = await db.collection("user").findOne(
      { email: normalizedEmail },
      { projection: { notificationPreferences: 1, role: 1 } }
    );
  } catch (err) {
    // If DB is disconnected, return safe defaults
    return {
      preferences: mergeWithDefaults(),
      channels: {
        inAppAvailable: true,
        emailAvailable: true,
        webPushAvailable: false,
      },
    };
  }

  const preferences = mergeWithDefaults(user?.notificationPreferences || {});
  const pushAvailable = isPushConfigured();

  return {
    preferences,
    channels: {
      inAppAvailable: true,
      emailAvailable: true,
      webPushAvailable: pushAvailable,
    },
  };
}

/**
 * Updates a user's notification preferences partially and safely.
 */
export async function updateUserPreferences(userEmail, updates) {
  if (!userEmail) throw new Error("userEmail is required.");
  const normalizedEmail = userEmail.toLowerCase().trim();

  const validation = validatePreferencesPayload(updates);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const db = getDb();
  const current = await getUserPreferences(normalizedEmail);
  const existing = current.preferences;

  // Build merged object preserving unrelated settings
  const merged = {
    applications: { ...existing.applications, ...(updates.applications || {}) },
    messaging: { ...existing.messaging, ...(updates.messaging || {}) },
    reminders: { ...existing.reminders, ...(updates.reminders || {}) },
    billing: { ...existing.billing, ...(updates.billing || {}) },
    channels: { ...existing.channels, ...(updates.channels || {}) },
  };

  await db.collection("user").updateOne(
    { email: normalizedEmail },
    {
      $set: {
        notificationPreferences: merged,
        updatedAt: new Date(),
      },
    }
  );

  if (updates.reminders) {
    try {
      const { reconcileUserReminderPreferences } = await import("./reminderService.js");
      await reconcileUserReminderPreferences(normalizedEmail);
    } catch (err) {
      console.error("[PreferenceService] Reminder reconciliation error:", err.message);
    }
  }

  return merged;
}

/**
 * Resets user preferences back to system defaults.
 */
export async function resetUserPreferences(userEmail) {
  if (!userEmail) throw new Error("userEmail is required.");
  const normalizedEmail = userEmail.toLowerCase().trim();
  const db = getDb();

  await db.collection("user").updateOne(
    { email: normalizedEmail },
    {
      $set: {
        notificationPreferences: DEFAULT_PREFERENCES,
        updatedAt: new Date(),
      },
    }
  );

  try {
    const { reconcileUserReminderPreferences } = await import("./reminderService.js");
    await reconcileUserReminderPreferences(normalizedEmail);
  } catch (err) {
    console.error("[PreferenceService] Reminder reconciliation error on reset:", err.message);
  }

  return DEFAULT_PREFERENCES;
}

/**
 * Evaluates whether an email template should be delivered to the recipient
 * based on current preferences.
 * Returns { deliver: boolean, reason?: string }.
 */
export async function shouldDeliverEmail(userEmail, templateType) {
  if (!userEmail || !templateType) return { deliver: true };
  const normalizedEmail = userEmail.toLowerCase().trim();

  // 1. Essential account / security / billing communications cannot be suppressed
  if (ESSENTIAL_TEMPLATES.has(templateType)) {
    return { deliver: true, essential: true };
  }

  // 2. Fetch user's current preferences
  const { preferences } = await getUserPreferences(normalizedEmail);

  // 3. Global email channel check
  if (preferences.channels.email === false) {
    return { deliver: false, reason: "email_channel_disabled" };
  }

  // 4. Per-category mapping check
  const mapping = TEMPLATE_TO_PREFERENCE_MAP[templateType];
  if (!mapping) {
    // Unmapped templates are delivered by default
    return { deliver: true };
  }

  const categoryConfig = preferences[mapping.category];
  if (!categoryConfig) return { deliver: true };

  const isEnabled = categoryConfig[mapping.key];
  if (isEnabled === false) {
    return { deliver: false, reason: `category_disabled_${mapping.category}_${mapping.key}` };
  }

  return { deliver: true };
}

// -------------------------------------------------------------
// SECURE EMAIL UNSUBSCRIBE TOKEN SYSTEM
// -------------------------------------------------------------

/**
 * Hashes an unsubscribe token using SHA-256 for secure DB persistence.
 */
export function hashUnsubscribeToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Generates a high-entropy cryptographically secure unsubscribe token.
 * Persists the hash in the unsubscribe_tokens collection.
 */
export async function generateUnsubscribeToken(userEmail, scope = "all_optional") {
  if (!userEmail) return null;
  const normalizedEmail = userEmail.toLowerCase().trim();

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashUnsubscribeToken(rawToken);
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days validity

  try {
    const db = getDb();
    await db.collection("unsubscribe_tokens").insertOne({
      tokenHash,
      userEmail: normalizedEmail,
      scope, // "all_optional" or specific category e.g. "messaging.newMessage"
      expiresAt,
      usedAt: null,
      createdAt: new Date(),
    });
  } catch (err) {
    // If DB is disconnected or fails in tests, return raw token
    console.error("[PreferenceService] Token save error:", err.message);
  }

  return rawToken;
}

/**
 * Verifies an unsubscribe token without executing the change (safe for link crawlers).
 */
export async function verifyUnsubscribeToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 32) {
    return { valid: false, error: "Invalid token format." };
  }

  const tokenHash = hashUnsubscribeToken(rawToken);
  const db = getDb();
  const tokenDoc = await db.collection("unsubscribe_tokens").findOne({ tokenHash });

  if (!tokenDoc) {
    return { valid: false, error: "Unsubscribe token not found or already revoked." };
  }

  if (tokenDoc.expiresAt && new Date() > new Date(tokenDoc.expiresAt)) {
    return { valid: false, error: "Unsubscribe token has expired." };
  }

  // Mask email for privacy display (e.g. j***e@domain.com)
  const parts = tokenDoc.userEmail.split("@");
  const maskedLocal = parts[0].length > 2
    ? parts[0][0] + "***" + parts[0][parts[0].length - 1]
    : "***";
  const maskedEmail = `${maskedLocal}@${parts[1] || "domain.com"}`;

  return {
    valid: true,
    userEmail: tokenDoc.userEmail,
    maskedEmail,
    scope: tokenDoc.scope,
    expiresAt: tokenDoc.expiresAt,
  };
}

/**
 * Applies the unsubscribe action cryptographically verifying the token.
 * Supports disabling a specific category or all optional emails.
 */
export async function applyUnsubscribe(rawToken, category = null) {
  const verification = await verifyUnsubscribeToken(rawToken);
  if (!verification.valid) {
    throw new Error(verification.error);
  }

  const userEmail = verification.userEmail;
  const db = getDb();

  const updates = {};

  if (!category || category === "all" || verification.scope === "all_optional") {
    // Disable all optional email notifications
    updates.channels = { email: false };
    updates.messaging = { newMessage: false, offlineDigest: false };
    updates.reminders = { interviewReminders: false };
    updates.applications = { applicationReceived: false, applicationStatusChanged: false, interviewInvites: false };
  } else if (category === "messaging") {
    updates.messaging = { newMessage: false, offlineDigest: false };
  } else if (category === "reminders") {
    updates.reminders = { interviewReminders: false };
  } else if (category === "applications") {
    updates.applications = { applicationReceived: false, applicationStatusChanged: false, interviewInvites: false };
  }

  const updatedPrefs = await updateUserPreferences(userEmail, updates);

  // Mark token used (idempotent: subsequent calls succeed)
  await db.collection("unsubscribe_tokens").updateOne(
    { tokenHash: hashUnsubscribeToken(rawToken) },
    { $set: { usedAt: new Date(), updatedAt: new Date() } }
  );

  return {
    success: true,
    userEmail,
    scopeApplied: category || verification.scope,
    preferences: updatedPrefs,
  };
}
