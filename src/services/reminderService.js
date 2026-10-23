/**
 * Persistent Interview Reminder Scheduler & Service for HireLoop
 * Schedules, updates, invalidates, and dispatches 24-hour and 1-hour interview reminders
 * with atomic claiming across multiple backend instances.
 */

import { getDb, toObjectId } from "../db.js";
import { createNotification } from "./notificationService.js";
import { generateGoogleCalendarUrl } from "./calendarService.js";

const WORKER_ID = `reminder_${process.pid}_${Math.random().toString(36).substring(2, 7)}`;
const LEASE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min lease before recovering interrupted tasks
const STALE_THRESHOLD_MS = 15 * 60 * 1000; // Do not send reminder if interview started or passed

export const ELIGIBLE_REMINDER_STATUSES = ["Confirmed", "Rescheduled", "Proposed"];

/**
 * Calculates due dates for 24h and 1h reminders given a scheduledAt timestamp.
 */
export function calculateReminderDeadlines(scheduledAt) {
  const interviewTime = new Date(scheduledAt).getTime();
  if (isNaN(interviewTime)) return null;

  return {
    "24h": new Date(interviewTime - 24 * 60 * 60 * 1000),
    "1h": new Date(interviewTime - 1 * 60 * 60 * 1000),
  };
}

/**
 * Schedules durable 24h and 1h reminders for an interview appointment.
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

  let db;
  try {
    db = getDb();
  } catch {
    return [];
  }

  const interviewId = (interview._id || interview.id || "interview").toString();

  const deadlines = calculateReminderDeadlines(interviewDate);
  if (!deadlines) return [];

  // Version identifier based on scheduled timestamp to distinguish reschedules
  const scheduleVersion = interviewDate.getTime();

  const recipients = [
    {
      email: interview.seekerEmail,
      role: "seeker",
      name: interview.seekerName || "Candidate",
      otherName: interview.companyName || interview.recruiterName || "Recruiter",
    },
    {
      email: interview.recruiterEmail,
      role: "recruiter",
      name: interview.recruiterName || "Recruiter",
      otherName: interview.seekerName || "Candidate",
    },
  ].filter((r) => Boolean(r.email));

  const scheduledDocs = [];

  for (const offset of ["24h", "1h"]) {
    const dueAt = deadlines[offset];

    // Only schedule if dueAt is in the future (or within a 5-min grace window if appointment created recently)
    if (dueAt.getTime() <= now.getTime() - 5 * 60 * 1000) {
      continue;
    }

    for (const recipient of recipients) {
      const idempotencyKey = `reminder_${interviewId}_${offset}_${recipient.email.toLowerCase()}_${scheduleVersion}`;

      const reminderDoc = {
        interviewId,
        applicationId: interview.applicationId,
        jobId: interview.jobId,
        jobTitle: interview.jobTitle,
        companyName: interview.companyName,
        recipientEmail: recipient.email.toLowerCase().trim(),
        recipientRole: recipient.role,
        recipientName: recipient.name,
        otherPartyName: recipient.otherName,
        offset, // "24h" | "1h"
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
  }

  return scheduledDocs;
}

/**
 * Invalidates (cancels or supersedes) all pending reminders for a given interview.
 */
export async function invalidateInterviewReminders(interviewId, reason = "canceled") {
  if (!interviewId) return 0;
  const db = getDb();
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
    // Atomic lease acquisition: find a pending due reminder or a timed-out processing reminder
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
      break; // No more due reminders in this batch
    }

    try {
      // Re-verify authoritative interview record from MongoDB
      const interviewObjectId = toObjectId(reminder.interviewId);
      const currentInterview = interviewObjectId
        ? await db.collection("interviews").findOne({ _id: interviewObjectId })
        : null;

      // Ineligibility checks:
      // 1. Interview deleted, canceled, or completed
      if (!currentInterview || ["Canceled", "Completed"].includes(currentInterview.status)) {
        await db.collection("scheduled_reminders").updateOne(
          { _id: reminder._id },
          { $set: { status: "canceled", completedAt: new Date(), updatedAt: new Date() } }
        );
        continue;
      }

      // 2. Interview rescheduled (version mismatch)
      const currentVersion = new Date(currentInterview.scheduledAt).getTime();
      if (currentVersion !== reminder.scheduleVersion) {
        await db.collection("scheduled_reminders").updateOne(
          { _id: reminder._id },
          { $set: { status: "superseded", completedAt: new Date(), updatedAt: new Date() } }
        );
        continue;
      }

      // 3. Staleness check: If interview start time has already passed or started
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

      const templateType = reminder.offset === "24h" ? "interviewReminder24h" : "interviewReminder1h";
      const scheduledAtStr = new Date(currentVersion).toLocaleString("en-US", {
        timeZone: reminder.timezone || "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      });

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

      const title = reminder.offset === "24h"
        ? `Interview Reminder (Tomorrow): ${reminder.jobTitle}`
        : `Interview Starting in 1 Hour: ${reminder.jobTitle}`;

      const message = reminder.offset === "24h"
        ? `Your interview for "${reminder.jobTitle}" is scheduled tomorrow at ${scheduledAtStr} (${reminder.timezone}).`
        : `Your interview for "${reminder.jobTitle}" is starting in approximately 1 hour at ${scheduledAtStr} (${reminder.timezone}).`;

      // Dispatch In-App Notification and queue Transactional Email
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
        sendEmail: true,
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
