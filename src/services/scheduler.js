/**
 * Unified Scheduled Task Runner for HireLoop
 * Executes interview reminders, offline message digests, and email outbox delivery
 * on a bounded, restart-resilient background timer.
 */

import { processDueReminders } from "./reminderService.js";
import { processOfflineDigests } from "./digestService.js";
import { processPendingOutbox } from "./outboxWorker.js";

let schedulerInterval = null;
let isCycleRunning = false;

/**
 * Executes a single complete scheduler cycle.
 * Safe to call directly for testing or administrative triggers.
 */
export async function runSchedulerCycle() {
  if (isCycleRunning) return { skipped: true };
  isCycleRunning = true;

  const results = {
    remindersProcessed: 0,
    digestsSent: 0,
    outboxEmailsProcessed: 0,
    timestamp: new Date(),
    errors: [],
  };

  try {
    // 1. Process Due Interview Reminders
    try {
      results.remindersProcessed = await processDueReminders(15);
    } catch (err) {
      console.error("[Scheduler] Reminder processing error:", err.message);
      results.errors.push({ task: "reminders", error: err.message });
    }

    // 2. Process Offline Message Digests
    try {
      results.digestsSent = await processOfflineDigests();
    } catch (err) {
      console.error("[Scheduler] Digest processing error:", err.message);
      results.errors.push({ task: "digests", error: err.message });
    }

    // 3. Process Pending Email Outbox
    try {
      results.outboxEmailsProcessed = await processPendingOutbox(15);
    } catch (err) {
      console.error("[Scheduler] Outbox delivery error:", err.message);
      results.errors.push({ task: "outbox", error: err.message });
    }
  } finally {
    isCycleRunning = false;
  }

  return results;
}

/**
 * Starts the background scheduler loop.
 */
export function startScheduler(intervalMs = 30000) {
  if (schedulerInterval) return;

  // Run initial cycle shortly after startup (3 seconds delay to let connections settle)
  setTimeout(() => {
    runSchedulerCycle().catch((err) => {
      console.error("[Scheduler] Initial cycle failed:", err.message);
    });
  }, 3000);

  schedulerInterval = setInterval(() => {
    runSchedulerCycle().catch((err) => {
      console.error("[Scheduler] Scheduled cycle failed:", err.message);
    });
  }, intervalMs);

  if (schedulerInterval.unref) {
    schedulerInterval.unref();
  }

  console.log(`[Scheduler] Background scheduler initialized (interval: ${intervalMs / 1000}s)`);
}

/**
 * Gracefully terminates the scheduler loop.
 */
export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[Scheduler] Background scheduler stopped.");
  }
}
