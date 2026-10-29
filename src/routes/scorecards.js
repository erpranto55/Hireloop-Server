/**
 * Scorecard Evaluation Routes for HireLoop
 * Implements API endpoints for templates, drafts, submissions, amendments,
 * and aggregated collaborative candidate feedback.
 */

import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import {
  createScorecardTemplate,
  updateScorecardTemplate,
  getOrCreateDefaultTemplate,
  saveEvaluationDraft,
  submitEvaluation,
  amendEvaluation,
  getApplicationEvaluationSummary,
} from "../services/scorecardService.js";
import {
  verifyCompanyAccess,
  verifyVacancyAccess,
  COMPANY_ROLES,
} from "../services/companyWorkspaceService.js";
import { getDb, toObjectId } from "../db.js";

const router = Router();

// GET /api/scorecards/templates - List templates for company/job
router.get("/templates", requireAuth, asyncHandler(async (req, res) => {
  const { companyId, jobId } = req.query;
  if (!companyId) return badRequest(res, "companyId query parameter is required.");

  const access = await verifyCompanyAccess(req.user, companyId);
  if (!access.authorized) {
    return res.status(403).json({ message: `Forbidden: ${access.reason}` });
  }

  const db = getDb();
  const filter = { companyId: companyId.toString() };
  if (jobId) {
    filter.$or = [{ jobId: jobId.toString() }, { jobId: null }];
  }

  const templates = await db.collection("scorecard_templates")
    .find(filter)
    .sort({ updatedAt: -1 })
    .toArray();

  res.json(templates);
}));

// GET /api/scorecards/templates/default - Get active default template for vacancy
router.get("/templates/default", requireAuth, asyncHandler(async (req, res) => {
  const { companyId, jobId } = req.query;
  if (!companyId) return badRequest(res, "companyId query parameter is required.");

  const access = await verifyCompanyAccess(req.user, companyId);
  if (!access.authorized) {
    return res.status(403).json({ message: `Forbidden: ${access.reason}` });
  }

  const template = await getOrCreateDefaultTemplate(companyId, jobId, req.user);
  res.json(template);
}));

// POST /api/scorecards/templates - Create template (Owner or Hiring Manager)
router.post("/templates", requireAuth, asyncHandler(async (req, res) => {
  const { companyId, jobId, name, description, interviewType, criteria } = req.body;
  if (!companyId || !name) return badRequest(res, "companyId and name are required.");

  const isGlobalAdmin = (req.user.role || "").toLowerCase() === "admin";
  if (!isGlobalAdmin) {
    const access = await verifyCompanyAccess(req.user, companyId, COMPANY_ROLES.HIRING_MANAGER);
    if (!access.authorized) {
      return res.status(403).json({ message: `Forbidden: ${access.reason}` });
    }
  }

  const template = await createScorecardTemplate({
    companyId,
    jobId,
    name,
    description,
    interviewType,
    criteria,
    user: req.user,
  });

  created(res, template);
}));

// PATCH /api/scorecards/templates/:id - Update template (increments version)
router.patch("/templates/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid template ID");

  const db = getDb();
  const existing = await db.collection("scorecard_templates").findOne({ _id });
  if (!existing) return notFound(res, "Template not found");

  const isGlobalAdmin = (req.user.role || "").toLowerCase() === "admin";
  if (!isGlobalAdmin) {
    const access = await verifyCompanyAccess(req.user, existing.companyId, COMPANY_ROLES.HIRING_MANAGER);
    if (!access.authorized) {
      return res.status(403).json({ message: `Forbidden: ${access.reason}` });
    }
  }

  const updated = await updateScorecardTemplate(req.params.id, req.body, req.user);
  res.json(updated);
}));

// GET /api/scorecards/applications/:applicationId/summary - Aggregated feedback overview
router.get("/applications/:applicationId/summary", requireAuth, asyncHandler(async (req, res) => {
  const { applicationId } = req.params;
  const userRole = (req.user.role || "").toLowerCase();
  if (userRole === "seeker") {
    return res.status(403).json({ message: "Forbidden: Candidates cannot access internal evaluations." });
  }

  const summary = await getApplicationEvaluationSummary(applicationId, req.user);
  res.json(summary);
}));

// GET /api/scorecards/applications/:applicationId/mine - Get caller's own evaluation (draft or submitted)
router.get("/applications/:applicationId/mine", requireAuth, asyncHandler(async (req, res) => {
  const { applicationId } = req.params;
  const evaluatorEmail = req.user.email.toLowerCase().trim();

  const db = getDb();
  const evaluation = await db.collection("evaluations").findOne({
    applicationId: applicationId.toString(),
    evaluatorEmail,
  });

  res.json(evaluation || null);
}));

// POST /api/scorecards/draft - Save evaluation draft
router.post("/draft", requireAuth, asyncHandler(async (req, res) => {
  const {
    applicationId,
    jobId,
    companyId,
    interviewId,
    scores,
    overallRecommendation,
    overallNotes,
  } = req.body;

  if (!applicationId || !jobId) {
    return badRequest(res, "applicationId and jobId are required.");
  }

  const draft = await saveEvaluationDraft({
    applicationId,
    jobId,
    companyId,
    interviewId,
    scores,
    overallRecommendation,
    overallNotes,
    user: req.user,
  });

  res.json(draft);
}));

// POST /api/scorecards/submit - Submit final evaluation
router.post("/submit", requireAuth, asyncHandler(async (req, res) => {
  const {
    applicationId,
    jobId,
    companyId,
    interviewId,
    scores,
    overallRecommendation,
    overallNotes,
  } = req.body;

  if (!applicationId || !jobId || !overallRecommendation) {
    return badRequest(res, "applicationId, jobId, and overallRecommendation are required.");
  }

  const evaluation = await submitEvaluation({
    applicationId,
    jobId,
    companyId,
    interviewId,
    scores,
    overallRecommendation,
    overallNotes,
    user: req.user,
  });

  created(res, evaluation);
}));

// PATCH /api/scorecards/:id/amend - Propose amendment to a submitted evaluation
router.patch("/:id/amend", requireAuth, asyncHandler(async (req, res) => {
  const { scores, overallRecommendation, overallNotes, amendmentReason } = req.body;
  if (!amendmentReason || amendmentReason.trim().length < 5) {
    return badRequest(res, "A specific amendment reason (minimum 5 characters) is required.");
  }

  const amended = await amendEvaluation({
    evaluationId: req.params.id,
    scores,
    overallRecommendation,
    overallNotes,
    amendmentReason,
    user: req.user,
  });

  res.json(amended);
}));

export default router;
