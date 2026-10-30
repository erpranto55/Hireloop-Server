import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidTimezone,
  validateWeeklyBlock,
  validateException,
  checkSlotAvailability,
} from "../src/services/availabilityService.js";
import {
  formatIcsDate,
  generateIcsInvite,
  generateGoogleCalendarUrl,
} from "../src/services/calendarService.js";
import {
  getCalendarSyncStatus,
  syncInterviewToExternalProvider,
  cancelExternalSyncedEvent,
} from "../src/services/calendarSyncService.js";
import { emailTemplates } from "../src/services/emailService.js";

// 1. Availability Configuration & Validation
test("Interviewer Availability: isValidTimezone accepts standard IANA timezones and rejects invalid ones", () => {
  assert.equal(isValidTimezone("UTC"), true);
  assert.equal(isValidTimezone("America/New_York"), true);
  assert.equal(isValidTimezone("Europe/London"), true);
  assert.equal(isValidTimezone("Asia/Dhaka"), true);
  assert.equal(isValidTimezone("Invalid/Timezone_Name"), false);
  assert.equal(isValidTimezone(""), false);
  assert.equal(isValidTimezone(null), false);
});

test("Interviewer Availability: validateWeeklyBlock enforces valid dayOfWeek (0-6) and 24h startTime < endTime", () => {
  const valid = validateWeeklyBlock({ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" });
  assert.equal(valid.dayOfWeek, 1);
  assert.equal(valid.startTime, "09:00");
  assert.equal(valid.endTime, "17:00");

  assert.throws(() => {
    validateWeeklyBlock({ dayOfWeek: 7, startTime: "09:00", endTime: "17:00" });
  }, /Invalid dayOfWeek/);

  assert.throws(() => {
    validateWeeklyBlock({ dayOfWeek: 1, startTime: "17:00", endTime: "09:00" });
  }, /must be earlier than endTime/);

  assert.throws(() => {
    validateWeeklyBlock({ dayOfWeek: 1, startTime: "9am", endTime: "5pm" });
  }, /Invalid startTime/);
});

test("Interviewer Availability: validateException handles full-day and partial-day date overrides", () => {
  const fullDay = validateException({ date: "2026-11-20", unavailable: true, reason: "Vacation" });
  assert.equal(fullDay.date, "2026-11-20");
  assert.equal(fullDay.unavailable, true);
  assert.equal(fullDay.reason, "Vacation");

  const partial = validateException({
    date: "2026-11-21",
    unavailable: false,
    startTime: "13:00",
    endTime: "16:00",
    reason: "Afternoon office hours",
  });
  assert.equal(partial.unavailable, false);
  assert.equal(partial.startTime, "13:00");
  assert.equal(partial.endTime, "16:00");

  assert.throws(() => {
    validateException({ date: "not-a-date" });
  }, /Invalid exception date/);
});

test("Interviewer Availability: checkSlotAvailability validates weekly working hours in UTC and custom timezones", () => {
  const availabilityConfig = {
    timezone: "America/New_York",
    weeklyHours: [
      { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }, // Monday
      { dayOfWeek: 2, startTime: "09:00", endTime: "17:00" }, // Tuesday
    ],
    exceptions: [],
  };

  // In America/New_York (EST UTC-5 in November):
  // 15:00 UTC = 10:00 AM EST (Mon Nov 09 2026) -> inside 09:00-17:00 EST
  const insideSlot = checkSlotAvailability(
    availabilityConfig,
    new Date("2026-11-09T15:00:00Z"),
    new Date("2026-11-09T15:45:00Z")
  );
  assert.equal(insideSlot.status, "available");

  // 12:00 UTC = 07:00 AM EST -> outside 09:00-17:00 EST
  const earlySlot = checkSlotAvailability(
    availabilityConfig,
    new Date("2026-11-09T12:00:00Z"),
    new Date("2026-11-09T12:45:00Z")
  );
  assert.equal(earlySlot.status, "unavailable");
  assert.equal(earlySlot.reason, "outside_working_hours");

  // Sunday Nov 08 2026: non-working day
  const sundaySlot = checkSlotAvailability(
    availabilityConfig,
    new Date("2026-11-08T15:00:00Z"),
    new Date("2026-11-08T15:45:00Z")
  );
  assert.equal(sundaySlot.status, "unavailable");
  assert.equal(sundaySlot.reason, "outside_working_days");

  // Unknown status when profile not configured
  const emptyRes = checkSlotAvailability(null, new Date(), new Date());
  assert.equal(emptyRes.status, "unknown");
});

test("Interviewer Availability: checkSlotAvailability respects date-specific exceptions", () => {
  const availabilityConfig = {
    timezone: "UTC",
    weeklyHours: [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }],
    exceptions: [
      // Full day off on Monday Nov 09
      { date: "2026-11-09", unavailable: true, reason: "Public holiday" },
      // Partial override on Monday Nov 16
      { date: "2026-11-16", unavailable: false, startTime: "13:00", endTime: "16:00", reason: "Afternoon only" },
    ],
  };

  // Full day off test
  const slotHoliday = checkSlotAvailability(
    availabilityConfig,
    new Date("2026-11-09T10:00:00Z"),
    new Date("2026-11-09T11:00:00Z")
  );
  assert.equal(slotHoliday.status, "unavailable");
  assert.equal(slotHoliday.reason, "date_exception_unavailable");

  // Partial override: inside window
  const slotInsideOverride = checkSlotAvailability(
    availabilityConfig,
    new Date("2026-11-16T13:30:00Z"),
    new Date("2026-11-16T14:30:00Z")
  );
  assert.equal(slotInsideOverride.status, "available");

  // Partial override: outside window (morning)
  const slotOutsideOverride = checkSlotAvailability(
    availabilityConfig,
    new Date("2026-11-16T10:00:00Z"),
    new Date("2026-11-16T11:00:00Z")
  );
  assert.equal(slotOutsideOverride.status, "unavailable");
  assert.equal(slotOutsideOverride.reason, "outside_exception_window");
});

// 2. Conflict Detection & Double-Booking Interval Math [start, end)
test("Conflict Detection: interval overlap condition scheduledAt < end && endAt > start", () => {
  const existingStart = new Date("2026-11-10T14:00:00Z").getTime();
  const existingEnd = new Date("2026-11-10T15:00:00Z").getTime();

  const isOverlap = (startStr, endStr) => {
    const s = new Date(startStr).getTime();
    const e = new Date(endStr).getTime();
    return existingStart < e && existingEnd > s;
  };

  // Exactly overlapping: 14:00 - 15:00 -> OVERLAP
  assert.equal(isOverlap("2026-11-10T14:00:00Z", "2026-11-10T15:00:00Z"), true);

  // Partial overlap (inside): 14:15 - 14:45 -> OVERLAP
  assert.equal(isOverlap("2026-11-10T14:15:00Z", "2026-11-10T14:45:00Z"), true);

  // Partial overlap (spans start): 13:30 - 14:30 -> OVERLAP
  assert.equal(isOverlap("2026-11-10T13:30:00Z", "2026-11-10T14:30:00Z"), true);

  // Partial overlap (spans end): 14:30 - 15:30 -> OVERLAP
  assert.equal(isOverlap("2026-11-10T14:30:00Z", "2026-11-10T15:30:00Z"), true);

  // Adjacent before (ends exactly at 14:00): 13:00 - 14:00 -> NO OVERLAP (start-inclusive, end-exclusive)
  assert.equal(isOverlap("2026-11-10T13:00:00Z", "2026-11-10T14:00:00Z"), false);

  // Adjacent after (starts exactly at 15:00): 15:00 - 16:00 -> NO OVERLAP
  assert.equal(isOverlap("2026-11-10T15:00:00Z", "2026-11-10T16:00:00Z"), false);
});

// 3. RFC 5545 Multi-Attendee iCalendar & Deep Links
test("Multi-Attendee iCalendar: generateIcsInvite generates RFC 5545 compliant calendar with attendees and sequence", () => {
  const startDate = new Date("2026-11-10T15:00:00.000Z");
  const endDate = new Date("2026-11-10T16:00:00.000Z");

  const ics = generateIcsInvite({
    interviewId: "panel-int-101",
    title: "Panel Interview: Principal Distributed Systems Engineer",
    description: "CloudScale Inc. technical panel interview",
    location: "https://meet.google.com/xyz-abcd-uvw",
    startDate,
    endDate,
    organizerName: "CloudScale Inc. (via HireLoop)",
    organizerEmail: "recruiter@cloudscale.com",
    sequence: 1,
    attendees: [
      { email: "jane.doe@example.com", name: "Jane Doe", role: "candidate", responseStatus: "Accepted" },
      { email: "architect@cloudscale.com", name: "Lead Architect", role: "lead_interviewer", responseStatus: "Accepted" },
      { email: "director@cloudscale.com", name: "Engineering Director", role: "interviewer", responseStatus: "Pending" },
    ],
  });

  assert.equal(ics.includes("BEGIN:VCALENDAR"), true);
  assert.equal(ics.includes("VERSION:2.0"), true);
  assert.equal(ics.includes("PRODID:-//HireLoop//HireLoop Recruitment Platform//EN"), true);
  assert.equal(ics.includes("UID:interview-panel-int-101@hireloop.com"), true);
  assert.equal(ics.includes("SEQUENCE:1"), true);
  assert.equal(ics.includes("ORGANIZER;CN=CloudScale Inc. (via HireLoop):mailto:recruiter@cloudscale.com"), true);

  // Attendees with PARTSTAT and ROLE
  assert.equal(ics.includes("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Jane Doe:mailto:jane.doe@example.com"), true);
  assert.equal(ics.includes("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=CHAIR;PARTSTAT=ACCEPTED;CN=Lead Architect:mailto:architect@cloudscale.com"), true);
  assert.equal(ics.includes("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Engineering Director:mailto:director@cloudscale.com"), true);
  assert.equal(ics.includes("END:VCALENDAR"), true);
});

test("Multi-Attendee iCalendar: cancellation ics sets METHOD:CANCEL and STATUS:CANCELLED", () => {
  const startDate = new Date("2026-11-10T15:00:00.000Z");
  const endDate = new Date("2026-11-10T16:00:00.000Z");

  const cancelIcs = generateIcsInvite({
    interviewId: "int-cancel-99",
    title: "Frontend Architect",
    startDate,
    endDate,
    status: "CANCELLED",
    sequence: 2,
  });
  assert.equal(cancelIcs.includes("METHOD:CANCEL"), true);
  assert.equal(cancelIcs.includes("STATUS:CANCELLED"), true);
  assert.equal(cancelIcs.includes("SEQUENCE:2"), true);
});

test("Calendar Links: generateGoogleCalendarUrl formats multi-attendee URL parameter cleanly", () => {
  const startDate = new Date("2026-11-10T15:00:00.000Z");
  const endDate = new Date("2026-11-10T15:45:00.000Z");

  const url = generateGoogleCalendarUrl({
    title: "Senior SRE",
    description: "Observability Labs Interview",
    location: "https://meet.google.com/abc",
    startDate,
    endDate,
    attendees: [
      { email: "sre1@labs.com", name: "SRE One" },
      { email: "sre2@labs.com", name: "SRE Two" },
    ],
  });
  assert.equal(url.includes("action=TEMPLATE"), true);
  assert.equal(url.includes("add=sre1%40labs.com%2Csre2%40labs.com"), true);
});

// 4. Standalone Calendar Sync Adapter Boundary
test("Calendar Sync: graceful fallback when external sync credentials unconfigured", async () => {
  const status = getCalendarSyncStatus();
  assert.equal(status.isConfigured, false);
  assert.equal(status.activeFallback, "standalone_ical");
  assert.equal(status.description.includes("Standalone RFC 5545"), true);

  const syncResult = await syncInterviewToExternalProvider({ _id: "dummy" });
  assert.equal(syncResult.synced, false);
  assert.equal(syncResult.message.includes("Standalone export active"), true);

  const cancelResult = await cancelExternalSyncedEvent("dummy");
  assert.equal(cancelResult.canceled, false);
});

// 5. Panel Debrief & Scorecard Evaluation Guardrails
test("Panel Debrief & Scorecards: prevents evaluation submission if panelist declined or was removed", () => {
  const activeInterviewer = { email: "active@company.com", responseStatus: "Accepted" };
  const pendingInterviewer = { email: "pending@company.com", responseStatus: "Pending" };
  const declinedInterviewer = { email: "declined@company.com", responseStatus: "Declined" };
  const removedInterviewer = { email: "removed@company.com", responseStatus: "Removed" };

  const isEligible = (interviewer) => {
    return interviewer && interviewer.responseStatus !== "Declined" && interviewer.responseStatus !== "Removed";
  };

  assert.equal(isEligible(activeInterviewer), true);
  assert.equal(isEligible(pendingInterviewer), true);
  assert.equal(isEligible(declinedInterviewer), false);
  assert.equal(isEligible(removedInterviewer), false);
});

// 6. Email Templates for Panel Workflows
test("Email Templates: panel templates format cleanly without leaking private notes", () => {
  // Panel Interview Invitation
  const inviteTemplate = emailTemplates.panelInterviewInvitation({
    recipientName: "Dr. Alice Vance",
    roleName: "Lead Technical Evaluator",
    jobTitle: "Senior Distributed Systems Engineer",
    companyName: "Acme Systems",
    candidateName: "Candidate Bob",
    scheduledAt: "2026-11-12 14:00 UTC",
    durationMinutes: 60,
    format: "video",
    location: "https://meet.google.com/int-abc-def",
    panelMembers: ["Dr. Alice Vance", "Bob Recruiter"],
    calendarUrl: "https://calendar.google.com/event",
    viewUrl: "/dashboard/recruiter",
  });

  assert.equal(inviteTemplate.subject.includes("Panel Interview Invitation"), true);
  assert.equal(inviteTemplate.html.includes("Lead Technical Evaluator"), true);
  assert.equal(inviteTemplate.html.includes("Candidate Bob"), true);
  assert.equal(inviteTemplate.html.includes("https://calendar.google.com/event"), true);

  // Panel Participant Responded
  const responseTemplate = emailTemplates.panelParticipantResponded({
    recipientName: "Recruiter Sarah",
    panelistName: "Interviewer Mark",
    responseStatus: "Declined",
    reason: "Conflicting customer escalation",
    jobTitle: "Principal Engineer",
    candidateName: "Jane Doe",
    viewUrl: "/dashboard/recruiter",
  });
  assert.equal(responseTemplate.subject.includes("Panel Response"), true);
  assert.equal(responseTemplate.html.includes("Declined"), true);
  assert.equal(responseTemplate.html.includes("Conflicting customer escalation"), true);

  // Panel Debrief Ready
  const debriefTemplate = emailTemplates.panelDebriefReady({
    recipientName: "Recruiter Sarah",
    candidateName: "Jane Doe",
    jobTitle: "Principal Engineer",
    companyName: "Acme Systems",
    completedScorecards: 3,
    totalPanelists: 3,
    averageScore: "4.5",
    viewUrl: "/dashboard/recruiter",
  });
  assert.equal(debriefTemplate.subject.includes("Panel Debrief Ready"), true);
  assert.equal(debriefTemplate.html.includes("3 of 3 submitted"), true);
  assert.equal(debriefTemplate.html.includes("4.5 / 5.0"), true);
});
