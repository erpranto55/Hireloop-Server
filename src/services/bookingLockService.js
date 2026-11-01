/**
 * Distributed Atomic Booking Lock Service for HireLoop
 * Guarantees mutual exclusion and prevents concurrent double-booking of
 * candidates and interviewers across multiple server instances and simultaneous requests.
 *
 * Includes background heartbeat lease renewal and fencing token assertion to prevent
 * delayed workers from persisting changes after lease loss.
 */

import crypto from "node:crypto";
import { getDb } from "../db.js";

const DEFAULT_LOCK_TIMEOUT_MS = 10000; // 10s auto-release for stale locks
const DEFAULT_MAX_RETRIES = 12; // 12 retries * ~60ms = ~750ms total window
const BASE_RETRY_DELAY_MS = 50;

// In-memory fallback mutex map for test environments where MongoDB is simulated/mocked
const inMemoryLocks = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalizes and sorts participant lock keys to prevent deadlocks across concurrent requests.
 */
export function getSortedLockKeys(participantEmails = []) {
  const uniqueNormalized = [
    ...new Set(
      participantEmails
        .map((e) => (typeof e === "string" ? e : e?.email)?.toLowerCase().trim())
        .filter(Boolean)
    ),
  ];

  return uniqueNormalized.sort().map((email) => `participant:${email}`);
}

/**
 * Atomically acquires locks for all specified participant emails.
 * Uses MongoDB collection 'scheduling_locks' with unique index on 'lockKey'.
 * Returns the unique lockToken.
 */
export async function acquireBookingLocks(
  participantEmails = [],
  { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES } = {}
) {
  const lockKeys = getSortedLockKeys(participantEmails);
  if (lockKeys.length === 0) {
    return null;
  }

  const lockToken = crypto.randomUUID();
  let db = null;
  try {
    db = getDb();
  } catch {
    // Database connection not available, fall back to in-memory lock
  }

  const acquiredKeys = [];

  try {
    for (const key of lockKeys) {
      let acquired = false;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + timeoutMs);

        if (db && typeof db.collection === "function") {
          try {
            // Attempt 1: Insert new lock document
            await db.collection("scheduling_locks").insertOne({
              lockKey: key,
              lockToken,
              lockedAt: now,
              expiresAt,
            });
            acquired = true;
            break;
          } catch (err) {
            if (err.code === 11000) {
              // Duplicate key: check if the existing lock has expired
              const recovered = await db.collection("scheduling_locks").findOneAndUpdate(
                {
                  lockKey: key,
                  expiresAt: { $lt: now },
                },
                {
                  $set: {
                    lockToken,
                    lockedAt: now,
                    expiresAt,
                  },
                },
                { returnDocument: "after" }
              );

              if (recovered) {
                acquired = true;
                break;
              }
            } else {
              throw err;
            }
          }
        } else {
          // In-memory fallback
          const existing = inMemoryLocks.get(key);
          if (!existing || existing.expiresAt < now) {
            inMemoryLocks.set(key, { lockToken, expiresAt });
            acquired = true;
            break;
          }
        }

        // Lock currently held by another concurrent request; wait with jittered backoff
        const jitter = Math.floor(Math.random() * 30);
        await sleep(BASE_RETRY_DELAY_MS + jitter);
      }

      if (!acquired) {
        const error = new Error(
          `Scheduling lock could not be acquired for ${key} due to a concurrent booking request.`
        );
        error.code = "LOCK_BUSY";
        error.status = 409;
        throw error;
      }

      acquiredKeys.push(key);
    }

    return lockToken;
  } catch (err) {
    // Release any partially acquired locks before propagating error
    await releaseBookingLocks(lockToken, acquiredKeys);
    throw err;
  }
}

/**
 * Renews the lease for all specified lock keys belonging to lockToken.
 * Returns { renewed: boolean, lostCount: number }.
 */
export async function renewBookingLocks(lockToken, lockKeys = [], timeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  if (!lockToken || !lockKeys || lockKeys.length === 0) {
    return { renewed: true, lostCount: 0 };
  }

  let db = null;
  try {
    db = getDb();
  } catch {
    // DB not available
  }

  const now = new Date();
  const newExpiresAt = new Date(now.getTime() + timeoutMs);

  if (db && typeof db.collection === "function") {
    try {
      const result = await db.collection("scheduling_locks").updateMany(
        {
          lockToken,
          lockKey: { $in: lockKeys },
          expiresAt: { $gt: now },
        },
        {
          $set: {
            expiresAt: newExpiresAt,
            renewedAt: now,
          },
        }
      );

      const renewed = result.matchedCount === lockKeys.length;
      return {
        renewed,
        lostCount: lockKeys.length - result.matchedCount,
      };
    } catch (err) {
      console.error("[BookingLockService] Error renewing locks:", err.message);
      return { renewed: false, lostCount: lockKeys.length };
    }
  } else {
    // In-memory renewal
    let renewedCount = 0;
    for (const key of lockKeys) {
      const existing = inMemoryLocks.get(key);
      if (existing && existing.lockToken === lockToken && existing.expiresAt > now) {
        existing.expiresAt = newExpiresAt;
        renewedCount++;
      }
    }
    return {
      renewed: renewedCount === lockKeys.length,
      lostCount: lockKeys.length - renewedCount,
    };
  }
}

/**
 * Asserts that all specified lock keys are still actively held by lockToken and not expired.
 * Throws a 409 Conflict if any lock was lost or expired.
 */
export async function assertLockValid(lockToken, lockKeys = []) {
  if (!lockToken || !lockKeys || lockKeys.length === 0) return;

  let db = null;
  try {
    db = getDb();
  } catch {
    // DB not available
  }

  const now = new Date();

  if (db && typeof db.collection === "function") {
    const activeCount = await db.collection("scheduling_locks").countDocuments({
      lockToken,
      lockKey: { $in: lockKeys },
      expiresAt: { $gt: now },
    });

    if (activeCount !== lockKeys.length) {
      const error = new Error(
        "Booking lock lease was lost or expired during processing. Action aborted to prevent double-booking."
      );
      error.code = "LOCK_LEASE_LOST";
      error.status = 409;
      throw error;
    }
  } else {
    for (const key of lockKeys) {
      const existing = inMemoryLocks.get(key);
      if (!existing || existing.lockToken !== lockToken || existing.expiresAt <= now) {
        const error = new Error(
          "Booking lock lease was lost or expired during processing. Action aborted to prevent double-booking."
        );
        error.code = "LOCK_LEASE_LOST";
        error.status = 409;
        throw error;
      }
    }
  }
}

/**
 * Releases all locks associated with a lockToken, optionally restricted to specific keys.
 */
export async function releaseBookingLocks(lockToken, specificKeys = null) {
  if (!lockToken) return;

  let db = null;
  try {
    db = getDb();
  } catch {
    // DB not available
  }

  if (db && typeof db.collection === "function") {
    try {
      const deleteFilter = { lockToken };
      if (Array.isArray(specificKeys) && specificKeys.length > 0) {
        deleteFilter.lockKey = { $in: specificKeys };
      }
      await db.collection("scheduling_locks").deleteMany(deleteFilter);
    } catch (err) {
      console.error("[BookingLockService] Error releasing locks:", err.message);
    }
  } else {
    // In-memory release
    for (const [key, val] of inMemoryLocks.entries()) {
      if (val.lockToken === lockToken && (!specificKeys || specificKeys.includes(key))) {
        inMemoryLocks.delete(key);
      }
    }
  }
}

/**
 * High-level wrapper that executes an asynchronous critical section under atomic booking locks.
 * Continuously renews lease via background heartbeat while executing, and verifies lock validity
 * before completing to guarantee strict mutual exclusion.
 */
export async function withBookingLock(
  participantEmails,
  criticalSectionFn,
  { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES } = {}
) {
  const lockKeys = getSortedLockKeys(participantEmails);
  const lockToken = await acquireBookingLocks(participantEmails, { timeoutMs, maxRetries });

  let leaseLost = false;
  let heartbeatTimer = null;
  const rollbackFns = [];
  const registerRollback = (fn) => {
    if (typeof fn === "function") rollbackFns.push(fn);
  };

  if (lockToken && lockKeys.length > 0) {
    const heartbeatIntervalMs = Math.max(1000, Math.floor(timeoutMs / 3));
    heartbeatTimer = setInterval(async () => {
      try {
        const { renewed } = await renewBookingLocks(lockToken, lockKeys, timeoutMs);
        if (!renewed) {
          leaseLost = true;
        }
      } catch {
        leaseLost = true;
      }
    }, heartbeatIntervalMs);

    if (heartbeatTimer.unref) {
      heartbeatTimer.unref();
    }
  }

  const checkLockValidity = async () => {
    if (leaseLost) {
      const error = new Error(
        "Booking lock lease was lost or expired during processing. Action aborted to prevent double-booking."
      );
      error.code = "LOCK_LEASE_LOST";
      error.status = 409;
      throw error;
    }
    await assertLockValid(lockToken, lockKeys);
  };

  try {
    const result = await criticalSectionFn({
      lockToken,
      assertLockValid: checkLockValidity,
      registerRollback,
    });
    // Final fencing check before returning result
    if (lockToken && lockKeys.length > 0) {
      await checkLockValidity();
    }
    return result;
  } catch (err) {
    // If critical section or checkLockValidity failed, execute compensation rollbacks
    for (const rollback of rollbackFns) {
      try {
        await rollback();
      } catch (rbErr) {
        console.error("[BookingLockService] Rollback error:", rbErr.message);
      }
    }
    throw err;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    if (lockToken) {
      await releaseBookingLocks(lockToken, lockKeys);
    }
  }
}
