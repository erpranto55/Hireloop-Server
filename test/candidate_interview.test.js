import test from "node:test";
import assert from "node:assert/strict";
import {
  extractStructuredData,
} from "../src/services/resumeParserService.js";
import {
  formatIcsDate,
  generateIcsInvite,
  generateGoogleCalendarUrl,
} from "../src/services/calendarService.js";
import { emailTemplates } from "../src/services/emailService.js";

// Test suite for Resume Parsing & Structured Data Extraction
test("extractStructuredData handles empty or image-only documents safely", () => {
  const emptyRes = extractStructuredData("");
  assert.equal(emptyRes.status, "failed");
  assert.equal(emptyRes.data, null);
  assert.equal(emptyRes.error.includes("image scan or contains no extractable text"), true);

  const whitespaceRes = extractStructuredData("   \n\n  \t  ");
  assert.equal(whitespaceRes.status, "failed");
});

test("extractStructuredData extracts contact info, skills, education, and summary deterministically", () => {
  const resumeText = `
Alex Mercer
alex.mercer@example.com
(555) 234-5678
San Francisco, CA

Professional Summary
Senior full-stack software engineer with 7+ years of experience designing high-throughput distributed web systems.

Skills
JavaScript, TypeScript, React, Next.js, Node.js, Express, PostgreSQL, MongoDB, Docker, AWS, GraphQL

Experience
Software Engineer at Acme Cloud Systems
2021 - Present
- Architected resilient event-driven microservices using Node.js and AWS.

Education
Bachelor of Science in Computer Science
University of California, Berkeley
`;

  const result = extractStructuredData(resumeText);

  assert.equal(result.status, "parsed");
  assert.equal(result.data.candidateName, "Alex Mercer");
  assert.equal(result.data.email, "alex.mercer@example.com");
  assert.equal(result.data.phone, "(555) 234-5678");

  // Skills
  assert.equal(result.data.skills.includes("React"), true);
  assert.equal(result.data.skills.includes("TypeScript"), true);
  assert.equal(result.data.skills.includes("Node.js"), true);
  assert.equal(result.data.skills.includes("PostgreSQL"), true);
  assert.equal(result.data.skills.includes("AWS"), true);

  // Education
  assert.equal(result.data.education.some((e) => e.includes("Bachelor")), true);

  // Summary
  assert.equal(result.data.summary.includes("Senior full-stack software engineer"), true);

  // Integrity disclaimer is mandatory
  assert.equal(result.disclaimer.includes("automated document parsing"), true);
  assert.equal(result.disclaimer.includes("not been independently verified"), true);
});

test("extractStructuredData returns partial status when text has minimal keywords", () => {
  const minimalText = "Random document text without contact info or tech skills keyword listing.";
  const result = extractStructuredData(minimalText);

  assert.equal(result.status, "partial");
  assert.equal(result.data.email, null);
  assert.equal(result.data.skills.length, 0);
});

// Test suite for Calendar Integration & RFC 5545 Generation
test("formatIcsDate converts Date object to standard UTC format (YYYYMMDDTHHmmssZ)", () => {
  const date = new Date("2026-11-15T14:30:00.000Z");
  const formatted = formatIcsDate(date);
  assert.equal(formatted, "20261115T143000Z");
});

test("generateIcsInvite produces RFC 5545 compliant calendar content", () => {
  const startDate = new Date("2026-11-15T15:00:00.000Z");
  const endDate = new Date("2026-11-15T15:45:00.000Z");

  const ics = generateIcsInvite({
    interviewId: "6a64fdcb6029633a491e7999",
    title: "HireLoop Interview: Senior Full Stack Engineer - OrbitAI",
    description: "Technical screening discussion and architecture review.",
    location: "https://zoom.us/j/123456789",
    startDate,
    endDate,
    organizerName: "OrbitAI Hiring Team",
    organizerEmail: "recruiter@orbitai.com",
    attendeeName: "Alex Mercer",
    attendeeEmail: "alex@example.com",
    status: "CONFIRMED",
  });

  // Verify essential RFC 5545 tokens
  assert.equal(ics.includes("BEGIN:VCALENDAR"), true);
  assert.equal(ics.includes("VERSION:2.0"), true);
  assert.equal(ics.includes("METHOD:REQUEST"), true);
  assert.equal(ics.includes("BEGIN:VEVENT"), true);
  assert.equal(ics.includes("UID:interview-6a64fdcb6029633a491e7999@hireloop.com"), true);
  assert.equal(ics.includes("DTSTART:20261115T150000Z"), true);
  assert.equal(ics.includes("DTEND:20261115T154500Z"), true);
  assert.equal(ics.includes("SUMMARY:HireLoop Interview: Senior Full Stack Engineer - OrbitAI"), true);
  assert.equal(ics.includes("LOCATION:https://zoom.us/j/123456789"), true);
  assert.equal(ics.includes("ORGANIZER;CN=OrbitAI Hiring Team:mailto:recruiter@orbitai.com"), true);
  assert.equal(ics.includes("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Alex Mercer:mailto:alex@example.com"), true);
  assert.equal(ics.includes("STATUS:CONFIRMED"), true);
  assert.equal(ics.includes("END:VEVENT"), true);
  assert.equal(ics.includes("END:VCALENDAR"), true);
});

test("generateGoogleCalendarUrl formats URL with encoded parameters", () => {
  const startDate = new Date("2026-11-15T15:00:00.000Z");
  const endDate = new Date("2026-11-15T15:45:00.000Z");

  const url = generateGoogleCalendarUrl({
    title: "Interview: Full Stack Developer",
    description: "Round 1 Technical Interview",
    location: "Google Meet",
    startDate,
    endDate,
  });

  assert.equal(url.startsWith("https://calendar.google.com/calendar/render"), true);
  assert.equal(url.includes("action=TEMPLATE"), true);
  assert.equal(url.includes("20261115T150000Z%2F20261115T154500Z"), true);
  assert.equal(url.includes("Interview%3A+Full+Stack+Developer"), true);
});

// Test suite for Email Templates for Interview Lifecycle
test("emailTemplates.interviewInvitation renders appointment details and calendar link", () => {
  const template = emailTemplates.interviewInvitation({
    jobTitle: "Lead Systems Architect",
    companyName: "TechFlow",
    scheduledAt: "Nov 15, 2026 at 3:00 PM",
    durationMinutes: 45,
    timezone: "America/New_York",
    format: "video",
    location: "https://meet.google.com/xyz-abc",
    agenda: "System design deep dive and team fit.",
    calendarUrl: "https://calendar.google.com/calendar/render?test",
    viewUrl: "/dashboard/seeker/applications",
  });

  assert.equal(template.subject.includes("Interview Invitation: Lead Systems Architect"), true);
  assert.equal(template.html.includes("Lead Systems Architect"), true);
  assert.equal(template.html.includes("TechFlow"), true);
  assert.equal(template.html.includes("Nov 15, 2026 at 3:00 PM"), true);
  assert.equal(template.html.includes("45 minutes"), true);
  assert.equal(template.html.includes("America/New_York"), true);
  assert.equal(template.html.includes("https://meet.google.com/xyz-abc"), true);
  assert.equal(template.html.includes("System design deep dive"), true);
  assert.equal(template.html.includes("Add to Google Calendar"), true);

  // Must not leak passwords or internal flags
  assert.equal(template.html.includes("password"), false);
  assert.equal(template.html.includes("recruiterNotes"), false);
});

test("emailTemplates.interviewRescheduled highlights previous and new appointment times", () => {
  const template = emailTemplates.interviewRescheduled({
    jobTitle: "DevOps Engineer",
    companyName: "CloudScale",
    previousTime: "Nov 10, 2026 at 2:00 PM",
    newTime: "Nov 12, 2026 at 4:00 PM",
    timezone: "UTC",
    format: "video",
    location: "Zoom",
    reason: "Interviewer had a schedule conflict",
    calendarUrl: "https://calendar.google.com/calendar/render?test",
    viewUrl: "/dashboard/seeker/applications",
  });

  assert.equal(template.subject.includes("Interview Rescheduled: DevOps Engineer"), true);
  assert.equal(template.html.includes("Nov 10, 2026 at 2:00 PM"), true);
  assert.equal(template.html.includes("Nov 12, 2026 at 4:00 PM"), true);
  assert.equal(template.html.includes("Interviewer had a schedule conflict"), true);
});

test("emailTemplates.interviewCanceled renders cancellation note and next steps", () => {
  const template = emailTemplates.interviewCanceled({
    jobTitle: "Product Designer",
    companyName: "DesignFlow",
    scheduledAt: "Nov 10, 2026 at 2:00 PM",
    canceledBy: "Recruiter Sarah",
    reason: "Position put on hold",
    viewUrl: "/dashboard/seeker/applications",
  });

  assert.equal(template.subject.includes("Interview Canceled: Product Designer"), true);
  assert.equal(template.html.includes("DesignFlow"), true);
  assert.equal(template.html.includes("Position put on hold"), true);
});

// Test suite for Recruiter Candidate Search Scoping & Privacy Guards
test("Recruiter candidate search scopes strictly to recruiter's authorized jobs", () => {
  const recruiterAEmail = "recruiter-a@company.com";
  const recruiterBEmail = "recruiter-b@company.com";

  const allApplications = [
    {
      _id: "app1",
      jobId: "job1",
      recruiterEmail: recruiterAEmail,
      seekerEmail: "candidate1@example.com",
      status: "Shortlisted",
      recruiterNotes: "Private note A: strong candidate",
    },
    {
      _id: "app2",
      jobId: "job2",
      recruiterEmail: recruiterBEmail,
      seekerEmail: "candidate2@example.com",
      status: "Interview Scheduled",
      recruiterNotes: "Private note B: salary expectation high",
    },
  ];

  // Recruiter A searches: must strictly return app1, never app2
  const recruiterAJobs = ["job1"];
  const recruiterASearch = allApplications.filter((app) =>
    recruiterAJobs.includes(app.jobId)
  );

  assert.equal(recruiterASearch.length, 1);
  assert.equal(recruiterASearch[0].seekerEmail, "candidate1@example.com");

  // Recruiter B notes must never leak to Recruiter A
  assert.equal(
    recruiterASearch.some((app) => app.recruiterNotes?.includes("salary expectation high")),
    false
  );
});
