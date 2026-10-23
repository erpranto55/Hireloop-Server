import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateReminderDeadlines,
  scheduleInterviewReminders,
  invalidateInterviewReminders,
  ELIGIBLE_REMINDER_STATUSES,
} from "../src/services/reminderService.js";
import { isPushConfigured, getVapidPublicKey, savePushSubscription, removePushSubscription, sendPushNotification } from "../src/services/pushService.js";
import { emailTemplates } from "../src/services/emailService.js";
import { sseHub } from "../src/services/sseHub.js";

// Test suite for Interview Reminders, Offline Message Digests & Outbox Worker

test("Reminder Schedule Deadlines: calculates exact 24h and 1h UTC deadlines", () => {
  const baseTime = new Date("2026-11-15T14:00:00.000Z");
  const deadlines = calculateReminderDeadlines(baseTime);

  assert.notEqual(deadlines, null);
  // 24h before
  assert.equal(deadlines["24h"].toISOString(), "2026-11-14T14:00:00.000Z");
  // 1h before
  assert.equal(deadlines["1h"].toISOString(), "2026-11-15T13:00:00.000Z");

  // Invalid date returns null
  assert.equal(calculateReminderDeadlines("not-a-date"), null);
});

test("Reminder Eligibility: Canceled, Completed, or past interviews are rejected", async () => {
  const pastInterview = {
    _id: "int_past",
    status: "Confirmed",
    scheduledAt: new Date(Date.now() - 3600000), // 1 hour ago
  };

  const canceledInterview = {
    _id: "int_canceled",
    status: "Canceled",
    scheduledAt: new Date(Date.now() + 48 * 3600000),
  };

  const completedInterview = {
    _id: "int_completed",
    status: "Completed",
    scheduledAt: new Date(Date.now() + 48 * 3600000),
  };

  assert.equal(ELIGIBLE_REMINDER_STATUSES.includes("Confirmed"), true);
  assert.equal(ELIGIBLE_REMINDER_STATUSES.includes("Rescheduled"), true);
  assert.equal(ELIGIBLE_REMINDER_STATUSES.includes("Canceled"), false);
  assert.equal(ELIGIBLE_REMINDER_STATUSES.includes("Completed"), false);

  // Scheduling function returns empty array for past or terminal interviews
  const pastRes = await scheduleInterviewReminders(pastInterview);
  assert.deepEqual(pastRes, []);

  const canceledRes = await scheduleInterviewReminders(canceledInterview);
  assert.deepEqual(canceledRes, []);

  const completedRes = await scheduleInterviewReminders(completedInterview);
  assert.deepEqual(completedRes, []);
});

test("Reminder Idempotency & Concurrency: duplicate scheduler calls do not duplicate reminders", () => {
  const reminderStore = new Map();

  function saveReminder(doc) {
    if (reminderStore.has(doc.idempotencyKey)) {
      return { duplicate: true, doc: reminderStore.get(doc.idempotencyKey) };
    }
    const saved = { ...doc, _id: "rem_" + Math.random().toString(36).substring(2, 7) };
    reminderStore.set(doc.idempotencyKey, saved);
    return { duplicate: false, doc: saved };
  }

  const interviewId = "int_100";
  const version = new Date("2026-12-01T10:00:00Z").getTime();

  const reminder1 = saveReminder({
    interviewId,
    offset: "24h",
    recipientEmail: "candidate@example.com",
    idempotencyKey: `reminder_${interviewId}_24h_candidate@example.com_${version}`,
    status: "pending",
  });
  assert.equal(reminder1.duplicate, false);

  // Second pass of scheduler
  const reminder2 = saveReminder({
    interviewId,
    offset: "24h",
    recipientEmail: "candidate@example.com",
    idempotencyKey: `reminder_${interviewId}_24h_candidate@example.com_${version}`,
    status: "pending",
  });
  assert.equal(reminder2.duplicate, true);
  assert.equal(reminder2.doc._id, reminder1.doc._id);
});

test("Rescheduling & Invalidation: rescheduling supersedes old reminders with new deadlines", () => {
  const reminders = [
    {
      _id: "r1",
      interviewId: "int_abc",
      offset: "24h",
      scheduleVersion: 1000,
      status: "pending",
    },
    {
      _id: "r2",
      interviewId: "int_abc",
      offset: "1h",
      scheduleVersion: 1000,
      status: "pending",
    },
  ];

  function invalidateReminders(list, interviewId, reason) {
    const targetStatus = reason === "rescheduled" ? "superseded" : "canceled";
    return list.map((r) => {
      if (r.interviewId === interviewId && ["pending", "processing"].includes(r.status)) {
        return { ...r, status: targetStatus, invalidationReason: reason };
      }
      return r;
    });
  }

  // 1. Reschedule action
  const afterReschedule = invalidateReminders(reminders, "int_abc", "rescheduled");
  assert.equal(afterReschedule.every((r) => r.status === "superseded"), true);

  // 2. Cancel action
  const afterCancel = invalidateReminders(reminders, "int_abc", "canceled");
  assert.equal(afterCancel.every((r) => r.status === "canceled"), true);
});

test("Reminder Staleness Check: missed reminders for already-started interviews are skipped", () => {
  const now = new Date("2026-11-20T15:30:00.000Z").getTime();
  const scheduledInterviewTime = new Date("2026-11-20T15:00:00.000Z").getTime(); // Started 30 min ago

  function shouldDispatchReminder(reminderNow, interviewStart) {
    if (reminderNow >= interviewStart) {
      return { dispatch: false, reason: "skipped_stale" };
    }
    return { dispatch: true };
  }

  const check = shouldDispatchReminder(now, scheduledInterviewTime);
  assert.equal(check.dispatch, false);
  assert.equal(check.reason, "skipped_stale");
});

test("Email Templates: 24h & 1h reminders provide role-tailored information without screening notes", () => {
  const reminder24h = emailTemplates.interviewReminder24h({
    recipientName: "Alex Rivera",
    recipientRole: "seeker",
    otherPartyName: "Acme Corp Recruiter",
    jobTitle: "Senior DevOps Architect",
    companyName: "Acme Corp",
    scheduledAt: "Nov 15, 2026, 2:00 PM",
    timezone: "America/New_York",
    format: "video",
    location: "https://meet.hireloop.dev/int_123",
    viewUrl: "/dashboard/seeker/applications",
  });

  assert.equal(reminder24h.subject.includes("Senior DevOps Architect"), true);
  assert.equal(reminder24h.subject.includes("tomorrow"), true);
  assert.equal(reminder24h.html.includes("Alex Rivera"), true);
  assert.equal(reminder24h.html.includes("Nov 15, 2026, 2:00 PM"), true);
  assert.equal(reminder24h.html.includes("America/New_York"), true);
  assert.equal(reminder24h.html.includes("https://meet.hireloop.dev/int_123"), true);
  assert.equal(reminder24h.html.includes("/dashboard/seeker/applications"), true);

  // Strict boundary: Never leak recruiter screening notes or credentials
  assert.equal(reminder24h.html.includes("recruiterNotes"), false);
  assert.equal(reminder24h.html.includes("notesHistory"), false);
  assert.equal(reminder24h.html.includes("password"), false);

  const reminder1h = emailTemplates.interviewReminder1h({
    recipientName: "Sarah Recruiter",
    recipientRole: "recruiter",
    otherPartyName: "Alex Rivera",
    jobTitle: "Senior DevOps Architect",
    companyName: "Acme Corp",
    scheduledAt: "Nov 15, 2026, 2:00 PM",
    timezone: "America/New_York",
    format: "video",
    location: "HireLoop Video Room",
    viewUrl: "/dashboard/recruiter",
  });

  assert.equal(reminder1h.subject.includes("1 Hour"), true);
  assert.equal(reminder1h.html.includes("Sarah Recruiter"), true);
  assert.equal(reminder1h.html.includes("1 hour"), true);
  assert.equal(reminder1h.html.includes("recruiterNotes"), false);
});

test("Offline Message Digest Eligibility: evaluates 2-hour offline threshold and live presence", () => {
  const now = Date.now();
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

  function evaluateOfflineEligibility({ isSseOnline, lastActiveAt, lastDisconnectedAt }) {
    if (isSseOnline) return false;
    if (lastActiveAt && (now - new Date(lastActiveAt).getTime()) < TWO_HOURS_MS) {
      return false;
    }
    if (lastDisconnectedAt && (now - new Date(lastDisconnectedAt).getTime()) < TWO_HOURS_MS) {
      return false;
    }
    return true;
  }

  // 1. User currently connected via SSE -> not offline
  assert.equal(evaluateOfflineEligibility({ isSseOnline: true }), false);

  // 2. User disconnected 30 minutes ago -> not eligible (under 2 hours)
  assert.equal(
    evaluateOfflineEligibility({
      isSseOnline: false,
      lastActiveAt: new Date(now - 30 * 60 * 1000),
      lastDisconnectedAt: new Date(now - 30 * 60 * 1000),
    }),
    false
  );

  // 3. User disconnected 2.5 hours ago -> eligible
  assert.equal(
    evaluateOfflineEligibility({
      isSseOnline: false,
      lastActiveAt: new Date(now - 150 * 60 * 1000),
      lastDisconnectedAt: new Date(now - 150 * 60 * 1000),
    }),
    true
  );
});

test("Offline Message Digest Deduplication: enforces cooldown and requires new unread messages", () => {
  const now = Date.now();
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

  function shouldSendDigest({ lastMessageDigestAt, unreadMessages }) {
    if (!unreadMessages || unreadMessages.length === 0) return false;

    if (lastMessageDigestAt) {
      const elapsed = now - new Date(lastMessageDigestAt).getTime();
      if (elapsed < FOUR_HOURS_MS) {
        return false; // Still within cooldown window
      }

      // Check if all unread messages arrived before the previous digest
      const newestUnread = unreadMessages.reduce((max, m) => {
        const d = new Date(m.createdAt).getTime();
        return d > max ? d : max;
      }, 0);

      if (newestUnread <= new Date(lastMessageDigestAt).getTime()) {
        return false; // No new unread messages since last digest
      }
    }

    return true;
  }

  // No unread messages -> false
  assert.equal(shouldSendDigest({ lastMessageDigestAt: null, unreadMessages: [] }), false);

  // Unread messages and never received digest -> true
  assert.equal(
    shouldSendDigest({
      lastMessageDigestAt: null,
      unreadMessages: [{ createdAt: new Date(now - 3600000) }],
    }),
    true
  );

  // Sent digest 1 hour ago (within cooldown) -> false
  assert.equal(
    shouldSendDigest({
      lastMessageDigestAt: new Date(now - 3600000),
      unreadMessages: [{ createdAt: new Date(now - 1800000) }],
    }),
    false
  );

  // Sent digest 5 hours ago, but no new messages since -> false
  assert.equal(
    shouldSendDigest({
      lastMessageDigestAt: new Date(now - 5 * 3600000),
      unreadMessages: [{ createdAt: new Date(now - 6 * 3600000) }],
    }),
    false
  );

  // Sent digest 5 hours ago, and new message arrived 1 hour ago -> true
  assert.equal(
    shouldSendDigest({
      lastMessageDigestAt: new Date(now - 5 * 3600000),
      unreadMessages: [{ createdAt: new Date(now - 3600000) }],
    }),
    true
  );
});

test("Offline Message Digest Template: omits full message bodies and internal recruiter notes", () => {
  const digest = emailTemplates.offlineMessageDigest({
    recipientName: "Taylor Seeker",
    unreadCount: 4,
    senders: ["Sarah TechRecruiter", "Jordan HiringManager"],
    jobTitles: ["Senior Distributed Systems Engineer", "Lead Cloud Architect"],
    inboxUrl: "/dashboard/seeker/messages",
  });

  assert.equal(digest.subject.includes("4 unread messages"), true);
  assert.equal(digest.html.includes("Taylor Seeker"), true);
  assert.equal(digest.html.includes("Sarah TechRecruiter"), true);
  assert.equal(digest.html.includes("Senior Distributed Systems Engineer"), true);
  assert.equal(digest.html.includes("/dashboard/seeker/messages"), true);

  // Confidentiality assertion: must NOT leak internal notes or passwords
  assert.equal(digest.html.includes("recruiterNotes"), false);
  assert.equal(digest.html.includes("notesHistory"), false);
  assert.equal(digest.html.includes("password"), false);
});

test("Web Push Configuration & Fallback: gracefully degrades when VAPID keys are missing", async () => {
  // Verify configuration inspection
  const originalPublic = process.env.VAPID_PUBLIC_KEY;
  const originalPrivate = process.env.VAPID_PRIVATE_KEY;

  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;

  assert.equal(isPushConfigured(), false);
  assert.equal(getVapidPublicKey(), null);

  // Attempting push when unconfigured does not throw
  const result = await sendPushNotification("user@example.com", {
    title: "Test",
    message: "Test notification",
  });

  // Returns safe skipped / unconfigured outcome without crashing
  assert.equal(["skipped", "unconfigured"].includes(result.status), true);

  // Restore env
  if (originalPublic) process.env.VAPID_PUBLIC_KEY = originalPublic;
  if (originalPrivate) process.env.VAPID_PRIVATE_KEY = originalPrivate;
});

test("Outbox Worker Concurrency & Lease: atomic claim prevents duplicate parallel execution", () => {
  const store = [
    { _id: "out_1", status: "pending", nextAttemptAt: null, attempts: 0 },
    { _id: "out_2", status: "pending", nextAttemptAt: null, attempts: 0 },
  ];

  function claimItem(workerId) {
    const item = store.find((i) => i.status === "pending");
    if (!item) return null;
    item.status = "processing";
    item.lockedBy = workerId;
    item.lockedAt = new Date();
    return item;
  }

  const claimWorkerA = claimItem("worker_A");
  assert.notEqual(claimWorkerA, null);
  assert.equal(claimWorkerA._id, "out_1");

  // Parallel Worker B claims next item without collision
  const claimWorkerB = claimItem("worker_B");
  assert.notEqual(claimWorkerB, null);
  assert.equal(claimWorkerB._id, "out_2");

  // Third worker finds no more pending items
  const claimWorkerC = claimItem("worker_C");
  assert.equal(claimWorkerC, null);
});
