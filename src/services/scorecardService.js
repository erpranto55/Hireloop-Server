/**
 * Structured Candidate Evaluation Scorecard Service for HireLoop
 * Implements versioned scorecard templates, configurable 1-5 rating rubrics,
 * weighted scoring, collaborative evaluations with draft/submission lifecycles,
 * role-isolated evaluator feedback, and aggregated candidate metrics.
 */

import { getDb, toObjectId } from "../db.js";
import { recordAuditLog } from "./auditService.js";
import { createNotification } from "./notificationService.js";
import {
  verifyVacancyAccess,
  COMPANY_ROLES,
} from "./companyWorkspaceService.js";

// Standard 1–5 Rating Scale & Descriptive Guidance
export const RATING_SCALE = Object.freeze({
  MIN: 1,
  MAX: 5,
  GUIDANCE: Object.freeze({
    1: "Unsatisfactory - Critical gaps; significantly below role requirements.",
    2: "Below Expectations - Developing; requires substantial guidance and supervision.",
    3: "Meets Expectations - Solid competency; autonomous and fulfills core expectations.",
    4: "Exceeds Expectations - Strong performance; independently resolves complex challenges.",
    5: "Exceptional - Distinguished mastery; acts as a role model and thought leader.",
  }),
});

// Standard Recommendations
export const OVERALL_RECOMMENDATIONS = Object.freeze({
  STRONG_HIRE: "strong_hire",
  HIRE: "hire",
  LEAN_HIRE: "lean_hire",
  LEAN_NO_HIRE: "lean_no_hire",
  NO_HIRE: "no_hire",
});

export const ALLOWED_RECOMMENDATIONS = Object.values(OVERALL_RECOMMENDATIONS);

// Supported Criteria Categories
export const CRITERIA_CATEGORIES = Object.freeze([
  "technical",
  "behavioral",
  "experience",
  "domain",
]);

// Protected / Discriminatory keywords strictly rejected from criteria
const PROHIBITED_CRITERIA_KEYWORDS = [
  "race",
  "religion",
  "gender",
  "ethnicity",
  "marital",
  "sexual orientation",
  "disability",
  "age",
  "political",
  "pregnancy",
  "national origin",
  "caste",
  "tribe",
];

// Baseline evaluation criteria for default scorecards
export const DEFAULT_CRITERIA = Object.freeze([
  {
    id: "role_competency",
    name: "Role Competency & Technical Depth",
    category: "technical",
    description: "Evaluates depth of job-relevant capabilities, core problem solving, and tooling proficiency.",
    weight: 2,
    isRequired: true,
  },
  {
    id: "analytical_thinking",
    name: "Problem Solving & Analytical Ability",
    category: "behavioral",
    description: "Assesses structure in ambiguous scenarios, trade-off evaluation, and practical solution design.",
    weight: 2,
    isRequired: true,
  },
  {
    id: "communication_teamwork",
    name: "Communication & Collaboration",
    category: "behavioral",
    description: "Evaluates verbal/written clarity, constructive listening, and cross-functional empathy.",
    weight: 1,
    isRequired: true,
  },
  {
    id: "track_record",
    name: "Relevant Track Record & Execution",
    category: "experience",
    description: "Demonstrated reliability and concrete outcomes in similar environments or scopes.",
    weight: 1,
    isRequired: false,
  },
  {
    id: "values_growth",
    name: "Growth Mindset & Operating Values",
    category: "domain",
    description: "Receptiveness to feedback, continuous learning, and alignment with team operating values.",
    weight: 1,
    isRequired: false,
  },
]);

/**
 * Validates a single criterion definition.
 */
export function validateCriterion(c, index = 0) {
  if (!c || typeof c !== "object") {
    throw new Error(`Criterion at index ${index} must be an object.`);
  }

  const name = (c.name || "").trim();
  if (name.length < 2 || name.length > 120) {
    throw new Error(`Criterion "${name || index}" name must be between 2 and 120 characters.`);
  }

  const lowerName = name.toLowerCase();
  for (const keyword of PROHIBITED_CRITERIA_KEYWORDS) {
    if (lowerName.includes(keyword)) {
      throw new Error(`Criterion "${name}" contains prohibited or discriminatory term "${keyword}".`);
    }
  }

  const category = (c.category || "technical").toLowerCase();
  if (!CRITERIA_CATEGORIES.includes(category)) {
    throw new Error(
      `Invalid category "${category}" for criterion "${name}". Allowed: ${CRITERIA_CATEGORIES.join(", ")}`
    );
  }

  const weight = typeof c.weight === "number" ? c.weight : 1;
  if (isNaN(weight) || weight <= 0 || weight > 100) {
    throw new Error(`Criterion "${name}" weight must be a positive number between 1 and 100.`);
  }

  const id = (c.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "_")).replace(/^_+|_+$/g, "");

  return {
    id: id || `crit_${index + 1}`,
    name,
    category,
    description: (c.description || "").trim(),
    weight: Math.round(weight * 10) / 10,
    isRequired: c.isRequired !== false,
  };
}

/**
 * Calculates normalized weighted score from criterion ratings and weights.
 * Formula: Sum(rating * weight) / Sum(weight)
 * Returns a number rounded to 2 decimal places on a 1.0 - 5.0 scale.
 * Missing / unrated criteria are excluded from the denominator.
 */
export function calculateWeightedScore(scores, criteria) {
  if (!Array.isArray(scores) || scores.length === 0) return 0;

  const criteriaMap = new Map((criteria || []).map((c) => [c.id, c]));
  let weightedSum = 0;
  let totalWeight = 0;

  for (const s of scores) {
    if (typeof s.rating !== "number" || isNaN(s.rating) || s.rating < 1 || s.rating > 5) {
      continue;
    }
    const criterion = criteriaMap.get(s.criterionId);
    const weight = criterion && typeof criterion.weight === "number" && criterion.weight > 0 ? criterion.weight : 1;
    weightedSum += s.rating * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  return Math.round((weightedSum / totalWeight) * 100) / 100;
}

/**
 * Creates a new Scorecard Template for a company workspace or specific vacancy.
 */
export async function createScorecardTemplate({
  companyId,
  jobId = null,
  interviewType = "General",
  name,
  description = "",
  criteria = DEFAULT_CRITERIA,
  user,
}) {
  if (!companyId) throw new Error("companyId is required to create a template.");
  if (!name || name.trim().length < 3) throw new Error("Template name must be at least 3 characters.");

  const sanitizedCriteria = (criteria && criteria.length > 0 ? criteria : DEFAULT_CRITERIA).map(
    (c, idx) => validateCriterion(c, idx)
  );

  const db = getDb();
  const templateDoc = {
    companyId: companyId.toString(),
    jobId: jobId ? jobId.toString() : null,
    interviewType: (interviewType || "General").trim(),
    name: name.trim(),
    description: (description || "").trim(),
    version: 1,
    isActive: true,
    permittedRatingRange: { min: RATING_SCALE.MIN, max: RATING_SCALE.MAX },
    ratingGuidance: RATING_SCALE.GUIDANCE,
    criteria: sanitizedCriteria,
    createdBy: user?.email || "system",
    updatedBy: user?.email || "system",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection("scorecard_templates").insertOne(templateDoc);
  templateDoc._id = result.insertedId;

  recordAuditLog({
    actor: user,
    companyId: companyId.toString(),
    action: "scorecard_template_created",
    targetType: "scorecard_template",
    targetId: templateDoc._id.toString(),
    targetIdentifier: `${name} (v1)`,
    after: { name, criteriaCount: sanitizedCriteria.length, jobId },
  });

  return templateDoc;
}

/**
 * Updates a Scorecard Template and increments its version to preserve historical meaning.
 */
export async function updateScorecardTemplate(templateId, updates, user) {
  const _id = toObjectId(templateId);
  if (!_id) throw new Error("Invalid template ID");

  const db = getDb();
  const existing = await db.collection("scorecard_templates").findOne({ _id });
  if (!existing) throw new Error("Scorecard template not found.");

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
  if (typeof updates.interviewType === "string") {
    setPayload.interviewType = updates.interviewType.trim();
  }
  if (typeof updates.isActive === "boolean") {
    setPayload.isActive = updates.isActive;
  }

  let criteriaChanged = false;
  if (Array.isArray(updates.criteria) && updates.criteria.length > 0) {
    setPayload.criteria = updates.criteria.map((c, idx) => validateCriterion(c, idx));
    setPayload.version = (existing.version || 1) + 1;
    criteriaChanged = true;
  }

  const updated = await db.collection("scorecard_templates").findOneAndUpdate(
    { _id },
    { $set: setPayload },
    { returnDocument: "after" }
  );

  recordAuditLog({
    actor: user,
    companyId: existing.companyId,
    action: "scorecard_template_updated",
    targetType: "scorecard_template",
    targetId: _id.toString(),
    targetIdentifier: `${updated.name} (v${updated.version})`,
    before: { version: existing.version, criteriaCount: existing.criteria?.length },
    after: { version: updated.version, criteriaCount: updated.criteria?.length, criteriaChanged },
  });

  return updated;
}

/**
 * Gets or initializes a default template for a company/job workspace.
 */
export async function getOrCreateDefaultTemplate(companyId, jobId = null, user = null) {
  const db = getDb();
  const normCompanyId = companyId?.toString();
  const normJobId = jobId ? jobId.toString() : null;

  // 1. Look for vacancy-specific active template
  if (normJobId) {
    const jobTemplate = await db.collection("scorecard_templates").findOne({
      companyId: normCompanyId,
      jobId: normJobId,
      isActive: true,
    });
    if (jobTemplate) return jobTemplate;
  }

  // 2. Look for company-wide active template
  const companyTemplate = await db.collection("scorecard_templates").findOne({
    companyId: normCompanyId,
    jobId: null,
    isActive: true,
  });
  if (companyTemplate) return companyTemplate;

  // 3. Auto-seed standard company template if none exists
  return await createScorecardTemplate({
    companyId: normCompanyId,
    jobId: null,
    name: "Standard Interview Scorecard",
    description: "Default collaborative candidate evaluation rubric across core technical and behavioral competencies.",
    criteria: DEFAULT_CRITERIA,
    user: user || { email: "system" },
  });
}

/**
 * Saves an interviewer's evaluation draft.
 */
export async function saveEvaluationDraft({
  applicationId,
  jobId,
  companyId,
  interviewId = null,
  scores = [],
  overallRecommendation = null,
  overallNotes = "",
  user,
}) {
  if (!applicationId || !jobId) throw new Error("applicationId and jobId are required.");
  if (!user || !user.email) throw new Error("Authenticated evaluator is required.");

  const db = getDb();
  const evaluatorEmail = user.email.toLowerCase().trim();

  // Validate application exists
  const appObjectId = toObjectId(applicationId);
  const application = appObjectId ? await db.collection("applications").findOne({ _id: appObjectId }) : null;
  if (!application) throw new Error("Application not found.");

  // Get active template
  const template = await getOrCreateDefaultTemplate(companyId || application.companyId, jobId, user);

  // Calculate weighted score for provided scores
  const weightedScore = calculateWeightedScore(scores, template.criteria);

  const evaluationDoc = {
    applicationId: applicationId.toString(),
    jobId: jobId.toString(),
    companyId: (companyId || application.companyId || "general").toString(),
    interviewId: interviewId ? interviewId.toString() : null,
    evaluatorEmail,
    evaluatorName: user.name || evaluatorEmail,
    evaluatorRole: user.companyRole || user.role || "interviewer",
    templateId: template._id.toString(),
    templateVersion: template.version || 1,
    criteriaSnapshot: template.criteria,
    scores: scores.map((s) => ({
      criterionId: s.criterionId,
      criterionName: s.criterionName || s.criterionId,
      rating: typeof s.rating === "number" ? Math.max(1, Math.min(5, s.rating)) : null,
      evidence: (s.evidence || "").trim(),
    })),
    overallRecommendation: overallRecommendation || null,
    overallNotes: (overallNotes || "").trim(),
    weightedScore,
    status: "draft",
    updatedAt: new Date(),
  };

  // Upsert draft (only if not already submitted)
  const existing = await db.collection("evaluations").findOne({
    applicationId: applicationId.toString(),
    evaluatorEmail,
  });

  if (existing && existing.status === "submitted") {
    throw new Error("This evaluation has already been submitted. Use the amendment workflow to propose corrections.");
  }

  const result = await db.collection("evaluations").findOneAndUpdate(
    { applicationId: applicationId.toString(), evaluatorEmail },
    {
      $set: evaluationDoc,
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: "after" }
  );

  return result;
}

/**
 * Submits an interviewer's final evaluation.
 * Validates required criteria, updates status to 'submitted', triggers notifications
 * and triggers recruitment pipeline automation.
 */
export async function submitEvaluation({
  applicationId,
  jobId,
  companyId,
  interviewId = null,
  scores = [],
  overallRecommendation,
  overallNotes = "",
  user,
}) {
  if (!applicationId || !jobId) throw new Error("applicationId and jobId are required.");
  if (!user || !user.email) throw new Error("Authenticated evaluator is required.");

  const db = getDb();
  const evaluatorEmail = user.email.toLowerCase().trim();

  // Validate application
  const appObjectId = toObjectId(applicationId);
  const application = appObjectId ? await db.collection("applications").findOne({ _id: appObjectId }) : null;
  if (!application) throw new Error("Application not found.");

  // Validate job
  const jobObjectId = toObjectId(jobId);
  const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;
  if (!job) throw new Error("Job vacancy not found.");

  // Verify vacancy access for evaluation
  const access = await verifyVacancyAccess(user, job, "submit_evaluation");
  if (!access.authorized) {
    throw new Error(`Forbidden: ${access.reason}`);
  }

  // If linked to an interview, verify participant eligibility
  if (interviewId) {
    const interviewObjId = toObjectId(interviewId);
    const interview = interviewObjId ? await db.collection("interviews").findOne({ _id: interviewObjId }) : null;
    if (interview && Array.isArray(interview.interviewers) && interview.interviewers.length > 0) {
      const participant = interview.interviewers.find((i) => i.email?.toLowerCase().trim() === evaluatorEmail);
      if (participant && (participant.responseStatus === "Declined" || participant.responseStatus === "Removed")) {
        throw new Error(`Cannot submit evaluation: You have ${participant.responseStatus.toLowerCase()} this interview panel.`);
      }
    }
  }

  // Get active template
  const template = await getOrCreateDefaultTemplate(companyId || application.companyId, jobId, user);

  // Validate recommendation
  if (!ALLOWED_RECOMMENDATIONS.includes(overallRecommendation)) {
    throw new Error(
      `Invalid recommendation "${overallRecommendation}". Allowed: ${ALLOWED_RECOMMENDATIONS.join(", ")}`
    );
  }

  // Validate required criteria
  const scoresMap = new Map((scores || []).map((s) => [s.criterionId, s]));
  for (const criterion of template.criteria) {
    if (criterion.isRequired) {
      const score = scoresMap.get(criterion.id);
      if (!score || typeof score.rating !== "number" || score.rating < 1 || score.rating > 5) {
        throw new Error(
          `Criterion "${criterion.name}" is required and must receive a rating between 1 and 5.`
        );
      }
    }
  }

  const weightedScore = calculateWeightedScore(scores, template.criteria);

  const evaluationPayload = {
    applicationId: applicationId.toString(),
    jobId: jobId.toString(),
    companyId: (job.companyId || companyId || "general").toString(),
    interviewId: interviewId ? interviewId.toString() : null,
    evaluatorEmail,
    evaluatorName: user.name || evaluatorEmail,
    evaluatorRole: access.role || user.companyRole || "interviewer",
    templateId: template._id.toString(),
    templateVersion: template.version || 1,
    criteriaSnapshot: template.criteria,
    scores: scores.map((s) => ({
      criterionId: s.criterionId,
      criterionName: s.criterionName || s.criterionId,
      rating: Number(s.rating),
      evidence: (s.evidence || "").trim(),
    })),
    overallRecommendation,
    overallNotes: (overallNotes || "").trim(),
    weightedScore,
    status: "submitted",
    submittedAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection("evaluations").findOneAndUpdate(
    { applicationId: applicationId.toString(), evaluatorEmail },
    {
      $set: evaluationPayload,
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: "after" }
  );

  // Record audit log
  recordAuditLog({
    actor: user,
    companyId: evaluationPayload.companyId,
    action: "evaluation_submitted",
    targetType: "evaluation",
    targetId: result._id.toString(),
    targetIdentifier: `${application.seekerName || application.seekerEmail} by ${evaluatorEmail}`,
    after: {
      applicationId: applicationId.toString(),
      overallRecommendation,
      weightedScore,
      evaluatorRole: evaluationPayload.evaluatorRole,
    },
  });

  // Notify hiring manager / recruiter about the completed evaluation
  const recipientEmail = job.recruiterEmail || application.recruiterEmail;
  if (recipientEmail && recipientEmail.toLowerCase() !== evaluatorEmail) {
    createNotification({
      recipientEmail,
      role: "recruiter",
      type: "evaluation_submitted",
      title: `Evaluation Submitted: ${application.seekerName || "Candidate"}`,
      message: `${user.name || evaluatorEmail} submitted a scorecard evaluation (${overallRecommendation.replace(/_/g, " ")}) for ${application.jobTitle}.`,
      link: `/dashboard/jobs/${jobId}/applicants`,
      referenceId: result._id.toString(),
      referenceType: "evaluation",
      idempotencyKey: `eval_notif_${result._id}_${Date.now()}`,
      sendEmail: true,
      emailTemplate: "evaluationSubmitted",
      emailData: {
        evaluatorName: user.name || evaluatorEmail,
        candidateName: application.seekerName || "Candidate",
        jobTitle: application.jobTitle,
        companyName: application.companyName,
        recommendation: overallRecommendation,
        viewUrl: `/dashboard/jobs/${jobId}/applicants`,
      },
    }).catch((err) => {
      console.error("[Scorecards] Notification error:", err.message);
    });
  }

  // Trigger recruitment pipeline automation asynchronously
  import("./pipelineAutomationService.js")
    .then(({ evaluatePipelineAutomation, AUTOMATION_TRIGGERS }) => {
      evaluatePipelineAutomation({
        trigger: AUTOMATION_TRIGGERS.ALL_EVALUATIONS_SUBMITTED,
        applicationId: applicationId.toString(),
        jobId: jobId.toString(),
        companyId: evaluationPayload.companyId,
      }).catch((err) => console.error("[Scorecards] Automation trigger error:", err.message));

      evaluatePipelineAutomation({
        trigger: AUTOMATION_TRIGGERS.EVALUATION_THRESHOLD_MET,
        applicationId: applicationId.toString(),
        jobId: jobId.toString(),
        companyId: evaluationPayload.companyId,
      }).catch((err) => console.error("[Scorecards] Automation threshold error:", err.message));
    })
    .catch((err) => console.error("[Scorecards] Pipeline service import error:", err.message));

  return result;
}

/**
 * Submits an authorized amendment or correction to a previously submitted evaluation.
 * Preserves audit history and previous state snapshots.
 */
export async function amendEvaluation({
  evaluationId,
  scores,
  overallRecommendation,
  overallNotes,
  amendmentReason,
  user,
}) {
  const _id = toObjectId(evaluationId);
  if (!_id) throw new Error("Invalid evaluation ID");
  if (!amendmentReason || amendmentReason.trim().length < 5) {
    throw new Error("A specific amendment reason (minimum 5 characters) is required to correct a submitted scorecard.");
  }

  const db = getDb();
  const existing = await db.collection("evaluations").findOne({ _id });
  if (!existing) throw new Error("Evaluation record not found.");

  const evaluatorEmail = user.email.toLowerCase().trim();
  const isOriginalEvaluator = existing.evaluatorEmail?.toLowerCase() === evaluatorEmail;
  const isGlobalAdmin = (user.role || "").toLowerCase() === "admin";

  if (!isOriginalEvaluator && !isGlobalAdmin) {
    // Check if user is company owner
    const jobObjectId = toObjectId(existing.jobId);
    const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;
    const access = job ? await verifyVacancyAccess(user, job, "submit_evaluation") : { authorized: false };
    if (!access.authorized || access.role !== COMPANY_ROLES.OWNER) {
      throw new Error("Forbidden: Only the original evaluator or the Company Owner can amend a submitted scorecard.");
    }
  }

  const historyEntry = {
    modifiedAt: new Date(),
    modifiedBy: evaluatorEmail,
    previousScores: existing.scores,
    previousRecommendation: existing.overallRecommendation,
    previousNotes: existing.overallNotes,
    previousWeightedScore: existing.weightedScore,
    reason: amendmentReason.trim(),
  };

  const newWeightedScore = calculateWeightedScore(scores || existing.scores, existing.criteriaSnapshot);

  const updated = await db.collection("evaluations").findOneAndUpdate(
    { _id },
    {
      $set: {
        scores: scores || existing.scores,
        overallRecommendation: overallRecommendation || existing.overallRecommendation,
        overallNotes: overallNotes !== undefined ? overallNotes : existing.overallNotes,
        weightedScore: newWeightedScore,
        updatedAt: new Date(),
      },
      $push: { history: historyEntry },
    },
    { returnDocument: "after" }
  );

  recordAuditLog({
    actor: user,
    companyId: existing.companyId,
    action: "evaluation_amended",
    targetType: "evaluation",
    targetId: _id.toString(),
    targetIdentifier: `Evaluation by ${existing.evaluatorEmail}`,
    before: { recommendation: existing.overallRecommendation, score: existing.weightedScore },
    after: { recommendation: updated.overallRecommendation, score: updated.weightedScore, reason: amendmentReason },
  });

  return updated;
}

/**
 * Calculates aggregated evaluation summary for an application.
 * Enforces role-based visibility:
 * - Seeker: Rejects with 403 Forbidden (candidates NEVER see internal scorecards).
 * - Interviewer: Returns summary metrics and their OWN notes, but redacts other evaluators' private text.
 * - Hiring Manager & Owner: Returns full summary, all scores, and all private notes.
 */
export async function getApplicationEvaluationSummary(applicationId, user) {
  if (!user) throw new Error("Authentication required.");

  const userRole = (user.role || "").toLowerCase();
  if (userRole === "seeker") {
    throw new Error("Forbidden: Candidate scorecards and internal evaluations are restricted.");
  }

  const db = getDb();
  const appObjectId = toObjectId(applicationId);
  const application = appObjectId ? await db.collection("applications").findOne({ _id: appObjectId }) : null;
  if (!application) throw new Error("Application not found.");

  const jobObjectId = toObjectId(application.jobId);
  const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;

  let viewerRole = "interviewer";
  if (userRole === "admin") {
    viewerRole = "admin";
  } else if (job) {
    const access = await verifyVacancyAccess(user, job, "view_evaluations");
    if (!access.authorized) {
      throw new Error(`Forbidden: ${access.reason}`);
    }
    viewerRole = access.role;
  }

  const userEmail = user.email.toLowerCase().trim();
  const allEvaluations = await db.collection("evaluations")
    .find({ applicationId: applicationId.toString() })
    .toArray();

  const submittedEvaluations = allEvaluations.filter((e) => e.status === "submitted");
  const draftEvaluations = allEvaluations.filter((e) => e.status === "draft");

  // Recommendation distribution
  const recommendationDistribution = {
    [OVERALL_RECOMMENDATIONS.STRONG_HIRE]: 0,
    [OVERALL_RECOMMENDATIONS.HIRE]: 0,
    [OVERALL_RECOMMENDATIONS.LEAN_HIRE]: 0,
    [OVERALL_RECOMMENDATIONS.LEAN_NO_HIRE]: 0,
    [OVERALL_RECOMMENDATIONS.NO_HIRE]: 0,
  };

  let totalScoreSum = 0;
  for (const e of submittedEvaluations) {
    if (e.overallRecommendation && recommendationDistribution[e.overallRecommendation] !== undefined) {
      recommendationDistribution[e.overallRecommendation]++;
    }
    totalScoreSum += (e.weightedScore || 0);
  }

  const overallWeightedAverage = submittedEvaluations.length > 0
    ? Math.round((totalScoreSum / submittedEvaluations.length) * 100) / 100
    : 0;

  // Criteria breakdown calculation across submitted evaluations
  const criteriaStatsMap = new Map();
  for (const e of submittedEvaluations) {
    for (const s of (e.scores || [])) {
      if (typeof s.rating !== "number" || s.rating < 1 || s.rating > 5) continue;
      if (!criteriaStatsMap.has(s.criterionId)) {
        criteriaStatsMap.set(s.criterionId, {
          criterionId: s.criterionId,
          criterionName: s.criterionName || s.criterionId,
          ratings: [],
        });
      }
      criteriaStatsMap.get(s.criterionId).ratings.push(s.rating);
    }
  }

  const criteriaBreakdown = Array.from(criteriaStatsMap.values()).map((c) => {
    const sum = c.ratings.reduce((a, b) => a + b, 0);
    const avg = Math.round((sum / c.ratings.length) * 100) / 100;
    return {
      criterionId: c.criterionId,
      criterionName: c.criterionName,
      averageRating: avg,
      ratingCount: c.ratings.length,
      minRating: Math.min(...c.ratings),
      maxRating: Math.max(...c.ratings),
    };
  });

  // Calculate agreement level across evaluators
  let agreementLevel = "insufficient_data";
  if (submittedEvaluations.length >= 2) {
    const scores = submittedEvaluations.map((e) => e.weightedScore || 0);
    const diff = Math.max(...scores) - Math.min(...scores);
    if (diff <= 0.6) agreementLevel = "high";
    else if (diff <= 1.2) agreementLevel = "moderate";
    else agreementLevel = "divergent";
  }

  // Role-based redaction: Interviewers see metrics & their own notes, but other evaluators' notes are sanitized
  const isFullPrivilege = viewerRole === COMPANY_ROLES.OWNER || viewerRole === COMPANY_ROLES.HIRING_MANAGER || viewerRole === "admin";

  const sanitizedEvaluations = allEvaluations.map((e) => {
    const isOwn = e.evaluatorEmail?.toLowerCase() === userEmail;
    if (isFullPrivilege || isOwn) {
      return e;
    }
    // Sanitize other evaluator's private commentary for peer interviewers
    return {
      _id: e._id,
      applicationId: e.applicationId,
      evaluatorName: e.evaluatorName,
      evaluatorRole: e.evaluatorRole,
      status: e.status,
      submittedAt: e.submittedAt,
      weightedScore: e.weightedScore,
      overallRecommendation: e.overallRecommendation,
      scores: (e.scores || []).map((s) => ({
        criterionId: s.criterionId,
        criterionName: s.criterionName,
        rating: s.rating,
        // Redact evidence notes
      })),
      // overallNotes redacted
    };
  });

  // Check assigned reviewers completion status
  const assignedReviewers = Array.isArray(application.candidateReviewAssignments)
    ? application.candidateReviewAssignments
    : [];

  const completedReviewerEmails = new Set(
    submittedEvaluations.map((e) => e.evaluatorEmail?.toLowerCase())
  );

  const missingEvaluators = assignedReviewers
    .filter((r) => !completedReviewerEmails.has(r.memberEmail?.toLowerCase()))
    .map((r) => ({ email: r.memberEmail, name: r.memberName, role: r.role }));

  const readyForDecision = (
    submittedEvaluations.length > 0 &&
    (assignedReviewers.length === 0 || missingEvaluators.length === 0)
  );

  return {
    applicationId: applicationId.toString(),
    totalEvaluationsCount: allEvaluations.length,
    submittedEvaluationsCount: submittedEvaluations.length,
    draftEvaluationsCount: draftEvaluations.length,
    overallWeightedAverage,
    recommendationDistribution,
    criteriaBreakdown,
    agreementLevel,
    readyForDecision,
    missingEvaluators,
    evaluations: sanitizedEvaluations,
    currentReviewStatus: application.reviewStatus || "pending",
  };
}

/**
 * Retrieves consolidated panel interview debrief data.
 * Merges panel participant statuses, evaluation completion states,
 * and collaborative scorecard summary.
 */
export async function getPanelDebriefSummary(interviewId, user) {
  if (!user) throw new Error("Authentication required.");

  const userRole = (user.role || "").toLowerCase();
  if (userRole === "seeker") {
    throw new Error("Forbidden: Candidate scorecards and debriefs are restricted.");
  }

  const _id = toObjectId(interviewId);
  if (!_id) throw new Error("Invalid interview ID");

  const db = getDb();
  const interview = await db.collection("interviews").findOne({ _id });
  if (!interview) throw new Error("Interview appointment not found.");

  // Check vacancy access
  const jobObjectId = toObjectId(interview.jobId);
  const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;

  if (userRole !== "admin" && job) {
    const access = await verifyVacancyAccess(user, job, "view_evaluations");
    if (!access.authorized) {
      throw new Error(`Forbidden: ${access.reason}`);
    }
  }

  // Get application evaluation summary
  const summary = await getApplicationEvaluationSummary(interview.applicationId, user);

  // Panelists tracking
  const interviewers = Array.isArray(interview.interviewers) && interview.interviewers.length > 0
    ? interview.interviewers
    : [
        {
          email: interview.recruiterEmail,
          name: interview.recruiterName || "Recruiter",
          role: "lead_interviewer",
          responseStatus: "Accepted",
        },
      ];

  const evaluatedEmails = new Set(
    (summary.evaluations || [])
      .filter((e) => e.status === "submitted")
      .map((e) => e.evaluatorEmail?.toLowerCase())
  );

  const panelistStatus = interviewers.map((p) => ({
    email: p.email,
    name: p.name || p.email,
    role: p.role || "panelist",
    responseStatus: p.responseStatus || "Pending",
    respondedAt: p.respondedAt || null,
    hasEvaluated: evaluatedEmails.has(p.email.toLowerCase()),
  }));

  const pendingEvaluators = panelistStatus.filter(
    (p) => !p.hasEvaluated && p.responseStatus !== "Declined" && p.responseStatus !== "Removed"
  );

  return {
    interviewId: interview._id.toString(),
    jobTitle: interview.jobTitle,
    companyName: interview.companyName,
    interviewType: interview.interviewType || (interviewers.length > 1 ? "panel" : "single"),
    status: interview.status,
    scheduledAt: interview.scheduledAt,
    durationMinutes: interview.durationMinutes,
    format: interview.format,
    location: interview.location,
    candidate: {
      name: interview.seekerName || "Candidate",
      email: interview.seekerEmail,
    },
    panelists: panelistStatus,
    pendingEvaluators,
    debriefReady: pendingEvaluators.length === 0 && summary.submittedEvaluationsCount > 0,
    summary,
  };
}
