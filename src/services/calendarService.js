/**
 * Calendar Service for HireLoop Interview Scheduling
 * Generates RFC 5545 compliant iCalendar (.ics) invitations and direct calendar deep-links,
 * supporting multi-interviewer panel interviews, sequence tracking, and cancellation semantics.
 */

/**
 * Formats a Date object to RFC 5545 UTC date-time string (YYYYMMDDTHHMMSSZ).
 */
export function formatIcsDate(date) {
  const d = new Date(date);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Escapes plain text for inclusion in RFC 5545 fields.
 */
export function escapeIcsText(str = "") {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Generates standard RFC 5545 .ics calendar invite content.
 * Supports multiple panel attendees, organizer, sequence numbers for rescheduling,
 * and CANCELLED status.
 */
export function generateIcsInvite({
  interviewId,
  title,
  description = "",
  location = "Video Call",
  startDate,
  endDate,
  organizerName = "HireLoop Recruiter",
  organizerEmail = "interviews@hireloop.com",
  attendeeName = "Candidate",
  attendeeEmail = "",
  attendees = [],
  status = "CONFIRMED",
  sequence = 0,
}) {
  const uid = `interview-${interviewId}@hireloop.com`;
  const dtStamp = formatIcsDate(new Date());
  const dtStart = formatIcsDate(startDate);
  const dtEnd = formatIcsDate(endDate);

  const isCancelled = status.toUpperCase() === "CANCELLED";
  const icsMethod = isCancelled ? "CANCEL" : "REQUEST";

  const icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HireLoop//HireLoop Recruitment Platform//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${icsMethod}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeIcsText(title)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `LOCATION:${escapeIcsText(location)}`,
    `ORGANIZER;CN=${escapeIcsText(organizerName)}:mailto:${organizerEmail}`,
  ];

  // If explicit attendees array provided (Panel Interview), render each attendee
  if (Array.isArray(attendees) && attendees.length > 0) {
    for (const att of attendees) {
      if (!att.email) continue;
      const attName = att.name || att.email;
      const partStat = att.responseStatus === "Accepted"
        ? "ACCEPTED"
        : att.responseStatus === "Declined"
        ? "DECLINED"
        : "NEEDS-ACTION";
      const role = att.role === "lead_interviewer" ? "CHAIR" : "REQ-PARTICIPANT";

      icsLines.push(
        `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=${role};PARTSTAT=${partStat};CN=${escapeIcsText(attName)}:mailto:${att.email.toLowerCase().trim()}`
      );
    }
  } else if (attendeeEmail) {
    // Single attendee fallback for backward compatibility
    icsLines.push(
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=${escapeIcsText(attendeeName)}:mailto:${attendeeEmail.toLowerCase().trim()}`
    );
  }

  icsLines.push(
    `STATUS:${status.toUpperCase()}`,
    `SEQUENCE:${Number(sequence) || 0}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Interview Reminder - 15 minutes before",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  );

  return icsLines.join("\r\n");
}

/**
 * Generates a direct Google Calendar Web Event creation link.
 * Supports multiple attendee emails via the 'add' query parameter.
 */
export function generateGoogleCalendarUrl({
  title,
  description = "",
  location = "",
  startDate,
  endDate,
  attendees = [],
}) {
  const startStr = formatIcsDate(startDate);
  const endStr = formatIcsDate(endDate);

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${startStr}/${endStr}`,
    details: description,
    location,
  });

  if (Array.isArray(attendees) && attendees.length > 0) {
    const emails = attendees
      .map((a) => (typeof a === "string" ? a : a.email)?.toLowerCase().trim())
      .filter(Boolean);
    if (emails.length > 0) {
      params.set("add", emails.join(","));
    }
  }

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
