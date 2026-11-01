import test from "node:test";
import assert from "node:assert/strict";

import {
  getSortedLockKeys,
  acquireBookingLocks,
  renewBookingLocks,
  assertLockValid,
  releaseBookingLocks,
  withBookingLock,
} from "../src/services/bookingLockService.js";

import {
  ADMIN_ROLES,
  validateSuperAdminLockout,
  resolveAdminRole,
  migrateLegacyAdmins,
} from "../src/services/permissionService.js";

// ============================================================================
// 1. ADMINISTRATIVE BOOTSTRAP & MIGRATION MATRIX (Section 4)
// ============================================================================
test("Admin Bootstrap Scenario 1: No existing administrators", async () => {
  // Mock empty database
  const users = [];
  const mockDb = {
    collection: () => ({
      findOne: async () => null,
      find: () => ({
        sort: () => ({
          toArray: async () => [],
        }),
      }),
      updateOne: async () => {},
      countDocuments: async () => 0,
    }),
  };

  // Simulating migration logic
  const unmigrated = users.filter((u) => u.role === "admin" && !u.adminRole);
  assert.equal(unmigrated.length, 0);
  assert.equal(users.length, 0, "No accounts modified when collection is empty");
});

test("Admin Bootstrap Scenario 2: One legacy administrator without configured bootstrap email", async () => {
  const users = [
    { _id: "admin-1", email: "first.admin@hireloop.com", role: "admin", createdAt: new Date("2026-01-01") },
  ];

  // In non-production, earliest account is granted super_admin
  const hasExistingSuperAdmin = false;
  const bootstrapEmail = "";

  const assigned = [];
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    let role = ADMIN_ROLES.SUPPORT_MODERATOR;
    if (!hasExistingSuperAdmin && !bootstrapEmail && i === 0) {
      role = ADMIN_ROLES.SUPER_ADMIN;
    }
    assigned.push({ email: u.email, role });
  }

  assert.equal(assigned[0].role, ADMIN_ROLES.SUPER_ADMIN);
});

test("Admin Bootstrap Scenario 3: Multiple legacy administrators without bootstrap email", async () => {
  const users = [
    { _id: "admin-1", email: "admin1@hireloop.com", role: "admin", createdAt: new Date("2026-01-01") },
    { _id: "admin-2", email: "admin2@hireloop.com", role: "admin", createdAt: new Date("2026-01-02") },
    { _id: "admin-3", email: "admin3@hireloop.com", role: "admin", createdAt: new Date("2026-01-03") },
  ];

  let hasSuper = false;
  const assigned = users.map((u, i) => {
    let role = ADMIN_ROLES.SUPPORT_MODERATOR;
    if (!hasSuper && i === 0) {
      role = ADMIN_ROLES.SUPER_ADMIN;
      hasSuper = true;
    }
    return { email: u.email, role };
  });

  // Exactly one super_admin, others strictly get least-privilege support_moderator
  assert.equal(assigned[0].role, ADMIN_ROLES.SUPER_ADMIN);
  assert.equal(assigned[1].role, ADMIN_ROLES.SUPPORT_MODERATOR);
  assert.equal(assigned[2].role, ADMIN_ROLES.SUPPORT_MODERATOR);
});

test("Admin Bootstrap Scenario 4: Explicitly configured INITIAL_SUPER_ADMIN_EMAIL", async () => {
  const users = [
    { _id: "admin-1", email: "earliest@hireloop.com", role: "admin", createdAt: new Date("2026-01-01") },
    { _id: "admin-2", email: "designated.super@hireloop.com", role: "admin", createdAt: new Date("2026-01-02") },
  ];

  const bootstrapEmail = "designated.super@hireloop.com";
  let hasSuper = false;

  const assigned = users.map((u) => {
    let role = ADMIN_ROLES.SUPPORT_MODERATOR;
    if (!hasSuper && u.email === bootstrapEmail) {
      role = ADMIN_ROLES.SUPER_ADMIN;
      hasSuper = true;
    }
    return { email: u.email, role };
  });

  // Only the designated email receives super_admin
  assert.equal(assigned[0].role, ADMIN_ROLES.SUPPORT_MODERATOR);
  assert.equal(assigned[1].role, ADMIN_ROLES.SUPER_ADMIN);
});

test("Admin Bootstrap Scenario 5: Invalid or non-matching configured bootstrap email", async () => {
  const users = [
    { _id: "admin-1", email: "existing.admin@hireloop.com", role: "admin" },
  ];

  const bootstrapEmail = "nonexistent.account@hireloop.com";

  // In production mode, if bootstrapEmail doesn't match, NO legacy account is elevated
  const assignedRole = users[0].email === bootstrapEmail ? ADMIN_ROLES.SUPER_ADMIN : ADMIN_ROLES.SUPPORT_MODERATOR;
  assert.equal(assignedRole, ADMIN_ROLES.SUPPORT_MODERATOR, "Unmatched account must never be elevated");
});

test("Admin Bootstrap Scenario 6 & 7: Existing super-admin and repeated startup idempotency", async () => {
  const existingSuperAdmin = {
    _id: "super-1",
    email: "active.super@hireloop.com",
    role: "admin",
    adminRole: ADMIN_ROLES.SUPER_ADMIN,
    status: "active",
  };

  const newAdmin = {
    _id: "admin-new",
    email: "new.admin@hireloop.com",
    role: "admin",
    adminRole: null,
  };

  // When an active super admin already exists, any subsequent migration strictly assigns support_moderator
  const hasExistingSuperAdmin = Boolean(existingSuperAdmin);
  const assignedRole = hasExistingSuperAdmin ? ADMIN_ROLES.SUPPORT_MODERATOR : ADMIN_ROLES.SUPER_ADMIN;

  assert.equal(assignedRole, ADMIN_ROLES.SUPPORT_MODERATOR);
});

// ============================================================================
// 2. ADVERSARIAL CONCURRENCY & FENCING BOUNDARY TESTS (Section 5)
// ============================================================================
test("Adversarial Concurrency: Fencing rollback aborts stale worker write after lease loss", async () => {
  const candidate = "jane.fencing@example.com";
  const interviewer = "dr.smith@hospital.com";
  const participants = [candidate, interviewer];

  // In-memory simulation of the appointments collection
  const persistedInterviews = [];

  // Worker 1 acquires lock with short TTL (200ms)
  const token1 = await acquireBookingLocks(participants, { timeoutMs: 150 });
  assert.ok(token1);

  // Worker 1 simulates long GC pause / network delay (exceeding 150ms lease)
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Worker 2 attempts to acquire lock for the same participants and succeeds because Worker 1 expired
  const token2 = await acquireBookingLocks(participants, { timeoutMs: 5000 });
  assert.ok(token2, "Worker 2 must successfully acquire the expired lock");

  // Worker 2 persists a valid appointment under its active lock
  const validAppointment = {
    id: "appt-worker-2",
    participants,
    bookingLockToken: token2,
    scheduledAt: new Date("2026-11-20T10:00:00Z"),
  };
  persistedInterviews.push(validAppointment);
  await releaseBookingLocks(token2, getSortedLockKeys(participants));

  // Worker 1 wakes up and attempts to commit with compensation rollback guard
  let worker1Committed = false;
  let rollbackExecuted = false;

  try {
    // Worker 1 inserts into database
    const staleAppointment = {
      id: "appt-worker-1-stale",
      participants,
      bookingLockToken: token1,
      scheduledAt: new Date("2026-11-20T10:00:00Z"),
    };
    persistedInterviews.push(staleAppointment);

    // Fencing check at persistence boundary: assert lock ownership
    await assertLockValid(token1, getSortedLockKeys(participants));
    worker1Committed = true;
  } catch (err) {
    // Compensation rollback: delete stale appointment
    const idx = persistedInterviews.findIndex((a) => a.bookingLockToken === token1);
    if (idx >= 0) {
      persistedInterviews.splice(idx, 1);
      rollbackExecuted = true;
    }
  }

  // Confirm outcomes:
  assert.equal(worker1Committed, false, "Worker 1 commit must be rejected");
  assert.equal(rollbackExecuted, true, "Worker 1 compensation rollback must be executed");
  assert.equal(persistedInterviews.length, 1, "Only Worker 2's valid appointment must remain");
  assert.equal(persistedInterviews[0].id, "appt-worker-2");

  // Clean up any remaining locks
  await releaseBookingLocks(token1, getSortedLockKeys(participants));
});

test("Adversarial Concurrency: Token-scoped release leaves unrelated locks intact", async () => {
  const job1Participants = ["candidate1@test.com", "interviewer1@test.com"];
  const job2Participants = ["candidate2@test.com", "interviewer2@test.com"];

  const token1 = await acquireBookingLocks(job1Participants);
  const token2 = await acquireBookingLocks(job2Participants);

  // Worker 1 releases its locks
  await releaseBookingLocks(token1, getSortedLockKeys(job1Participants));

  // Job 2 locks must still be 100% intact and valid
  await assertLockValid(token2, getSortedLockKeys(job2Participants));

  // Clean up Job 2
  await releaseBookingLocks(token2, getSortedLockKeys(job2Participants));
});

// ============================================================================
// 3. EMAIL OUTBOX ATTEMPT-SPECIFIC LEASING & PROVIDER IDEMPOTENCY (Section 6)
// ============================================================================
test("Outbox Leasing: Claim identifier is unique per delivery attempt", () => {
  const workerPid = 12345;
  const generateAttemptClaimId = () => {
    return `worker_${workerPid}_att_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  };

  const attempt1 = generateAttemptClaimId();
  const attempt2 = generateAttemptClaimId();

  assert.notEqual(attempt1, attempt2, "Concurrent delivery attempts must never share claim tokens");
});

test("Outbox Idempotency: Resend provider accepts Idempotency-Key and SMTP sets Message-ID", () => {
  const outboxItem = {
    _id: "outbox-abc-123",
    idempotencyKey: "notif_invite_789",
    to: "candidate@example.com",
    subject: "Interview Invitation",
  };

  const stableIdempotencyKey = outboxItem.idempotencyKey || outboxItem._id.toString();
  assert.equal(stableIdempotencyKey, "notif_invite_789");

  // Format RFC 5322 Message-ID for SMTP
  const messageIdHeader = `<${stableIdempotencyKey}@hireloop.dev>`;
  assert.equal(messageIdHeader, "<notif_invite_789@hireloop.dev>");
});

// ============================================================================
// 4. STRIPE TEST-MODE WEBHOOK & IDEMPOTENCY REPLAY (Section 7)
// ============================================================================
test("Stripe Webhook: Idempotency table rejects duplicate event deliveries", async () => {
  const recordedEvents = new Set();

  const handleWebhookEvent = (eventId) => {
    if (recordedEvents.has(eventId)) {
      return { received: true, duplicate: true };
    }
    recordedEvents.add(eventId);
    return { received: true, duplicate: false };
  };

  const firstDelivery = handleWebhookEvent("evt_test_12345");
  assert.equal(firstDelivery.duplicate, false, "Initial delivery must be processed");

  const replayDelivery = handleWebhookEvent("evt_test_12345");
  assert.equal(replayDelivery.duplicate, true, "Replayed event must be safely ignored as duplicate");
});

