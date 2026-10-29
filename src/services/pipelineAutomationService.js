/**
 * Recruitment Pipeline Automation Service for HireLoop
 * Implements configurable, company-scoped recruitment workflow automation rules
 * based on completed candidate evaluation scorecards, interview outcomes,
 * and explicit business criteria, while strictly preserving authorized human decision-making.
 */

import { getDb, toObjectId } from "../db.js";
import { recordAuditLog } from "./auditService.js";
import { createNotification } from "./notificationService.js";
import {
  APPLICATION_STATUSES,
  ALLOWED_STATUS_TRANSITIONS,
} from "../routes/applications.js";
import {
  getApplicationEvaluationSummary,
  OVERALL_RECOMMENDATIONS,
} from "./scorecardService.js";
import {
  verifyCompanyAccess,
  COMPANY_ROLES,
} from "./companyWorkspaceService.js";

// Supported Automation Triggers
export const AUTOMATION_TRIGGERS = Object.freeze({
  ALL_EVALUATIONS_SUBMITTED: "all_evaluations_submitted",
  INTERVIEW_COMPLETED: "interview_completed",
  EVALUATION_THRESHOLD_MET: "evaluation_threshold_met",
});

export const ALLOWED_TRIGGERS = Object.values(AUTOMATION_TRIGGERS);

// Supported Automation Actions
export const AUTOMATION_ACTIONS = Object.freeze({
  MARK_READY_FOR_REVIEW: "mark_ready_for_review",
  ADVANCE_STAGE: "advance_stage",
  NOTIFY_HIRING_MANAGER: "notify_hiring_manager",
});

export const ALLOWED_ACTIONS = Object.values(AUTOMATION_ACTIONS);

// Consequential Stages that require explicit human approval by default
const CONSEQUENTIAL_STAGES = ["Offered", "Accepted", "Rejected"];

/**
 * Creates a new pipeline automation rule for a company workspace or specific vacancy.
 */
export async function createAutomationRule({
  companyId,
  jobId = null,
  name,
  description = "",
  trigger,
  conditions = {},
  action,
  targetStage = null,
  allowConsequentialTransition = false,
  user,
}) {
  if (!companyId) throw new Error("companyId is required.");
  if (!name || name.trim().length < 3) throw new Error("Rule name must be at least 3 characters.");

  if (!ALLOWED_TRIGGERS.includes(trigger)) {
    throw new Error(`Invalid trigger "${trigger}". Allowed: ${ALLOWED_TRIGGERS.join(", ")}`);
  }

  if (!ALLOWED_ACTIONS.includes(action)) {
    throw new Error(`Invalid action "${action}". Allowed: ${ALLOWED_ACTIONS.join(", ")}`);
  }

  // Validate action constraints
  if (action === AUTOMATION_ACTIONS.ADVANCE_STAGE) {
    if (!targetStage) {
      throw new Error("targetStage is required when action is 'advance_stage'.");
    }
    const matchedStage = APPLICATION_STATUSES.find(
      (s) => s.toLowerCase() === targetStage.toLowerCase()
    );
    if (!matchedStage) {
      throw new Error(`Invalid targetStage "${targetStage}". Allowed: ${APPLICATION_STATUSES.join(", ")}`);
    }
    targetStage = matchedStage;

    if (CONSEQUENTIAL_STAGES.includes(targetStage) && !allowConsequentialTransition) {
      throw new Error(
        `Automated transition directly to "${targetStage}" is a consequential hiring outcome. ` +
        `Preserve authorized human decision-making or explicitly specify allowConsequentialTransition: true.`
      );
    }
  }

  // Sanitize conditions
  const sanitizedConditions = {
    minScore: typeof conditions.minScore === "number" ? Math.max(1, Math.min(5, conditions.minScore)) : 3.0,
    minEvaluations: typeof conditions.minEvaluations === "number" ? Math.max(1, Math.min(10, conditions.minEvaluations)) : 1,
    currentStage: conditions.currentStage ? conditions.currentStage.trim() : null,
  };

  const db = getDb();
  const ruleDoc = {
    companyId: companyId.toString(),
    jobId: jobId ? jobId.toString() : null,
    name: name.trim(),
    description: (description || "").trim(),
    trigger,
    conditions: sanitizedConditions,
    action,
    targetStage: action === AUTOMATION_ACTIONS.ADVANCE_STAGE ? targetStage : null,
    allowConsequentialTransition: Boolean(allowConsequentialTransition),
    isEnabled: true,
    createdBy: user?.email || "system",
    updatedBy: user?.email || "system",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection("pipeline_automation_rules").insertOne(ruleDoc);
  ruleDoc._id = result.insertedId;

  recordAuditLog({
    actor: user,
    companyId: companyId.toString(),
    action: "automation_rule_created",
    targetType: "automation_rule",
    targetId: ruleDoc._id.toString(),
    targetIdentifier: `${name} (${trigger} -> ${action})`,
    after: { name, trigger, action, targetStage, jobId },
  });

  return ruleDoc;
}

/**
 * Updates an existing automation rule.
 */
export async function updateAutomationRule(ruleId, updates, user) {
  const _id = toObjectId(ruleId);
  if (!_id) throw new Error("Invalid rule ID");

  const db = getDb();
  const existing = await db.collection("pipeline_automation_rules").findOne({ _id });
  if (!existing) throw new Error("Automation rule not found.");

  const setPayload = {
    updatedAt: new Date(),
    updatedBy: user?.email || "system",
  };

  if (updates.name && updates.name.trim().length >= 3) {
    setPayload.name = updates.name.trim();
  }
  if (typeof updates.description === "string") {
    setPayload.description = updates.description.trim();
  }
  if (typeof updates.isEnabled === "boolean") {
    setPayload.isEnabled = updates.isEnabled;
  }
  if (updates.trigger && ALLOWED_TRIGGERS.includes(updates.trigger)) {
    setPayload.trigger = updates.trigger;
  }
  if (updates.action && ALLOWED_ACTIONS.includes(updates.action)) {
    setPayload.action = updates.action;
  }
  if (updates.targetStage) {
    const matchedStage = APPLICATION_STATUSES.find(
      (s) => s.toLowerCase() === updates.targetStage.toLowerCase()
    );
    if (matchedStage) setPayload.targetStage = matchedStage;
  }
  if (typeof updates.allowConsequentialTransition === "boolean") {
    setPayload.allowConsequentialTransition = updates.allowConsequentialTransition;
  }
  if (updates.conditions && typeof updates.conditions === "object") {
    setPayload.conditions = {
      ...existing.conditions,
      ...updates.conditions,
    };
  }

  const updated = await db.collection("pipeline_automation_rules").findOneAndUpdate(
    { _id },
    { $set: setPayload },
    { returnDocument: "after" }
  );

  recordAuditLog({
    actor: user,
    companyId: existing.companyId,
    action: "automation_rule_updated",
    targetType: "automation_rule",
    targetId: _id.toString(),
    targetIdentifier: updated.name,
    before: { isEnabled: existing.isEnabled, action: existing.action },
    after: { isEnabled: updated.isEnabled, action: updated.action },
  });

  return updated;
}

/**
 * Lists automation rules for a company workspace and optional vacancy.
 */
export async function listAutomationRules(companyId, jobId = null) {
  if (!companyId) return [];
  const db = getDb();
  const filter = {
    companyId: companyId.toString(),
  };

  if (jobId) {
    filter.$or = [{ jobId: jobId.toString() }, { jobId: null }];
  }

  return await db.collection("pipeline_automation_rules")
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray();
}

/**
 * Toggles the enabled state of an automation rule.
 */
export async function toggleAutomationRule(ruleId, isEnabled, user) {
  return await updateAutomationRule(ruleId, { isEnabled: Boolean(isEnabled) }, user);
}

/**
 * Evaluates active pipeline automation rules for a triggered event.
 * Guarantees:
 * - Immediate pre-execution state revalidation.
 * - Idempotency through unique execution records.
 * - Enforces ALLOWED_STATUS_TRANSITIONS.
 * - Consequential outcomes require human approval.
 * - Audit logging and non-leaking notifications.
 */
export async function evaluatePipelineAutomation({
  trigger,
  applicationId,
  jobId,
  companyId,
  metadata = {},
}) {
  if (!trigger || !applicationId) {
    return { executed: 0, skipped: 0, errors: [] };
  }

  const db = getDb();
  const appObjectId = toObjectId(applicationId);
  const application = appObjectId ? await db.collection("applications").findOne({ _id: appObjectId }) : null;
  if (!application) {
    return { executed: 0, skipped: 1, reason: "Application not found" };
  }

  const currentJobId = (jobId || application.jobId)?.toString();
  const currentCompanyId = (companyId || application.companyId)?.toString();

  // Find all active rules matching company and trigger
  const ruleFilter = {
    companyId: currentCompanyId,
    trigger,
    isEnabled: true,
    $or: [{ jobId: currentJobId }, { jobId: null }],
  };

  const matchingRules = await db.collection("pipeline_automation_rules").find(ruleFilter).toArray();
  if (matchingRules.length === 0) {
    return { executed: 0, skipped: 0, matchingRulesCount: 0 };
  }

  const jobObjectId = toObjectId(currentJobId);
  const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;

  const results = {
    executed: 0,
    skipped: 0,
    rulesEvaluated: matchingRules.length,
    details: [],
  };

  for (const rule of matchingRules) {
    const ruleIdStr = rule._id.toString();
    const currentStatus = application.status || "Applied";

    // Idempotency key per rule, application, trigger, and current status stage
    const idempotencyKey = `rule_${ruleIdStr}_app_${applicationId}_stage_${currentStatus}_trig_${trigger}`;

    // Atomically claim execution slot to prevent race conditions across parallel workers
    try {
      const claimResult = await db.collection("automation_execution_logs").insertOne({
        ruleId: ruleIdStr,
        ruleName: rule.name,
        companyId: currentCompanyId,
        jobId: currentJobId,
        applicationId: applicationId.toString(),
        candidateEmail: application.seekerEmail,
        candidateName: application.seekerName || "Candidate",
        jobTitle: application.jobTitle,
        trigger,
        action: rule.action,
        status: "pending",
        idempotencyKey,
        claimedAt: new Date(),
      });

      // 1. Evaluate Rule Conditions
      let conditionMet = true;
      let skipReason = null;

      // Condition: Current Stage filter
      if (rule.conditions?.currentStage && rule.conditions.currentStage.toLowerCase() !== currentStatus.toLowerCase()) {
        conditionMet = false;
        skipReason = `Application stage "${currentStatus}" does not match rule requirement "${rule.conditions.currentStage}"`;
      }

      // Condition: Evaluation Metrics (for evaluation triggers)
      let evalSummary = null;
      if (conditionMet && (trigger === AUTOMATION_TRIGGERS.ALL_EVALUATIONS_SUBMITTED || trigger === AUTOMATION_TRIGGERS.EVALUATION_THRESHOLD_MET)) {
        try {
          evalSummary = await getApplicationEvaluationSummary(applicationId, {
            email: "system@hireloop.internal",
            role: "admin",
          });
        } catch (err) {
          conditionMet = false;
          skipReason = `Failed to compute evaluation metrics: ${err.message}`;
        }

        if (conditionMet && trigger === AUTOMATION_TRIGGERS.ALL_EVALUATIONS_SUBMITTED) {
          const minEvals = rule.conditions?.minEvaluations || 1;
          if (evalSummary.submittedEvaluationsCount < minEvals) {
            conditionMet = false;
            skipReason = `Submitted evaluations (${evalSummary.submittedEvaluationsCount}) below required minimum (${minEvals})`;
          }
          if (rule.conditions?.requireAllAssigned && !evalSummary.readyForDecision) {
            conditionMet = false;
            skipReason = `Pending evaluations remaining from assigned reviewers.`;
          }
        }

        if (conditionMet && trigger === AUTOMATION_TRIGGERS.EVALUATION_THRESHOLD_MET) {
          const minScore = rule.conditions?.minScore || 3.5;
          if (evalSummary.overallWeightedAverage < minScore) {
            conditionMet = false;
            skipReason = `Candidate weighted score (${evalSummary.overallWeightedAverage}) is below threshold (${minScore})`;
          }
        }
      }

      if (!conditionMet) {
        await db.collection("automation_execution_logs").updateOne(
          { _id: claimResult.insertedId },
          { $set: { status: "skipped", reason: skipReason, completedAt: new Date() } }
        );
        results.skipped++;
        results.details.push({ ruleName: rule.name, status: "skipped", reason: skipReason });
        continue;
      }

      // 2. Execute Action
      let actionOutcome = null;

      if (rule.action === AUTOMATION_ACTIONS.MARK_READY_FOR_REVIEW) {
        // Mark application reviewStatus as "ready_for_decision"
        await db.collection("applications").updateOne(
          { _id: appObjectId },
          {
            $set: {
              reviewStatus: "ready_for_decision",
              reviewStatusUpdatedAt: new Date(),
              updatedAt: new Date(),
            },
          }
        );

        // Notify hiring managers / job recruiter
        const recipientEmail = job?.recruiterEmail || application.recruiterEmail;
        if (recipientEmail) {
          createNotification({
            recipientEmail,
            role: "recruiter",
            type: "candidate_ready_for_decision",
            title: `Candidate Ready for Decision: ${application.seekerName || "Candidate"}`,
            message: `Evaluation milestone reached for ${application.jobTitle}. Candidate is ready for final hiring decision.`,
            link: `/dashboard/jobs/${currentJobId}/applicants`,
            referenceId: applicationId.toString(),
            referenceType: "application",
            idempotencyKey: `notif_ready_${ruleIdStr}_${applicationId}`,
            sendEmail: true,
            emailTemplate: "candidateReadyForDecision",
            emailData: {
              candidateName: application.seekerName || "Candidate",
              jobTitle: application.jobTitle,
              companyName: application.companyName,
              evaluationCount: evalSummary?.submittedEvaluationsCount || "Completed",
              averageScore: evalSummary?.overallWeightedAverage,
              viewUrl: `/dashboard/jobs/${currentJobId}/applicants`,
            },
          }).catch(() => {});
        }

        actionOutcome = "Marked application reviewStatus as ready_for_decision and notified hiring team.";
      } else if (rule.action === AUTOMATION_ACTIONS.ADVANCE_STAGE) {
        const targetStage = rule.targetStage;
        if (!targetStage) {
          throw new Error("No targetStage configured for advance_stage action.");
        }

        // Validate permitted status transition
        const allowed = ALLOWED_STATUS_TRANSITIONS[currentStatus] || [];
        const isAllowed = allowed.some((s) => s.toLowerCase() === targetStage.toLowerCase());

        if (!isAllowed) {
          throw new Error(
            `Cannot automatically advance application status from "${currentStatus}" to "${targetStage}". ` +
            `Permitted next stages: ${allowed.join(", ") || "None"}.`
          );
        }

        // Consequential stage guardrail
        if (CONSEQUENTIAL_STAGES.includes(targetStage) && !rule.allowConsequentialTransition) {
          throw new Error(
            `Automated transition to "${targetStage}" was halted: consequential hiring decision requires human confirmation.`
          );
        }

        const statusHistoryEntry = {
          from: currentStatus,
          to: targetStage,
          changedBy: `automation:${ruleIdStr}`,
          changedAt: new Date(),
          note: `Automated stage progression triggered by rule "${rule.name}" (${trigger})`,
        };

        await db.collection("applications").updateOne(
          { _id: appObjectId },
          {
            $set: { status: targetStage, updatedAt: new Date() },
            $push: { statusHistory: statusHistoryEntry },
          }
        );

        // Notify seeker cleanly (without revealing internal notes or scorecard scores)
        if (application.seekerEmail) {
          createNotification({
            recipientEmail: application.seekerEmail,
            role: "seeker",
            type: "application_status_changed",
            title: `Application Status: ${targetStage}`,
            message: `Your application for ${application.jobTitle} at ${application.companyName} has moved to "${targetStage}".`,
            link: `/dashboard/seeker/applications`,
            referenceId: applicationId.toString(),
            referenceType: "application",
            idempotencyKey: `app_status_${applicationId}_${targetStage}_${ruleIdStr}`,
            sendEmail: true,
            emailTemplate: "applicationStatusChanged",
            emailData: {
              jobTitle: application.jobTitle,
              companyName: application.companyName,
              newStatus: targetStage,
              viewUrl: `/dashboard/seeker/applications`,
            },
          }).catch(() => {});
        }

        // Notify recruiter of automated transition
        const recipientEmail = job?.recruiterEmail || application.recruiterEmail;
        if (recipientEmail) {
          createNotification({
            recipientEmail,
            role: "recruiter",
            type: "pipeline_automation_executed",
            title: `Pipeline Automation: ${application.seekerName || "Candidate"} moved to ${targetStage}`,
            message: `Rule "${rule.name}" automatically progressed candidate from "${currentStatus}" to "${targetStage}".`,
            link: `/dashboard/jobs/${currentJobId}/applicants`,
            referenceId: applicationId.toString(),
            referenceType: "application",
            idempotencyKey: `notif_prog_${ruleIdStr}_${applicationId}_${targetStage}`,
            sendEmail: true,
            emailTemplate: "pipelineAutomationTriggered",
            emailData: {
              ruleName: rule.name,
              candidateName: application.seekerName || "Candidate",
              jobTitle: application.jobTitle,
              fromStatus: currentStatus,
              toStatus: targetStage,
              actionName: "Stage Progression",
              viewUrl: `/dashboard/jobs/${currentJobId}/applicants`,
            },
          }).catch(() => {});
        }

        actionOutcome = `Advanced application status from "${currentStatus}" to "${targetStage}".`;
      } else if (rule.action === AUTOMATION_ACTIONS.NOTIFY_HIRING_MANAGER) {
        const recipientEmail = job?.recruiterEmail || application.recruiterEmail;
        if (recipientEmail) {
          createNotification({
            recipientEmail,
            role: "recruiter",
            type: "pipeline_automation_notice",
            title: `Pipeline Alert: ${rule.name}`,
            message: `Trigger "${trigger}" satisfied for candidate ${application.seekerName || application.seekerEmail} on ${application.jobTitle}.`,
            link: `/dashboard/jobs/${currentJobId}/applicants`,
            referenceId: applicationId.toString(),
            referenceType: "application",
            idempotencyKey: `notif_alert_${ruleIdStr}_${applicationId}`,
            sendEmail: true,
            emailTemplate: "pipelineAutomationTriggered",
            emailData: {
              ruleName: rule.name,
              candidateName: application.seekerName || "Candidate",
              jobTitle: application.jobTitle,
              actionName: "Recruiter Notification",
              viewUrl: `/dashboard/jobs/${currentJobId}/applicants`,
            },
          }).catch(() => {});
        }
        actionOutcome = "Dispatched notification and alert email to hiring manager.";
      }

      // Mark execution log as successful
      await db.collection("automation_execution_logs").updateOne(
        { _id: claimResult.insertedId },
        {
          $set: {
            status: "executed",
            outcome: actionOutcome,
            completedAt: new Date(),
          },
        }
      );

      recordAuditLog({
        actor: { email: `automation:${ruleIdStr}`, role: "system", name: rule.name },
        companyId: currentCompanyId,
        action: "pipeline_automation_executed",
        targetType: "application",
        targetId: applicationId.toString(),
        targetIdentifier: `${application.jobTitle} - ${application.seekerEmail}`,
        after: { ruleId: ruleIdStr, ruleName: rule.name, action: rule.action, outcome: actionOutcome },
      });

      results.executed++;
      results.details.push({ ruleName: rule.name, status: "executed", outcome: actionOutcome });
    } catch (err) {
      if (err.code === 11000) {
        // Idempotency collision - already executed
        results.skipped++;
        results.details.push({ ruleName: rule.name, status: "skipped", reason: "Already executed (idempotency)" });
        continue;
      }

      console.error(`[PipelineAutomation] Error executing rule ${rule.name}:`, err.message);
      results.details.push({ ruleName: rule.name, status: "failed", error: err.message });

      // Record failed execution log
      await db.collection("automation_execution_logs").updateOne(
        { ruleId: ruleIdStr, applicationId: applicationId.toString(), idempotencyKey },
        { $set: { status: "failed", error: err.message, failedAt: new Date() } },
        { upsert: true }
      );
    }
  }

  return results;
}

/**
 * Retrieves recent automation execution logs for a company workspace.
 */
export async function getAutomationExecutionLogs(companyId, limit = 50) {
  if (!companyId) return [];
  const db = getDb();
  return await db.collection("automation_execution_logs")
    .find({ companyId: companyId.toString() })
    .sort({ claimedAt: -1, completedAt: -1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 50)))
    .toArray();
}
