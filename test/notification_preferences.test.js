import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PREFERENCES,
  ALLOWED_REMINDER_LEAD_TIMES,
  ALLOWED_DIGEST_FREQUENCIES,
  mergeWithDefaults,
  validatePreferencesPayload,
  shouldDeliverEmail,
  hashUnsubscribeToken,
  ESSENTIAL_TEMPLATES,
} from "../src/services/preferenceService.js";
import { calculateReminderDeadlines } from "../src/services/reminderService.js";
import { emailTemplates } from "../src/services/emailService.js";

// -------------------------------------------------------------
// 1. Defaults & Schema Merging
// -------------------------------------------------------------
test("mergeWithDefaults returns safe defaults for null or empty preference input", () => {
  const merged = mergeWithDefaults(null);

  assert.equal(merged.applications.applicationReceived, true);
  assert.equal(merged.applications.applicationStatusChanged, true);
  assert.equal(merged.applications.interviewInvites, true);

  assert.equal(merged.messaging.newMessage, true);
  assert.equal(merged.messaging.offlineDigest, true);
  assert.equal(merged.messaging.digestFrequency, "every_4h");

  assert.equal(merged.reminders.interviewReminders, true);
  assert.deepEqual(merged.reminders.reminderLeadTimes, ["24h", "1h"]);

  assert.equal(merged.billing.paymentReceipts, true);
  assert.equal(merged.billing.subscriptionAlerts, true);

  assert.equal(merged.channels.inApp, true);
  assert.equal(merged.channels.email, true);
  assert.equal(merged.channels.webPush, false);
});

test("mergeWithDefaults preserves custom user values while defaulting missing ones", () => {
  const stored = {
    messaging: {
      newMessage: false,
      digestFrequency: "daily",
    },
    reminders: {
      reminderLeadTimes: ["48h", "2h"],
    },
    channels: {
      email: false,
    },
  };

  const merged = mergeWithDefaults(stored);

  // Custom preserved
  assert.equal(merged.messaging.newMessage, false);
  assert.equal(merged.messaging.digestFrequency, "daily");
  assert.deepEqual(merged.reminders.reminderLeadTimes, ["48h", "2h"]);
  assert.equal(merged.channels.email, false);

  // Missing defaulted safely
  assert.equal(merged.messaging.offlineDigest, true);
  assert.equal(merged.applications.applicationReceived, true);
  assert.equal(merged.channels.inApp, true);
});

// -------------------------------------------------------------
// 2. Server-side Payload Validation
// -------------------------------------------------------------
test("validatePreferencesPayload accepts valid partial updates", () => {
  const payload = {
    messaging: {
      newMessage: false,
      digestFrequency: "every_12h",
    },
    reminders: {
      reminderLeadTimes: ["48h", "12h", "1h"],
    },
  };

  const result = validatePreferencesPayload(payload);
  assert.equal(result.valid, true);
});

test("validatePreferencesPayload rejects unsupported root sections", () => {
  const payload = {
    unsupportedSection: { key: "value" },
  };

  const result = validatePreferencesPayload(payload);
  assert.equal(result.valid, false);
  assert.equal(result.error.includes("Unsupported preference section"), true);
});

test("validatePreferencesPayload rejects invalid digest frequency values", () => {
  const payload = {
    messaging: {
      digestFrequency: "every_5_minutes", // not in ALLOWED_DIGEST_FREQUENCIES
    },
  };

  const result = validatePreferencesPayload(payload);
  assert.equal(result.valid, false);
  assert.equal(result.error.includes("Invalid digestFrequency"), true);
});

test("validatePreferencesPayload rejects invalid reminder lead times", () => {
  const payload = {
    reminders: {
      reminderLeadTimes: ["5m", "100h"], // not in ALLOWED_REMINDER_LEAD_TIMES
    },
  };

  const result = validatePreferencesPayload(payload);
  assert.equal(result.valid, false);
  assert.equal(result.error.includes("Invalid lead time"), true);
});

test("validatePreferencesPayload rejects non-boolean toggle values", () => {
  const payload = {
    channels: {
      email: "yes", // string instead of boolean
    },
  };

  const result = validatePreferencesPayload(payload);
  assert.equal(result.valid, false);
  assert.equal(result.error.includes("must be a boolean"), true);
});

// -------------------------------------------------------------
// 3. Essential vs Optional Email Policy Enforcement
// -------------------------------------------------------------
test("ESSENTIAL_TEMPLATES contains critical security and billing failure notices", () => {
  assert.equal(ESSENTIAL_TEMPLATES.has("paymentFailed"), true);
  assert.equal(ESSENTIAL_TEMPLATES.has("interviewCanceled"), true);
  assert.equal(ESSENTIAL_TEMPLATES.has("accountSecurity"), true);
});

test("shouldDeliverEmail always allows essential notices even with suppressed email channel", async () => {
  const essential1 = await shouldDeliverEmail("user@example.com", "paymentFailed");
  assert.equal(essential1.deliver, true);
  assert.equal(essential1.essential, true);

  const essential2 = await shouldDeliverEmail("user@example.com", "interviewCanceled");
  assert.equal(essential2.deliver, true);
  assert.equal(essential2.essential, true);
});

// -------------------------------------------------------------
// 4. Configurable Reminder Lead Times Calculation
// -------------------------------------------------------------
test("calculateReminderDeadlines generates exact UTC timestamps for configured lead times", () => {
  const interviewTime = new Date("2026-11-01T15:00:00Z");
  const leadTimes = ["48h", "24h", "12h", "2h", "1h"];

  const deadlines = calculateReminderDeadlines(interviewTime, leadTimes);

  assert.equal(deadlines["48h"].toISOString(), new Date(interviewTime.getTime() - 48 * 3600000).toISOString());
  assert.equal(deadlines["24h"].toISOString(), new Date(interviewTime.getTime() - 24 * 3600000).toISOString());
  assert.equal(deadlines["12h"].toISOString(), new Date(interviewTime.getTime() - 12 * 3600000).toISOString());
  assert.equal(deadlines["2h"].toISOString(), new Date(interviewTime.getTime() - 2 * 3600000).toISOString());
  assert.equal(deadlines["1h"].toISOString(), new Date(interviewTime.getTime() - 1 * 3600000).toISOString());
});

// -------------------------------------------------------------
// 5. Secure Unsubscribe Token Hashing
// -------------------------------------------------------------
test("hashUnsubscribeToken produces consistent SHA-256 output", () => {
  const token = "a".repeat(64);
  const hash1 = hashUnsubscribeToken(token);
  const hash2 = hashUnsubscribeToken(token);

  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
  assert.notEqual(hash1, token);
});

// -------------------------------------------------------------
// 6. Email Footer Unsubscribe Slot
// -------------------------------------------------------------
test("emailTemplates render with base layout containing unsubscribe slot", () => {
  const template = emailTemplates.newMessageReceived({
    senderName: "Sarah Connor",
    jobTitle: "Security Lead",
    previewText: "Let's schedule a chat.",
    inboxUrl: "/dashboard/messages",
  });

  assert.equal(template.html.includes("<!-- UNSUBSCRIBE_SLOT -->"), true);
  assert.equal(template.subject.includes("New message from Sarah Connor"), true);
});
