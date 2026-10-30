/**
 * Interviewer Availability & Conflict Prevention Service for HireLoop
 * Implements weekly recurring working hours, date-specific overrides,
 * timezone-aware interval evaluation, and atomic conflict checking.
 */

import { getDb, toObjectId } from "../db.js";

// Standard interval: [start, end) start-inclusive, end-exclusive
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Validates an IANA timezone string.
 */
export function isValidTimezone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a single weekly availability block.
 */
export function validateWeeklyBlock(block, idx = 0) {
  if (!block || typeof block !== "object") {
    throw new Error(`Weekly availability block at index ${idx} must be an object.`);
  }

  const dayOfWeek = Number(block.dayOfWeek);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new Error(`Invalid dayOfWeek "${block.dayOfWeek}" at index ${idx}. Must be an integer 0-6.`);
  }

  const startTime = (block.startTime || "").trim();
  const endTime = (block.endTime || "").trim();

  if (!TIME_REGEX.test(startTime)) {
    throw new Error(`Invalid startTime "${startTime}" at index ${idx}. Must be HH:mm (24-hour format).`);
  }
  if (!TIME_REGEX.test(endTime)) {
    throw new Error(`Invalid endTime "${endTime}" at index ${idx}. Must be HH:mm (24-hour format).`);
  }

  if (startTime >= endTime) {
    throw new Error(`startTime "${startTime}" must be earlier than endTime "${endTime}" at index ${idx}.`);
  }

  return { dayOfWeek, startTime, endTime };
}

/**
 * Validates a date-specific override exception.
 */
export function validateException(exc, idx = 0) {
  if (!exc || typeof exc !== "object") {
    throw new Error(`Exception at index ${idx} must be an object.`);
  }

  const dateStr = (exc.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid exception date "${dateStr}" at index ${idx}. Must be YYYY-MM-DD.`);
  }

  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date "${dateStr}" at index ${idx}.`);
  }

  const unavailable = exc.unavailable !== false;
  const reason = (exc.reason || "").trim().substring(0, 150);

  let startTime = null;
  let endTime = null;

  if (!unavailable && (exc.startTime || exc.endTime)) {
    startTime = (exc.startTime || "").trim();
    endTime = (exc.endTime || "").trim();
    if (!TIME_REGEX.test(startTime) || !TIME_REGEX.test(endTime) || startTime >= endTime) {
      throw new Error(`Exception for date "${dateStr}" has invalid time window (${startTime} - ${endTime}).`);
    }
  }

  return {
    date: dateStr,
    unavailable,
    startTime,
    endTime,
    reason,
  };
}

/**
 * Retrieves an interviewer's configured availability profile.
 */
export async function getInterviewerAvailability(userEmail) {
  if (!userEmail) return null;
  const db = getDb();
  const normalizedEmail = userEmail.toLowerCase().trim();

  return await db.collection("interviewer_availabilities").findOne({
    userEmail: normalizedEmail,
  });
}

/**
 * Upserts an interviewer's availability profile.
 */
export async function setInterviewerAvailability(userEmail, { timezone, weeklyHours = [], exceptions = [] }) {
  if (!userEmail) throw new Error("userEmail is required.");
  const normalizedEmail = userEmail.toLowerCase().trim();

  const validatedTz = timezone ? timezone.trim() : "UTC";
  if (!isValidTimezone(validatedTz)) {
    throw new Error(`Invalid timezone identifier "${timezone}". Must be a valid IANA timezone string.`);
  }

  const validatedWeekly = (Array.isArray(weeklyHours) ? weeklyHours : []).map(validateWeeklyBlock);
  const validatedExceptions = (Array.isArray(exceptions) ? exceptions : []).map(validateException);

  const db = getDb();
  const doc = {
    userEmail: normalizedEmail,
    timezone: validatedTz,
    weeklyHours: validatedWeekly,
    exceptions: validatedExceptions,
    updatedAt: new Date(),
  };

  const result = await db.collection("interviewer_availabilities").findOneAndUpdate(
    { userEmail: normalizedEmail },
    {
      $set: doc,
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: "after" }
  );

  return result;
}

/**
 * Checks whether a proposed UTC time interval [startDate, endDate) falls inside
 * the interviewer's configured working hours and is free of date exceptions.
 * Returns: { status: "available" | "unavailable" | "unknown", reason?: string }
 */
export function checkSlotAvailability(availability, startDate, endDate) {
  if (!availability || !Array.isArray(availability.weeklyHours) || availability.weeklyHours.length === 0) {
    return { status: "unknown", reason: "no_availability_configured" };
  }

  const tz = availability.timezone || "UTC";
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
    return { status: "unavailable", reason: "invalid_interval" };
  }

  // Format dates in interviewer's configured local timezone
  const dateOptions = { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" };
  const timeOptions = { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false };
  const weekdayOptions = { timeZone: tz, weekday: "short" };

  const startFormatter = new Intl.DateTimeFormat("en-US", { ...dateOptions, ...timeOptions, ...weekdayOptions });
  const startParts = startFormatter.formatToParts(start);
  const endParts = startFormatter.formatToParts(end);

  const getPart = (parts, type) => parts.find((p) => p.type === type)?.value;

  const year = getPart(startParts, "year");
  const month = getPart(startParts, "month");
  const day = getPart(startParts, "day");
  const startHour = getPart(startParts, "hour");
  const startMin = getPart(startParts, "minute");

  const endHour = getPart(endParts, "hour");
  const endMin = getPart(endParts, "minute");

  const localDateStr = `${year}-${month}-${day}`;
  const localStartTime = `${startHour}:${startMin}`;
  const localEndTime = `${endHour}:${endMin}`;

  // Check date-specific overrides
  if (Array.isArray(availability.exceptions)) {
    const exc = availability.exceptions.find((e) => e.date === localDateStr);
    if (exc) {
      if (exc.unavailable) {
        return { status: "unavailable", reason: "date_exception_unavailable" };
      }
      if (exc.startTime && exc.endTime) {
        if (localStartTime >= exc.startTime && localEndTime <= exc.endTime) {
          return { status: "available", reason: "date_exception_window" };
        }
        return { status: "unavailable", reason: "outside_exception_window" };
      }
    }
  }

  // Calculate day of week index (0=Sun, 1=Mon, ..., 6=Sat) in local timezone
  const localDayOfWeek = new Date(start.toLocaleString("en-US", { timeZone: tz })).getDay();

  // Find matching weekly availability windows for this day of week
  const matchingWindows = availability.weeklyHours.filter((w) => w.dayOfWeek === localDayOfWeek);
  if (matchingWindows.length === 0) {
    return { status: "unavailable", reason: "outside_working_days" };
  }

  // Check if interval fits inside any window
  const fitsAnyWindow = matchingWindows.some(
    (w) => localStartTime >= w.startTime && localEndTime <= w.endTime
  );

  if (fitsAnyWindow) {
    return { status: "available" };
  }

  return { status: "unavailable", reason: "outside_working_hours" };
}

/**
 * Searches for overlapping scheduled appointments for candidate and interviewers.
 * Interval rule: [startTime, endTime) start-inclusive, end-exclusive.
 * Active statuses considered blocking: ["Proposed", "Confirmed", "Rescheduled"].
 */
export async function findInterviewConflicts({
  interviewers = [],
  seekerEmail,
  startDate,
  endDate,
  excludeInterviewId = null,
}) {
  const db = getDb();
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
    throw new Error("Invalid start or end date interval.");
  }

  const activeStatuses = ["Proposed", "Confirmed", "Rescheduled"];

  // Normalize interviewer emails
  const interviewerEmails = (interviewers || [])
    .map((i) => (typeof i === "string" ? i : i.email)?.toLowerCase().trim())
    .filter(Boolean);

  const normalizedSeekerEmail = (seekerEmail || "").toLowerCase().trim();

  // Overlap condition: appointmentStart < end AND appointmentEnd > start
  const overlapFilter = {
    status: { $in: activeStatuses },
    scheduledAt: { $lt: end },
    endAt: { $gt: start },
  };

  if (excludeInterviewId) {
    const excludeObjId = toObjectId(excludeInterviewId);
    if (excludeObjId) {
      overlapFilter._id = { $ne: excludeObjId };
    }
  }

  // Find candidate conflict
  const candidateConflict = normalizedSeekerEmail
    ? await db.collection("interviews").findOne({
        ...overlapFilter,
        seekerEmail: new RegExp(`^${normalizedSeekerEmail}$`, "i"),
      })
    : null;

  // Find conflicts across each interviewer
  const interviewerConflicts = [];

  for (const email of interviewerEmails) {
    const existing = await db.collection("interviews").findOne({
      ...overlapFilter,
      $or: [
        { recruiterEmail: new RegExp(`^${email}$`, "i") },
        {
          interviewers: {
            $elemMatch: {
              email: new RegExp(`^${email}$`, "i"),
              responseStatus: { $nin: ["Declined", "Removed"] },
            },
          },
        },
      ],
    });

    if (existing) {
      interviewerConflicts.push({
        email,
        conflictStart: existing.scheduledAt,
        conflictEnd: existing.endAt,
        interviewId: existing._id.toString(),
      });
    }
  }

  const hasConflict = Boolean(candidateConflict) || interviewerConflicts.length > 0;

  return {
    hasConflict,
    candidateConflict: candidateConflict
      ? {
          email: normalizedSeekerEmail,
          conflictStart: candidateConflict.scheduledAt,
          conflictEnd: candidateConflict.endAt,
          interviewId: candidateConflict._id.toString(),
        }
      : null,
    interviewerConflicts,
  };
}

/**
 * Comprehensive pre-flight coordinator check for panel scheduling:
 * Evaluates declared availability AND active booking conflicts for all participants.
 */
export async function validateSlotConflictAndAvailability({
  interviewers = [],
  seekerEmail,
  startDate,
  endDate,
  excludeInterviewId = null,
}) {
  const start = new Date(startDate);
  const end = new Date(endDate);

  // 1. Conflict check against booked interviews
  const conflicts = await findInterviewConflicts({
    interviewers,
    seekerEmail,
    startDate: start,
    endDate: end,
    excludeInterviewId,
  });

  // 2. Availability profiles check
  const availabilityReport = [];
  const conflictedEmailSet = new Set(conflicts.interviewerConflicts.map((c) => c.email.toLowerCase()));

  for (const item of interviewers) {
    const email = (typeof item === "string" ? item : item.email)?.toLowerCase().trim();
    if (!email) continue;

    const isBooked = conflictedEmailSet.has(email);
    if (isBooked) {
      availabilityReport.push({
        email,
        status: "conflict",
        reason: "already_booked_interview",
      });
      continue;
    }

    const availProfile = await getInterviewerAvailability(email);
    const slotStatus = checkSlotAvailability(availProfile, start, end);

    availabilityReport.push({
      email,
      status: slotStatus.status, // "available" | "unavailable" | "unknown"
      reason: slotStatus.reason || null,
      timezone: availProfile?.timezone || "UTC",
    });
  }

  const allAvailable = availabilityReport.every(
    (a) => a.status === "available" || a.status === "unknown"
  ) && !conflicts.hasConflict;

  return {
    canSchedule: !conflicts.hasConflict,
    hasConflict: conflicts.hasConflict,
    candidateConflict: conflicts.candidateConflict,
    interviewerConflicts: conflicts.interviewerConflicts,
    availabilityReport,
    allAvailable,
  };
}

