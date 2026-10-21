/**
 * Calendar Service for HireLoop Interview Scheduling
 * Generates RFC 5545 compliant iCalendar (.ics) invitations and direct calendar deep-links.
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
function escapeIcsText(str = "") {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Generates standard RFC 5545 .ics calendar invite content.
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
  status = "CONFIRMED",
}) {
  const uid = `interview-${interviewId}@hireloop.com`;
  const dtStamp = formatIcsDate(new Date());
  const dtStart = formatIcsDate(startDate);
  const dtEnd = formatIcsDate(endDate);

  const icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HireLoop//HireLoop Recruitment Platform//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
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

  if (attendeeEmail) {
    icsLines.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=${escapeIcsText(attendeeName)}:mailto:${attendeeEmail}`);
  }

  icsLines.push(
    `STATUS:${status.toUpperCase()}`,
    "SEQUENCE:0",
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
 */
export function generateGoogleCalendarUrl({
  title,
  description = "",
  location = "",
  startDate,
  endDate,
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

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
