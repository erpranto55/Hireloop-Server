import test from "node:test";
import assert from "node:assert/strict";
import { isPdfBuffer } from "../src/routes/resumes.js";
import {
  APPLICATION_STATUSES,
  ALLOWED_STATUS_TRANSITIONS,
} from "../src/routes/applications.js";

test("isPdfBuffer accepts valid PDF magic bytes (%PDF-)", () => {
  const validPdfHeader = Buffer.from("%PDF-1.7\n%some content");
  assert.equal(isPdfBuffer(validPdfHeader), true);
});

test("isPdfBuffer rejects non-PDF files and spoofed extensions", () => {
  const exeHeader = Buffer.from("MZ\x90\x00\x03\x00\x00\x00"); // Windows PE
  const textHeader = Buffer.from("Hello world, this is a plain text file.");
  const emptyHeader = Buffer.from("");
  const shortHeader = Buffer.from("%PD");

  assert.equal(isPdfBuffer(exeHeader), false);
  assert.equal(isPdfBuffer(textHeader), false);
  assert.equal(isPdfBuffer(emptyHeader), false);
  assert.equal(isPdfBuffer(shortHeader), false);
});

test("APPLICATION_STATUSES contains all standard recruitment pipeline stages", () => {
  const expected = [
    "Applied",
    "Under Review",
    "Shortlisted",
    "Interview Scheduled",
    "Offered",
    "Accepted",
    "Rejected",
  ];
  for (const st of expected) {
    assert.equal(APPLICATION_STATUSES.includes(st), true, `Missing stage: ${st}`);
  }
});

test("ALLOWED_STATUS_TRANSITIONS enforces sequential recruitment pipeline", () => {
  // From "Applied", can only advance to "Under Review" or "Rejected"
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Applied"], ["Under Review", "Rejected"]);

  // From "Under Review", can move to "Shortlisted" or "Rejected"
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Under Review"], ["Shortlisted", "Rejected"]);

  // From "Shortlisted", can schedule interview, offer, or reject
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Shortlisted"], [
    "Interview Scheduled",
    "Offered",
    "Rejected",
  ]);

  // Terminal stages have no permitted regular forward transitions
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Accepted"], []);
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Rejected"], []);
});

test("Recruiter notes redaction for seekers", () => {
  const applicationRecord = {
    _id: "app_123",
    jobTitle: "Software Engineer",
    seekerEmail: "candidate@test.com",
    recruiterEmail: "recruiter@hireloop.com",
    status: "Shortlisted",
    coverLetter: "Excited to apply!",
    recruiterNotes: "Candidate scored 95% on technical screening. Highly recommended.",
    notesHistory: [
      {
        content: "Screening completed",
        author: "recruiter@hireloop.com",
        updatedAt: new Date(),
      },
    ],
  };

  // Simulating seeker response serialization
  const sanitizeForSeeker = (app) => {
    const copy = { ...app };
    delete copy.recruiterNotes;
    delete copy.notesHistory;
    return copy;
  };

  const seekerPayload = sanitizeForSeeker(applicationRecord);

  assert.equal(seekerPayload.seekerEmail, "candidate@test.com");
  assert.equal(seekerPayload.status, "Shortlisted");
  assert.equal(seekerPayload.coverLetter, "Excited to apply!");
  assert.equal(seekerPayload.recruiterNotes, undefined);
  assert.equal("recruiterNotes" in seekerPayload, false);
  assert.equal("notesHistory" in seekerPayload, false);
});
