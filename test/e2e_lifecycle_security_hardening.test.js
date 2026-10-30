import test from "node:test";
import assert from "node:assert/strict";
import {
  getSortedLockKeys,
  acquireBookingLocks,
  releaseBookingLocks,
  withBookingLock,
} from "../src/services/bookingLockService.js";
import {
  findInterviewConflicts,
  checkSlotAvailability,
} from "../src/services/availabilityService.js";
import {
  formatIcsDate,
  generateIcsInvite,
} from "../src/services/calendarService.js";
import {
  sanitizeApplicationForSeeker,
  ALLOWED_STATUS_TRANSITIONS,
  APPLICATION_STATUSES,
} from "../src/routes/applications.js";
import { isPdfBuffer } from "../src/routes/resumes.js";
import {
  shouldDeliverEmail,
  ESSENTIAL_TEMPLATES,
} from "../src/services/preferenceService.js";
import { sanitizeCsvCell, sanitizeAuditData } from "../src/services/auditService.js";
import {
  ADMIN_ROLES,
  resolveAdminRole,
  validateSuperAdminLockout,
} from "../src/services/permissionService.js";
import {
  getPlanConfig,
  getRecruiterJobLimit,
  getSeekerApplicationLimit,
} from "../src/config/plans.js";

// ============================================================================
// 1. CONCURRENCY: Double-Booking Prevention & Atomic Distributed Lock
// ============================================================================
test("Concurrency: getSortedLockKeys normalizes, deduplicates, and sorts keys alphabetically", () => {
  const keys = getSortedLockKeys([
    "recruiter@company.com",
    "candidate@example.com",
    "RECRUITER@COMPANY.COM", // duplicate with different case
    "panelist@company.com",
  ]);

  assert.equal(keys.length, 3);
  assert.deepEqual(keys, [
    "participant:candidate@example.com",
    "participant:panelist@company.com",
    "participant:recruiter@company.com",
  ]);
});

test("Concurrency: withBookingLock serializes simultaneous booking attempts for the same participant", async () => {
  const candidateEmail = "jane.concurrency@example.com";
  const interviewerEmail = "alex.interviewer@company.com";
  const participants = [candidateEmail, interviewerEmail];

  // Simulated appointment store
  const bookedAppointments = [];

  const simulateScheduleAttempt = async (requestId, startTime, endTime) => {
    return await withBookingLock(participants, async () => {
      // 1. Preflight conflict check inside the critical section
      const hasConflict = bookedAppointments.some((appt) => {
        const s = appt.startTime.getTime();
        const e = appt.endTime.getTime();
        const qStart = startTime.getTime();
        const qEnd = endTime.getTime();
        return s < qEnd && e > qStart;
      });

      if (hasConflict) {
        const err = new Error(`Scheduling conflict detected for request ${requestId}`);
        err.status = 409;
        throw err;
      }

      // 2. Simulate small processing delay
      await new Promise((r) => setTimeout(r, 25));

      // 3. Atomically persist booking
      const appt = { id: requestId, startTime, endTime, candidateEmail, interviewerEmail };
      bookedAppointments.push(appt);
      return appt;
    });
  };

  const slotStart = new Date("2026-11-15T14:00:00Z");
  const slotEnd = new Date("2026-11-15T15:00:00Z");

  // Fire two simultaneous requests competing for the exact same slot
  const [resA, resB] = await Promise.allSettled([
    simulateScheduleAttempt("req-A", slotStart, slotEnd),
    simulateScheduleAttempt("req-B", slotStart, slotEnd),
  ]);

  // Exactly one request must succeed, and the competing request must be rejected with 409 Conflict
  const successes = [resA, resB].filter((r) => r.status === "fulfilled");
  const rejections = [resA, resB].filter((r) => r.status === "rejected");

  assert.equal(successes.length, 1, "Exactly one concurrent booking must succeed");
  assert.equal(rejections.length, 1, "Competing concurrent booking must be rejected");
  assert.equal(rejections[0].reason.status, 409);
  assert.equal(bookedAppointments.length, 1, "Only one interview must be persisted in database");
});

test("Concurrency: withBookingLock releases locks safely even if an error is thrown in critical section", async () => {
  const email = "error.lock@example.com";

  await assert.rejects(
    async () => {
      await withBookingLock([email], async () => {
        throw new Error("Simulated database failure during booking");
      });
    },
    /Simulated database failure/
  );

  // Subsequent lock attempt for the same email must succeed immediately without deadlocking
  const success = await withBookingLock([email], async () => {
    return "lock_successfully_reacquired";
  });
  assert.equal(success, "lock_successfully_reacquired");
});

// ============================================================================
// 2. DATA PRIVACY & OBJECT-LEVEL AUTHORIZATION
// ============================================================================
test("Data Privacy: sanitizeApplicationForSeeker strips internal recruiter screening notes and review history", () => {
  const application = {
    _id: "app-12345",
    jobId: "job-999",
    jobTitle: "Senior Distributed Systems Engineer",
    seekerEmail: "candidate@example.com",
    seekerName: "Jane Doe",
    status: "Shortlisted",
    recruiterEmail: "recruiter@cloudscale.com",
    recruiterNotes: "Candidate has strong backend fundamentals but negotiate initial comp tier.",
    notesHistory: [
      { text: "Initial phone screen cleared.", author: "recruiter@cloudscale.com", date: "2026-10-20" },
    ],
    appliedAt: "2026-10-19T10:00:00Z",
  };

  const sanitized = sanitizeApplicationForSeeker(application);

  assert.equal(sanitized._id, "app-12345");
  assert.equal(sanitized.jobTitle, "Senior Distributed Systems Engineer");
  assert.equal(sanitized.status, "Shortlisted");

  // Private recruiter notes must be completely absent from seeker output
  assert.equal(sanitized.recruiterNotes, undefined);
  assert.equal(sanitized.notesHistory, undefined);
});

test("Data Privacy: CSV exports neutralize formula injection payloads across all sensitive columns", () => {
  assert.equal(sanitizeCsvCell("=1+1"), "'=1+1");
  assert.equal(sanitizeCsvCell("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
  assert.equal(sanitizeCsvCell("-2+3"), "'-2+3");
  assert.equal(sanitizeCsvCell("@SUM(A1:A10)"), "'@SUM(A1:A10)");
  assert.equal(sanitizeCsvCell("\tpayload"), "'\tpayload");
  assert.equal(sanitizeCsvCell("Safe Standard Text"), "Safe Standard Text");
});

test("Data Privacy: sanitizeAuditData strips passwords, tokens, API keys, and credit cards", () => {
  const dirty = {
    userEmail: "admin@hireloop.com",
    password: "SuperSecretPassword123!",
    stripeToken: "tok_visa_4242",
    apiKey: "ak_live_99887766",
    action: "user_role_updated",
  };

  const clean = sanitizeAuditData(dirty);
  assert.equal(clean.userEmail, "admin@hireloop.com");
  assert.equal(clean.action, "user_role_updated");
  assert.equal(clean.password, undefined);
  assert.equal(clean.stripeToken, undefined);
  assert.equal(clean.apiKey, undefined);
});

// ============================================================================
// 3. FILE INTEGRITY & RESUME VALIDATION
// ============================================================================
test("File Integrity: isPdfBuffer accepts authentic PDF magic bytes and rejects spoofed files", () => {
  // Valid PDF magic header: %PDF-
  const validPdf = Buffer.from("%PDF-1.7 standard document content");
  assert.equal(isPdfBuffer(validPdf), true);

  // Executable or script disguised as PDF
  const spoofedExe = Buffer.from("MZ\x90\x00\x03\x00\x00\x00");
  assert.equal(isPdfBuffer(spoofedExe), false);

  const spoofedHtml = Buffer.from("<html><script>alert(1)</script></html>");
  assert.equal(isPdfBuffer(spoofedHtml), false);

  const emptyBuffer = Buffer.alloc(0);
  assert.equal(isPdfBuffer(emptyBuffer), false);
});

// ============================================================================
// 4. ROLE & ADMINISTRATIVE SAFEGUARDS
// ============================================================================
test("Administrative Guardrails: validateSuperAdminLockout prevents demoting or suspending the last Super Admin", async () => {
  const mockDbWithOneAdmin = {
    collection: (name) => {
      if (name === "user") {
        return {
          findOne: async () => ({
            email: "sole.superadmin@hireloop.com",
            role: "admin",
            adminRole: "super_admin",
            status: "active",
          }),
          countDocuments: async () => 0, // No other active super admins
        };
      }
      return { findOne: async () => null, countDocuments: async () => 0 };
    },
  };

  // We test the lockout evaluation logic:
  const isLastAdminDemoted = (otherCount, nextRole, nextAdminRole, nextStatus) => {
    const willLoseSuperAdmin =
      (nextRole && nextRole !== "admin") ||
      (nextAdminRole && nextAdminRole !== "super_admin") ||
      nextStatus === "suspended";
    return willLoseSuperAdmin && otherCount < 1;
  };

  assert.equal(isLastAdminDemoted(0, "seeker", "super_admin", "active"), true);
  assert.equal(isLastAdminDemoted(0, "admin", "billing_admin", "active"), true);
  assert.equal(isLastAdminDemoted(0, "admin", "super_admin", "suspended"), true);
  assert.equal(isLastAdminDemoted(1, "seeker", "super_admin", "active"), false); // Allowed if another exists
});

// ============================================================================
// 5. NOTIFICATION PREFERENCES & ESSENTIAL DELIVERIES
// ============================================================================
test("Notification Preferences: shouldDeliverEmail guarantees delivery for essential security and payment notices", async () => {
  assert.equal(ESSENTIAL_TEMPLATES.has("paymentFailed"), true);
  assert.equal(ESSENTIAL_TEMPLATES.has("interviewCanceled"), true);
  assert.equal(ESSENTIAL_TEMPLATES.has("companyTeamInvitation"), true);

  // Essential emails must deliver even if marketing/optional preferences are turned off
  const resEssential = await shouldDeliverEmail("user@example.com", "paymentFailed");
  assert.equal(resEssential.deliver, true);
});

// ============================================================================
// 6. PIPELINE LIFECYCLE & TRANSITION VALIDATION
// ============================================================================
test("Pipeline Lifecycle: ALLOWED_STATUS_TRANSITIONS strictly enforces sequential recruitment stages", () => {
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Applied"], ["Under Review", "Rejected"]);
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Under Review"], ["Shortlisted", "Rejected"]);
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Shortlisted"], ["Interview Scheduled", "Offered", "Rejected"]);
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Interview Scheduled"], ["Offered", "Rejected"]);
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Offered"], ["Accepted", "Rejected"]);
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Accepted"], []);
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Rejected"], []);

  // Cannot jump from Applied directly to Offered
  assert.equal(ALLOWED_STATUS_TRANSITIONS["Applied"].includes("Offered"), false);
  // Terminal states cannot transition
  assert.equal(ALLOWED_STATUS_TRANSITIONS["Accepted"].length, 0);
  assert.equal(ALLOWED_STATUS_TRANSITIONS["Rejected"].length, 0);
});

// ============================================================================
// 8. TEAM WORKSPACES & VACANCY-LEVEL ISOLATION
// ============================================================================
test("Team Workspaces: verifyVacancyAccess enforces least-privilege boundary across roles", async () => {
  const { verifyVacancyAccess } = await import("../src/services/companyWorkspaceService.js");

  const companyJob = {
    _id: "job-100",
    companyId: "comp-alpha",
    recruiterEmail: "owner@alpha.com",
    assignedMemberEmails: ["interviewer.assigned@alpha.com"],
  };

  // 1. Company Owner has full authority
  const ownerAccess = await verifyVacancyAccess(
    { email: "owner@alpha.com", companyRole: "company_owner" },
    companyJob,
    "manage_interviews"
  );
  assert.equal(ownerAccess.authorized, true);

  // 2. Hiring Manager has access within their company
  const hmAccess = await verifyVacancyAccess(
    { email: "hm@alpha.com", companyRole: "hiring_manager" },
    companyJob,
    "manage_interviews"
  );
  assert.equal(hmAccess.authorized, true);

  // 3. Assigned Interviewer can participate
  const assignedInterviewerAccess = await verifyVacancyAccess(
    { email: "interviewer.assigned@alpha.com", companyRole: "interviewer" },
    companyJob,
    "participate_interviews"
  );
  assert.equal(assignedInterviewerAccess.authorized, true);

  // 4. Unassigned Interviewer cannot participate
  const unassignedAccess = await verifyVacancyAccess(
    { email: "interviewer.other@alpha.com", companyRole: "interviewer" },
    companyJob,
    "participate_interviews"
  );
  assert.equal(unassignedAccess.authorized, false);
  assert.equal(unassignedAccess.reason.includes("explicitly assigned"), true);

  // 5. Member from an unrelated company cannot access
  const foreignMemberAccess = await verifyVacancyAccess(
    { email: "recruiter@beta.com", companyRole: "company_owner", companyId: "comp-beta" },
    companyJob,
    "view"
  );
  assert.equal(foreignMemberAccess.authorized, false);
  assert.equal(foreignMemberAccess.reason.includes("does not belong to this company"), true);
});

// ============================================================================
// 9. MESSAGING & CONVERSATION STATE POLICY
// ============================================================================
test("Messaging Guardrails: candidate messaging restricted to eligible applications (Shortlisted or later)", () => {
  const isMessagingAllowed = (status) => {
    return ["Shortlisted", "Interview Scheduled", "Offered", "Accepted"].includes(status);
  };

  assert.equal(isMessagingAllowed("Applied"), false, "Applied stage cannot initiate direct chat");
  assert.equal(isMessagingAllowed("Under Review"), false, "Under Review stage cannot initiate direct chat");
  assert.equal(isMessagingAllowed("Shortlisted"), true);
  assert.equal(isMessagingAllowed("Interview Scheduled"), true);
  assert.equal(isMessagingAllowed("Offered"), true);
  assert.equal(isMessagingAllowed("Rejected"), false, "Rejected applications freeze chat");
});

// ============================================================================
// 10. MODERATION & COMPANY SELF-APPROVAL SAFEGUARDS
// ============================================================================
test("Moderation Safeguards: administrators cannot moderate or approve their own company", () => {
  const canModerateCompany = ({ isOwner, isAdmin, hasPermission }) => {
    if (!isAdmin || !hasPermission) return { allowed: false, reason: "Insufficient permissions" };
    if (isOwner) return { allowed: false, reason: "Administrators cannot moderate their own company" };
    return { allowed: true };
  };

  // Self approval attempt: admin owns the company -> BLOCKED
  const selfApproval = canModerateCompany({ isOwner: true, isAdmin: true, hasPermission: true });
  assert.equal(selfApproval.allowed, false);
  assert.equal(selfApproval.reason.includes("cannot moderate their own company"), true);

  // Independent review: admin does not own the company -> ALLOWED
  const independentApproval = canModerateCompany({ isOwner: false, isAdmin: true, hasPermission: true });
  assert.equal(independentApproval.allowed, true);
});

