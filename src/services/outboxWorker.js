/**
 * Reliable Email Outbox Worker for HireLoop
 * Polls, recovers, and delivers pending transactional emails across application restarts
 * and multiple backend instances using atomic lease locking.
 */

import { getDb } from "../db.js";
import { deliverOutboxItem } from "./emailService.js";

const WORKER_ID = `worker_${process.pid}_${Math.random().toString(36).substring(2, 7)}`;
const LEASE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes lease before recovering stuck items
const BATCH_SIZE = 10;

let workerInterval = null;
let isProcessing = false;

/**
 * Atomically claims and delivers pending outbox records.
 * Returns the count of records successfully processed.
 */
export async function processPendingOutbox(limit = BATCH_SIZE) {
  let db;
  try {
    db = getDb();
  } catch {
    // Database not connected yet
    return 0;
  }

  let processedCount = 0;
  const now = new Date();

  for (let i = 0; i < limit; i++) {
    // Atomic lease acquisition: claims a pending item or an abandoned processing item
    const claimFilter = {
      $or: [
        {
          status: "pending",
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
          attempts: { $lt: 3 },
        },
        {
          status: "processing",
          lockedAt: { $lte: new Date(now.getTime() - LEASE_TIMEOUT_MS) },
          attempts: { $lt: 3 },
        },
      ],
    };

    const claimed = await db.collection("email_outbox").findOneAndUpdate(
      claimFilter,
      {
        $set: {
          status: "processing",
          lockedAt: now,
          lockedBy: WORKER_ID,
          updatedAt: now,
        },
      },
      { returnDocument: "after" }
    );

    if (!claimed) {
      break; // No more eligible outbox items in this cycle
    }

    try {
      await deliverOutboxItem(claimed._id);
      processedCount++;
    } catch (err) {
      // deliverOutboxItem handles failure updating status to failed / pending with exponential backoff
      console.error(`[OutboxWorker] Delivery error for outbox ${claimed._id}:`, err.message);
    }
  }

  return processedCount;
}

/**
 * Starts the periodic outbox polling loop.
 */
export function startOutboxWorker(intervalMs = 20000) {
  if (workerInterval) return;

  workerInterval = setInterval(async () => {
    if (isProcessing) return;
    isProcessing = true;
    try {
      await processPendingOutbox();
    } catch (err) {
      console.error("[OutboxWorker] Unexpected worker cycle error:", err.message);
    } finally {
      isProcessing = false;
    }
  }, intervalMs);

  if (workerInterval.unref) {
    workerInterval.unref();
  }
}

/**
 * Stops the periodic outbox polling loop.
 */
export function stopOutboxWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}
