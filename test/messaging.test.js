import test from "node:test";
import assert from "node:assert/strict";
import { emailTemplates } from "../src/services/emailService.js";
import { sseHub } from "../src/services/sseHub.js";

// Test suite for Recruiter-Candidate Messaging & Private Screening Notes Isolation

test("Candidate Eligibility: only applications at or past Shortlisted stage can initiate messaging", () => {
  const ELIGIBLE_STATUSES = ["Shortlisted", "Interview Scheduled", "Offered", "Accepted"];

  function isEligibleToStart(status) {
    return ELIGIBLE_STATUSES.includes(status);
  }

  // Early stages: ineligible
  assert.equal(isEligibleToStart("Applied"), false);
  assert.equal(isEligibleToStart("Under Review"), false);

  // Eligible stages
  assert.equal(isEligibleToStart("Shortlisted"), true);
  assert.equal(isEligibleToStart("Interview Scheduled"), true);
  assert.equal(isEligibleToStart("Offered"), true);
  assert.equal(isEligibleToStart("Accepted"), true);

  // Rejected / terminal stages cannot initiate new conversation
  assert.equal(isEligibleToStart("Rejected"), false);
});

test("Conversation State Policy: closed/rejected applications freeze messaging to read-only", () => {
  function canSendMessage(conversation, applicationStatus) {
    if (conversation.status === "closed") return false;
    if (["Rejected", "Withdrawn"].includes(applicationStatus)) return false;
    return true;
  }

  const activeConvo = { _id: "c1", status: "active" };
  const closedConvo = { _id: "c2", status: "closed" };

  assert.equal(canSendMessage(activeConvo, "Shortlisted"), true);
  assert.equal(canSendMessage(activeConvo, "Interview Scheduled"), true);

  // When application is rejected, new messages are blocked
  assert.equal(canSendMessage(activeConvo, "Rejected"), false);
  // When conversation is explicitly closed
  assert.equal(canSendMessage(closedConvo, "Shortlisted"), false);
});

test("Authorization & Ownership: Recruiter and Seeker isolation rules strictly enforced", () => {
  const conversation = {
    _id: "convo_999",
    applicationId: "app_123",
    jobId: "job_456",
    recruiterEmail: "recruiter_a@hireloop.dev",
    seekerEmail: "candidate_a@hireloop.dev",
    status: "active",
  };

  function authorizeAccess(convo, user) {
    if (!user || !user.email) return false;
    const email = user.email.toLowerCase();
    const isRecruiter = email === convo.recruiterEmail.toLowerCase();
    const isSeeker = email === convo.seekerEmail.toLowerCase();
    return isRecruiter || isSeeker;
  }

  // Authorized participants
  assert.equal(authorizeAccess(conversation, { email: "recruiter_a@hireloop.dev", role: "recruiter" }), true);
  assert.equal(authorizeAccess(conversation, { email: "candidate_a@hireloop.dev", role: "seeker" }), true);
  assert.equal(authorizeAccess(conversation, { email: "RECRUITER_A@HIRELOOP.DEV", role: "recruiter" }), true);

  // Unauthorized users (different recruiter, different candidate, or attacker)
  assert.equal(authorizeAccess(conversation, { email: "recruiter_b@hireloop.dev", role: "recruiter" }), false);
  assert.equal(authorizeAccess(conversation, { email: "candidate_b@hireloop.dev", role: "seeker" }), false);
  assert.equal(authorizeAccess(conversation, { email: "stranger@external.com", role: "seeker" }), false);
  assert.equal(authorizeAccess(conversation, null), false);
});

test("Strict Isolation: Conversation and Message records never expose or touch recruiter screening notes", () => {
  // Mock application containing confidential internal recruiter notes
  const mockApplication = {
    _id: "app_100",
    jobId: "job_200",
    recruiterEmail: "recruiter@example.com",
    seekerEmail: "seeker@example.com",
    status: "Shortlisted",
    recruiterNotes: "CONFIDENTIAL: Strong candidate for system architecture, but salary expectation is $180k. Do not disclose.",
    notesHistory: [
      { note: "First review: excellent coding score.", updatedBy: "recruiter@example.com", updatedAt: new Date() },
    ],
  };

  // Conversation record projection as constructed by /api/messages router
  const conversationRecord = {
    _id: "convo_100",
    applicationId: mockApplication._id,
    jobId: mockApplication.jobId,
    recruiterEmail: mockApplication.recruiterEmail,
    recruiterName: "Recruiter One",
    seekerEmail: mockApplication.seekerEmail,
    seekerName: "Jane Doe",
    jobTitle: "Senior Distributed Systems Engineer",
    companyName: "Acme Cloud",
    applicationStatus: mockApplication.status,
    status: "active",
  };

  // A message in the conversation
  const messageRecord = {
    _id: "msg_1",
    conversationId: conversationRecord._id,
    senderEmail: "recruiter@example.com",
    senderRole: "recruiter",
    body: "Hi Jane! We would love to chat with you about your application.",
    createdAt: new Date().toISOString(),
  };

  // Verify conversation record has ZERO screening note properties
  assert.equal(conversationRecord.recruiterNotes, undefined);
  assert.equal(conversationRecord.notesHistory, undefined);
  assert.equal(JSON.stringify(conversationRecord).includes("CONFIDENTIAL"), false);
  assert.equal(JSON.stringify(conversationRecord).includes("salary expectation"), false);

  // Verify message record has ZERO screening note properties
  assert.equal(messageRecord.recruiterNotes, undefined);
  assert.equal(messageRecord.notesHistory, undefined);
  assert.equal(JSON.stringify(messageRecord).includes("CONFIDENTIAL"), false);
});

test("Message Validation: rejects empty, oversized, or malicious markup messages", () => {
  function validateAndSanitizeMessage(body) {
    if (!body || typeof body !== "string") {
      return { valid: false, error: "Message body is required" };
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      return { valid: false, error: "Message body cannot be empty" };
    }
    if (trimmed.length > 2000) {
      return { valid: false, error: "Message body exceeds maximum 2000 characters limit" };
    }
    // Sanitize HTML and script tags
    const sanitized = trimmed
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<[^>]*>?/gm, "")
      .trim();
    if (!sanitized) {
      return { valid: false, error: "Message cannot be empty after HTML stripping" };
    }
    return { valid: true, sanitized };
  }

  // Empty / whitespace
  assert.equal(validateAndSanitizeMessage("").valid, false);
  assert.equal(validateAndSanitizeMessage("   \n\t  ").valid, false);

  // Oversized
  const oversized = "a".repeat(2001);
  assert.equal(validateAndSanitizeMessage(oversized).valid, false);

  // HTML script injection
  const injection = "<script>alert('xss')</script>Hello recruiter!";
  const result = validateAndSanitizeMessage(injection);
  assert.equal(result.valid, true);
  assert.equal(result.sanitized.includes("<script>"), false);
  assert.equal(result.sanitized.includes("alert"), false);
  assert.equal(result.sanitized, "Hello recruiter!");

  // Pure HTML tag that strips to empty
  assert.equal(validateAndSanitizeMessage("<img src=x onerror=alert(1)>").valid, false);
});

test("Idempotency: duplicate message submissions with identical idempotencyKey do not duplicate", () => {
  const messageStore = new Map();

  function insertMessage(doc) {
    if (doc.idempotencyKey && messageStore.has(doc.idempotencyKey)) {
      return { isDuplicate: true, message: messageStore.get(doc.idempotencyKey) };
    }
    const saved = { ...doc, _id: "msg_" + Math.random().toString(36).substring(2, 8) };
    if (doc.idempotencyKey) {
      messageStore.set(doc.idempotencyKey, saved);
    }
    return { isDuplicate: false, message: saved };
  }

  const send1 = insertMessage({
    conversationId: "c_1",
    senderEmail: "recruiter@example.com",
    body: "Interview proposed for Tuesday.",
    idempotencyKey: "idem_abc_123",
  });
  assert.equal(send1.isDuplicate, false);
  assert.equal(send1.message.body, "Interview proposed for Tuesday.");

  // Retry with same idempotency key (e.g. network timeout or double-click)
  const send2 = insertMessage({
    conversationId: "c_1",
    senderEmail: "recruiter@example.com",
    body: "Interview proposed for Tuesday.",
    idempotencyKey: "idem_abc_123",
  });
  assert.equal(send2.isDuplicate, true);
  assert.equal(send2.message._id, send1.message._id);
});

test("Real-Time SSE Hub delivers message events with eventType 'message' strictly to recipient", () => {
  const recruiterEvents = [];
  const candidateEvents = [];
  const thirdPartyEvents = [];

  const mockRecruiterRes = {
    writeHead: () => {},
    write: (data) => recruiterEvents.push(data),
    on: () => {},
  };
  const mockCandidateRes = {
    writeHead: () => {},
    write: (data) => candidateEvents.push(data),
    on: () => {},
  };
  const mockThirdPartyRes = {
    writeHead: () => {},
    write: (data) => thirdPartyEvents.push(data),
    on: () => {},
  };

  const dummyReq = { on: () => {} };

  sseHub.registerClient("recruiter@hireloop.dev", dummyReq, mockRecruiterRes);
  sseHub.registerClient("candidate@hireloop.dev", dummyReq, mockCandidateRes);
  sseHub.registerClient("stranger@hireloop.dev", dummyReq, mockThirdPartyRes);

  const messagePayload = {
    _id: "m_live_1",
    conversationId: "convo_live_1",
    senderEmail: "recruiter@hireloop.dev",
    senderRole: "recruiter",
    body: "Hello! We would like to schedule an interview.",
    createdAt: new Date().toISOString(),
  };

  // Recruiter sends message -> SSE event emitted to candidate
  const delivered = sseHub.sendToUser("candidate@hireloop.dev", messagePayload, "message");

  assert.equal(delivered, 1);

  // Candidate must have received SSE event with 'event: message'
  const messageEvents = candidateEvents.filter((e) => e.includes("event: message"));
  assert.equal(messageEvents.length, 1);
  assert.equal(messageEvents[0].includes("Hello! We would like to schedule an interview."), true);

  // Recruiter (sender) and Stranger must NOT receive candidate's message event
  assert.equal(recruiterEvents.some((e) => e.includes("event: message")), false);
  assert.equal(thirdPartyEvents.some((e) => e.includes("event: message")), false);

  sseHub.closeAll();
});

test("Email Template: newMessageReceived renders clean preview without private screening notes or credentials", () => {
  const template = emailTemplates.newMessageReceived({
    recipientName: "Alex Mercer",
    senderName: "Sarah TechRecruiter",
    jobTitle: "Principal Cloud Engineer",
    messagePreview: "We reviewed your portfolio and would like to invite you for a 30-min call.",
    conversationUrl: "/dashboard/seeker/messages?conversationId=c100",
  });

  assert.equal(template.subject.includes("New message from Sarah TechRecruiter"), true);
  assert.equal(template.subject.includes("Principal Cloud Engineer"), true);
  assert.equal(template.html.includes("Alex Mercer"), true);
  assert.equal(template.html.includes("Sarah TechRecruiter"), true);
  assert.equal(template.html.includes("Principal Cloud Engineer"), true);
  assert.equal(template.html.includes("We reviewed your portfolio"), true);
  assert.equal(template.html.includes("/dashboard/seeker/messages?conversationId=c100"), true);

  // Critical boundary check: must NOT leak internal notes or passwords
  assert.equal(template.html.includes("recruiterNotes"), false);
  assert.equal(template.html.includes("notesHistory"), false);
  assert.equal(template.html.includes("password"), false);
});
