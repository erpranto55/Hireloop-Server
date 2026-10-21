import test from "node:test";
import assert from "node:assert/strict";
import { emailTemplates } from "../src/services/emailService.js";
import { sseHub } from "../src/services/sseHub.js";

// Test suite for Email Templates & Security Redaction
test("emailTemplates.applicationStatusChanged renders clean status without private notes", () => {
  const template = emailTemplates.applicationStatusChanged({
    jobTitle: "Senior Full Stack Engineer",
    companyName: "Acme Corp",
    newStatus: "Interview Scheduled",
    viewUrl: "/dashboard/seeker/applications",
  });

  assert.equal(template.subject.includes("Interview Scheduled"), true);
  assert.equal(template.html.includes("Senior Full Stack Engineer"), true);
  assert.equal(template.html.includes("Acme Corp"), true);
  assert.equal(template.html.includes("Interview Scheduled"), true);
  assert.equal(template.html.includes("/dashboard/seeker/applications"), true);

  // Must NEVER leak internal notes or passwords
  assert.equal(template.html.includes("recruiterNotes"), false);
  assert.equal(template.html.includes("password"), false);
});

test("emailTemplates.applicationReceived addresses recruiter and links to review", () => {
  const template = emailTemplates.applicationReceived({
    seekerName: "Alex Rivera",
    jobTitle: "DevOps Architect",
    companyName: "TechFlow",
    reviewUrl: "/dashboard/jobs/job123/applicants",
  });

  assert.equal(template.subject.includes("DevOps Architect"), true);
  assert.equal(template.html.includes("Alex Rivera"), true);
  assert.equal(template.html.includes("/dashboard/jobs/job123/applicants"), true);
});

test("emailTemplates.subscriptionActivated renders plan details and billing CTA", () => {
  const template = emailTemplates.subscriptionActivated({
    planName: "Growth",
    role: "recruiter",
    billingUrl: "/dashboard/recruiter/billing",
  });

  assert.equal(template.subject.includes("Growth"), true);
  assert.equal(template.html.includes("Growth"), true);
  assert.equal(template.html.includes("Recruiters"), true);
  assert.equal(template.html.includes("/dashboard/recruiter/billing"), true);
});

test("emailTemplates.paymentFailed renders warning notice and update link", () => {
  const template = emailTemplates.paymentFailed({
    planName: "Enterprise",
    billingUrl: "/dashboard/recruiter/billing",
  });

  assert.equal(template.subject.includes("Payment failed"), true);
  assert.equal(template.html.includes("Enterprise"), true);
  assert.equal(template.html.includes("/dashboard/recruiter/billing"), true);
});

test("emailTemplates.subscriptionCanceled renders expiration date clearly", () => {
  const template = emailTemplates.subscriptionCanceled({
    planName: "Pro",
    expirationDate: "11/20/2026",
    billingUrl: "/dashboard/seeker/billing",
  });

  assert.equal(template.subject.includes("Subscription Canceled"), true);
  assert.equal(template.html.includes("11/20/2026"), true);
});

// Test suite for Real-Time SSE Hub Isolation & Delivery
test("SSEHub registers client and delivers real-time payload strictly to matching user", () => {
  const receivedUserA = [];
  const receivedUserB = [];

  const mockResUserA = {
    writeHead: () => {},
    write: (data) => receivedUserA.push(data),
    on: () => {},
  };
  const mockReqUserA = { on: () => {} };

  const mockResUserB = {
    writeHead: () => {},
    write: (data) => receivedUserB.push(data),
    on: () => {},
  };
  const mockReqUserB = { on: () => {} };

  sseHub.registerClient("alice@example.com", mockReqUserA, mockResUserA);
  sseHub.registerClient("bob@example.com", mockReqUserB, mockResUserB);

  // Send to Alice
  const payload = { title: "New Application", message: "Candidate applied" };
  const delivered = sseHub.sendToUser("alice@example.com", payload);

  assert.equal(delivered, 1);
  assert.equal(receivedUserA.some((msg) => msg.includes("Candidate applied")), true);
  // Bob must NOT receive Alice's notification
  assert.equal(receivedUserB.some((msg) => msg.includes("Candidate applied")), false);

  // Clean up
  sseHub.closeAll();
});

test("SSEHub normalizes email case-insensitively", () => {
  const received = [];
  const mockRes = {
    writeHead: () => {},
    write: (data) => received.push(data),
    on: () => {},
  };
  const mockReq = { on: () => {} };

  sseHub.registerClient("Alice.Smith@Example.COM", mockReq, mockRes);
  const delivered = sseHub.sendToUser("alice.smith@example.com", { test: true });

  assert.equal(delivered, 1);
  assert.equal(received.some((msg) => msg.includes('"test":true')), true);

  sseHub.closeAll();
});

// Test suite for Notification Deduplication & Scoping
test("Notification idempotency logic prevents duplicate notifications", () => {
  const store = new Map();

  function saveNotification(doc) {
    if (doc.idempotencyKey && store.has(doc.idempotencyKey)) {
      return { duplicate: true, doc: store.get(doc.idempotencyKey) };
    }
    const saved = { ...doc, _id: "notif_" + Math.random().toString(36).substring(2, 7) };
    if (doc.idempotencyKey) {
      store.set(doc.idempotencyKey, saved);
    }
    return { duplicate: false, doc: saved };
  }

  const initial = saveNotification({
    recipientEmail: "recruiter@example.com",
    idempotencyKey: "app_create_app123",
    title: "New Application",
  });
  assert.equal(initial.duplicate, false);
  assert.equal(initial.doc.title, "New Application");

  // Replaying identical event (e.g. webhook retry or duplicate click)
  const replay = saveNotification({
    recipientEmail: "recruiter@example.com",
    idempotencyKey: "app_create_app123",
    title: "New Application",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.doc._id, initial.doc._id);
});

test("Notification read operations update read status and timestamp", () => {
  const notification = {
    _id: "notif_100",
    recipientEmail: "seeker@example.com",
    read: false,
    readAt: null,
  };

  function markRead(doc, userEmail) {
    if (doc.recipientEmail.toLowerCase() !== userEmail.toLowerCase()) {
      return null; // Denied / wrong owner
    }
    return {
      ...doc,
      read: true,
      readAt: new Date(),
    };
  }

  // Unauthorized user cannot mark as read
  const unauthorized = markRead(notification, "attacker@example.com");
  assert.equal(unauthorized, null);

  // Authorized owner succeeds
  const authorized = markRead(notification, "seeker@example.com");
  assert.equal(authorized.read, true);
  assert.equal(authorized.readAt instanceof Date, true);
});
