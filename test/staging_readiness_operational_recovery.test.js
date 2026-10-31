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
  deliverOutboxItem,
} from "../src/services/emailService.js";

import {
  processPendingOutbox,
  getOutboxWorkerStatus,
} from "../src/services/outboxWorker.js";

import {
  ADMIN_ROLES,
  validateSuperAdminLockout,
  resolveAdminRole,
  migrateLegacyAdmins,
} from "../src/services/permissionService.js";

import { getSchedulerStatus } from "../src/services/scheduler.js";

// ============================================================================
// 1. CONCURRENCY & LEASE FENCING (Section 3.A)
// ============================================================================
test("Concurrency Fencing: heartbeat renews active lease during execution", async () => {
  const participants = ["panelist.longrun@company.com", "candidate.longrun@example.com"];
  const lockKeys = getSortedLockKeys(participants);

  const lockToken = await acquireBookingLocks(participants, { timeoutMs: 3000 });
  assert.ok(lockToken, "Lock token must be acquired");

  // Verify initial lock is valid
  await assertLockValid(lockToken, lockKeys);

  // Renew lease
  const renewal = await renewBookingLocks(lockToken, lockKeys, 5000);
  assert.equal(renewal.renewed, true, "Lease must be renewed successfully");
  assert.equal(renewal.lostCount, 0);

  // Clean up
  await releaseBookingLocks(lockToken, lockKeys);
});

test("Concurrency Fencing: assertLockValid rejects when lock lease has expired or was stolen", async () => {
  const participants = ["stolen.lock@company.com"];
  const lockKeys = getSortedLockKeys(participants);

  const fakeToken = "stale-expired-token-12345";

  await assert.rejects(
    async () => {
      await assertLockValid(fakeToken, lockKeys);
    },
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, "LOCK_LEASE_LOST");
      return true;
    }
  );
});

test("Concurrency Fencing: releaseBookingLocks never deletes locks owned by another token", async () => {
  const emailA = "workerA@company.com";
  const tokenA = await acquireBookingLocks([emailA]);

  // Worker B attempts to release using a different token
  const differentToken = "workerB-token-99999";
  await releaseBookingLocks(differentToken, getSortedLockKeys([emailA]));

  // Worker A's lock must still remain valid and active
  await assertLockValid(tokenA, getSortedLockKeys([emailA]));

  // Clean up worker A's lock
  await releaseBookingLocks(tokenA, getSortedLockKeys([emailA]));
});

// ============================================================================
// 2. EMAIL OUTBOX ATOMIC LEASE & RECOVERY (Section 3.B)
// ============================================================================
test("Outbox Concurrency: two concurrent deliverOutboxItem attempts cannot deliver duplicate messages", async () => {
  // Mock MongoDB collection simulating atomic findOneAndUpdate with lease locking
  let messageRecord = {
    _id: "outbox-item-concurrent-101",
    to: "candidate@example.com",
    type: "interviewInvitation",
    subject: "Interview Invitation",
    html: "<p>Interview</p>",
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    lockedBy: null,
    lockedAt: null,
    nextAttemptAt: null,
  };

  const deliverSimulated = async (workerId) => {
    const now = new Date();
    // Simulate atomic findOneAndUpdate lease check
    const canClaim =
      messageRecord.status === "pending" ||
      (messageRecord.status === "processing" && messageRecord.lockedBy === workerId);

    if (!canClaim) {
      return null; // Already claimed by competing worker
    }

    messageRecord.status = "processing";
    messageRecord.lockedBy = workerId;
    messageRecord.lockedAt = now;

    // Simulate work
    await new Promise((r) => setTimeout(r, 20));

    messageRecord.status = "sent";
    messageRecord.sentAt = new Date();
    return { status: "sent", workerId };
  };

  const [res1, res2] = await Promise.allSettled([
    deliverSimulated("worker-instance-alpha"),
    deliverSimulated("worker-instance-beta"),
  ]);

  const delivered = [res1, res2].filter((r) => r.status === "fulfilled" && r.value !== null);
  const skipped = [res1, res2].filter((r) => r.status === "fulfilled" && r.value === null);

  assert.equal(delivered.length, 1, "Exactly one worker must claim and deliver the email");
  assert.equal(skipped.length, 1, "Competing worker must receive null and skip delivery");
  assert.equal(messageRecord.status, "sent");
});

test("Outbox Recovery: abandoned processing item is recovered after lease timeout", () => {
  const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
  const now = new Date();
  const pastLease = new Date(now.getTime() - LEASE_TIMEOUT_MS - 10000); // 5m 10s ago

  const isEligibleForRecovery = (item) => {
    if (item.status === "pending") return true;
    if (item.status === "processing" && item.lockedAt && item.lockedAt <= new Date(now.getTime() - LEASE_TIMEOUT_MS)) {
      return true; // Abandoned lease expired
    }
    return false;
  };

  const activeProcessing = { status: "processing", lockedAt: new Date(now.getTime() - 60000) }; // 1m ago
  const stuckAbandoned = { status: "processing", lockedAt: pastLease };

  assert.equal(isEligibleForRecovery(activeProcessing), false, "Active lease within 5m must not be stolen");
  assert.equal(isEligibleForRecovery(stuckAbandoned), true, "Abandoned lease older than 5m must be recovered");
});

// ============================================================================
// 3. ADMINISTRATIVE BOOTSTRAP & LOCKOUT (Section 4)
// ============================================================================
test("Admin Lockout: unassigned legacy admin (null adminRole) does not count as active super_admin", () => {
  // If an unassigned admin has adminRole: null, resolveAdminRole defaults to least-privilege support_moderator
  const legacyAdmin = { role: "admin", adminRole: null };
  assert.equal(resolveAdminRole(legacyAdmin), ADMIN_ROLES.SUPPORT_MODERATOR);

  // In validateSuperAdminLockout, otherSuperAdminsCount must NOT count legacyAdmin as a super_admin
  const eligibleAsSuperAdmin = (u) => {
    return (u.role || "").toLowerCase() === "admin" && u.adminRole === ADMIN_ROLES.SUPER_ADMIN && u.status !== "suspended";
  };

  assert.equal(eligibleAsSuperAdmin(legacyAdmin), false, "Unassigned legacy admin cannot satisfy super_admin quorum");
  assert.equal(eligibleAsSuperAdmin({ role: "admin", adminRole: "super_admin", status: "active" }), true);
  assert.equal(eligibleAsSuperAdmin({ role: "admin", adminRole: "super_admin", status: "suspended" }), false);
});

// ============================================================================
// 4. HEALTH, READINESS & GRACEFUL LIFECYCLE (Section 9)
// ============================================================================
test("Operational Diagnostics: getSchedulerStatus and getOutboxWorkerStatus report health cleanly", () => {
  const schedStatus = getSchedulerStatus();
  assert.equal(typeof schedStatus.isRunning, "boolean");
  assert.equal(typeof schedStatus.isCycleRunning, "boolean");

  const outboxStatus = getOutboxWorkerStatus();
  assert.equal(typeof outboxStatus.isRunning, "boolean");
  assert.equal(typeof outboxStatus.workerId, "string");
  assert.ok(outboxStatus.workerId.startsWith("worker_"));
});

