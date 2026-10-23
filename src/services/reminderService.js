/**
 * Persistent Interview Reminder Scheduler & Service for HireLoop
 * Schedules, updates, invalidates, and dispatches interview reminders with configurable
 * lead times (48h, 24h, 12h, 2h, 1h) and atomic claiming across multiple backend instances.
 */

import { getDb, toObjectId } from "../db.js";
import { createNotification } from "./notificationService.js";
import { generateGoogleCalendarUrl } from "./calendarService.js";
import { getUserPreferences, shouldDeliverEmail } from "./preferenceService.js";

const WORKER_ID = `reminder_${process.pid}_${Math.random().toString(36).substring(2, 7)}`;
const LEASE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min lease before recovering interrupted tasks

export const ELIGIBLE_REMINDER_STATUSES = ["Confirmed", "Rescheduled", "Proposed"];

export const OFFSET_TO_MS = {
  "48h": 48 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "2h": 2 * 60 * 60 * 1000,
  "1h": 1 * 60 * 60 * 1000,
};

export const OFFSET_LABELS = {
  "48h": "48 Hours",
  "24h": "24 Hours",
  "12h": "12 Hours",
  "2h": "2 Hours",
  "1h": "1 Hour",
};

/**
 * Calculates due dates for given reminder lead times relative to a scheduledAt timestamp.
 */
export function calculateReminderDeadlines(scheduledAt, leadTimes = Object.keys(OFFSET_TO_MS)) {
  const interviewTime = new Date(scheduledAt).getTime();
  if (isNaN(interviewTime)) return null;

  const result = {};
  for (const lt of leadTimes) {
    if (OFFSET_TO_MS[lt]) {
      result[lt] = new Date(interviewTime - OFFSET_TO_MS[lt]);
    }
  }
  return result;
}

/**
 * Schedules durable reminders for a specific recipient matching their custom lead time preferences.
 */
export async function scheduleInterviewRemindersForRecipient(interview, recipientEmail, leadTimes = ["24h", "1h"]) {
  if (!interview || !interview.scheduledAt || !recipientEmail) return [];

  let db;
  try {
    db = getDb();
  } catch {
    return [];
  }

  const interviewDate = new Date(interview.scheduledAt);
  const now = new Date();
  if (interviewDate.getTime() <= now.getTime()) {
    return [];
  }

  const interviewId = (interview._id || interview.id || "interview").toString();
  const scheduleVersion = interviewDate.getTime();
  const normalizedEmail = recipientEmail.toLowerCase().trim();

  const isSeeker = normalizedEmail === (interview.seekerEmail || "").toLowerCase().trim();
  const role = isSeeker ? "seeker" : "recruiter";
  const name = isSeeker ? (interview.seekerName || "Candidate") : (interview.recruiterName || "Recruiter");
  const otherName = isSeeker
    ? (interview.companyName || interview.recruiterName || "Recruiter")
    : (interview.seekerName || "Candidate");

  const deadlines = calculateReminderDeadlines(interviewDate, leadTimes);
  if (!deadlines) return [];

  const scheduledDocs = [];

  for (const offset of leadTimes) {
    const dueAt = deadlines[offset];
    if (!dueAt) continue;

    // Only schedule if dueAt is in the future (or within a 5-min grace window if appointment created recently)
    if (dueAt.getTime() <= now.getTime() - 5 * 60 * 1000) {
      continue;
    }

    const idempotencyKey = `reminder_${interviewId}_${offset}_${normalizedEmail}_${scheduleVersion}`;

    const reminderDoc = {
      interviewId,
      applicationId: interview.applicationId,
      jobId: interview.jobId,
      jobTitle: interview.jobTitle,
      companyName: interview.companyName,
      recipientEmail: normalizedEmail,
      recipientRole: role,
      recipientName: name,
      otherPartyName: otherName,
      offset, // e.g. "48h", "24h", "12h", "2h", "1h"
      scheduledInterviewAt: interviewDate,
      scheduleVersion,
      timezone: interview.timezone || "UTC",
      format: interview.format || "video",
      location: interview.location || "",
      dueAt,
      status: "pending", // "pending" | "processing" | "completed" | "canceled" | "superseded" | "skipped" | "failed"
      attempts: 0,
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
      idempotencyKey,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      await db.collection("scheduled_reminders").updateOne(
        { idempotencyKey },
        { $setOnInsert: reminderDoc },
        { upsert: true }
      );
      scheduledDocs.push(reminderDoc);
    } catch (err) {
      if (err.code !== 11000) {
        console.error(`[ReminderService] Error scheduling reminder for ${idempotencyKey}:`, err.message);
      }
    }
  }

  return scheduledDocs;
}

/**
 * Schedules durable reminders for all participants in an interview appointment,
 * respecting each participant's customized notification preferences.
 */
export async function scheduleInterviewReminders(interview) {
  if (!interview || !interview.scheduledAt) return [];

  // If status is terminal or ineligible, do not schedule reminders
  if (["Canceled", "Completed"].includes(interview.status)) {
    return [];
  }

  const interviewDate = new Date(interview.scheduledAt);
  const now = new Date();

  // If interview is already in the past, skip
  if (interviewDate.getTime() <= now.getTime()) {
    return [];
  }

  const recipients = [
    interview.seekerEmail,
    interview.recruiterEmail,
  ].filter(Boolean);

  const scheduledDocs = [];

  for (const email of recipients) {
    try {
      const { preferences } = await getUserPreferences(email);
      if (preferences.reminders.interviewReminders === false) {
        continue; // User opted out of interview reminders
      }
      const leadTimes = preferences.reminders.reminderLeadTimes || ["24h", "1h"];
      const docs = await scheduleInterviewRemindersForRecipient(interview, email, leadTimes);
      scheduledDocs.push(...docs);
    } catch {
      // Fallback to default lead times
      const docs = await scheduleInterviewRemindersForRecipient(interview, email, ["24h", "1h"]);
      scheduledDocs.push(...docs);
    }
  }

  return scheduledDocs;
}

/**
 * Reconciles future interview reminders when a user updates their reminder lead times or toggle.
 * Supersedes obsolete pending reminders and schedules new ones matching updated preferences.
 */
export async function reconcileUserReminderPreferences(userEmail) {
  if (!userEmail) return 0;
  const normalizedEmail = userEmail.toLowerCase().trim();

  let db;
  try {
    db = getDb();
  } catch {
    return 0;
  }

  const { preferences } = await getUserPreferences(normalizedEmail);
  const now = new Date();

  // Find all future active interviews where user is a participant
  const futureInterviews = await db.collection("interviews").find({
    $or: [{ seekerEmail: normalizedEmail }, { recruiterEmail: normalizedEmail }],
    scheduledAt: { $gt: now },
    status: { $in: ["Confirmed", "Rescheduled", "Proposed"] },
  }).toArray();

  if (!futureInterviews.length) return 0;

  let reconciledCount = 0;

  for (const interview of futureInterviews) {
    const interviewId = (interview._id || interview.id).toString();

    // 1. Invalidate existing pending reminders for this user
    await db.collection("scheduled_reminders").updateMany(
      {
        interviewId,
        recipientEmail: normalizedEmail,
        status: { $in: ["pending", "processing"] },
      },
      {
        $set: {
          status: "superseded",
          invalidationReason: "preference_updated",
          updatedAt: now,
        },
      }
    );

    // 2. If reminders are enabled, schedule new ones matching the updated lead times
    if (preferences.reminders.interviewReminders !== false) {
      const leadTimes = preferences.reminders.reminderLeadTimes || ["24h", "1h"];
      await scheduleInterviewRemindersForRecipient(interview, normalizedEmail, leadTimes);
      reconciledCount++;
    }
  }

  return reconciledCount;
}

/**
 * Invalidates (cancels or supersedes) all pending reminders for a given interview.
 */
export async function invalidateInterviewReminders(interviewId, reason = "canceled") {
  if (!interviewId) return 0;
  let db;
  try {
    db = getDb();
  } catch {
    return 0;
  }

  const idStr = interviewId.toString();
  const targetStatus = reason === "rescheduled" ? "superseded" : "canceled";

  const result = await db.collection("scheduled_reminders").updateMany(
    {
      interviewId: idStr,
      status: { $in: ["pending", "processing"] },
    },
    {
      $set: {
        status: targetStatus,
        invalidationReason: reason,
        updatedAt: new Date(),
      },
    }
  );

  return result.modifiedCount;
}

/**
 * Atomically claims and dispatches due interview reminders.
 */
export async function processDueReminders(limit = 10) {
  let db;
  try {
    db = getDb();
  } catch {
    return 0;
  }

  const now = new Date();
  let processedCount = 0;

  for (let i = 0; i < limit; i++) {
    const claimFilter = {
      $or: [
        {
          status: "pending",
          dueAt: { $lte: now },
        },
        {
          status: "processing",
          lockedAt: { $lte: new Date(now.getTime() - LEASE_TIMEOUT_MS) },
        },
      ],
    };

    const reminder = await db.collection("scheduled_reminders").findOneAndUpdate(
      claimFilter,
      {
        $set: {
          status: "processing",
          lockedAt: now,
          lockedBy: WORKER_ID,
          updatedAt: now,
        },
      },
      { returnDocument: "after" }
    );

    if (!reminder) {
      break;
    }

    try {
      // Re-verify authoritative interview record from MongoDB
      const interviewObjectId = toObjectId(reminder.interviewId);
      const currentInterview = interviewObjectId
        ? await db.collection("interviews").findOne({ _id: interviewObjectId })
        : null;

      // Ineligibility checks:
      if (!currentInterview || ["Canceled", "Completed"].includes(currentInterview.status)) {
        await db.collection("scheduled_reminders").updateOne(
          { _id: reminder._id },
          { $set: { status: "canceled", completedAt: new Date(), updatedAt: new Date() } }
        );
        continue;
      }

      // Interview rescheduled (version mismatch)
      const currentVersion = new Date(currentInterview.scheduledAt).getTime();
      if (currentVersion !== reminder.scheduleVersion) {
        await db.collection("scheduled_reminders").updateOne(
          { _id: reminder._id },
          { $set: { status: "superseded", completedAt: new Date(), updatedAt: new Date() } }
        );
        continue;
      }

      // Staleness check: If interview start time has already passed or started
      if (now.getTime() >= currentVersion) {
        await db.collection("scheduled_reminders").updateOne(
          { _id: reminder._id },
          { $set: { status: "skipped", note: "Stale: Interview has already started or passed", completedAt: new Date(), updatedAt: new Date() } }
        );
        continue;
      }

      // Prepare calendar URL
      const interviewEnd = currentInterview.endAt || new Date(currentVersion + (currentInterview.durationMinutes || 45) * 60000);
      const googleCalUrl = generateGoogleCalendarUrl({
        title: `Interview: ${reminder.jobTitle} with ${reminder.companyName}`,
        description: `HireLoop Interview Reminder (${reminder.offset})\nPosition: ${reminder.jobTitle}\nFormat: ${reminder.format}\nLocation: ${reminder.location}`,
        location: reminder.location,
        startDate: new Date(currentVersion),
        endDate: new Date(interviewEnd),
      });

      const templateType = reminder.offset === "24h"
        ? "interviewReminder24h"
        : (reminder.offset === "1h" ? "interviewReminder1h" : "interviewReminder24h");

      const scheduledAtStr = new Date(currentVersion).toLocaleString("en-US", {
        timeZone: reminder.timezone || "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      });

      const label = OFFSET_LABELS[reminder.offset] || `${reminder.offset}`;

      const templateData = {
        recipientName: reminder.recipientName,
        recipientRole: reminder.recipientRole,
        otherPartyName: reminder.otherPartyName,
        jobTitle: reminder.jobTitle,
        companyName: reminder.companyName,
        scheduledAt: scheduledAtStr,
        timezone: reminder.timezone,
        format: reminder.format,
        location: reminder.location,
        calendarUrl: googleCalUrl,
        viewUrl: `/dashboard/${reminder.recipientRole === "recruiter" ? "recruiter" : "seeker/applications"}`,
      };

      const title = `Interview Reminder (${label}): ${reminder.jobTitle}`;
      const message = `Your interview for "${reminder.jobTitle}" is scheduled in approximately ${label} at ${scheduledAtStr} (${reminder.timezone}).`;

      // Check current email delivery preferences at send time
      const emailCheck = await shouldDeliverEmail(reminder.recipientEmail, templateType);

      // Dispatch In-App Notification (and transactional email if allowed by user preferences)
      await createNotification({
        recipientEmail: reminder.recipientEmail,
        role: reminder.recipientRole,
        type: `interview_reminder_${reminder.offset}`,
        title,
        message,
        link: templateData.viewUrl,
        referenceId: reminder.interviewId,
        referenceType: "interview",
        idempotencyKey: `notif_${reminder.idempotencyKey}`,
        sendEmail: emailCheck.deliver,
        emailTemplate: templateType,
        emailData: templateData,
      });

      // Mark reminder completed
      await db.collection("scheduled_reminders").updateOne(
        { _id: reminder._id },
        {
          $set: {
            status: "completed",
            completedAt: new Date(),
            updatedAt: new Date(),
          },
          $inc: { attempts: 1 },
        }
      );

      processedCount++;
    } catch (err) {
      console.error(`[ReminderService] Error executing reminder ${reminder._id}:`, err.message);
      await db.collection("scheduled_reminders").updateOne(
        { _id: reminder._id },
        {
          $set: {
            status: reminder.attempts >= 2 ? "failed" : "pending",
            lastError: err.message,
            updatedAt: new Date(),
          },
          $inc: { attempts: 1 },
        }
      );
    }
  }

  return processedCount;
}
