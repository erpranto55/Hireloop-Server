/**
 * Recruitment Pipeline Automation Routes for HireLoop
 * Implements API endpoints to configure workflow automation rules,
 * toggle active triggers, and inspect execution audit logs.
 */

import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import {
  createAutomationRule,
  updateAutomationRule,
  listAutomationRules,
  toggleAutomationRule,
  getAutomationExecutionLogs,
  AUTOMATION_TRIGGERS,
  AUTOMATION_ACTIONS,
} from "../services/pipelineAutomationService.js";
import {
  verifyCompanyAccess,
  COMPANY_ROLES,
} from "../services/companyWorkspaceService.js";
import { getDb, toObjectId } from "../db.js";

const router = Router();

// GET /api/automation/meta - Get supported triggers and actions
router.get("/meta", requireAuth, (_req, res) => {
  res.json({
    triggers: AUTOMATION_TRIGGERS,
    actions: AUTOMATION_ACTIONS,
  });
});

// GET /api/automation/rules - List automation rules for company/job
router.get("/rules", requireAuth, asyncHandler(async (req, res) => {
  const { companyId, jobId } = req.query;
  if (!companyId) return badRequest(res, "companyId query parameter is required.");

  const access = await verifyCompanyAccess(req.user, companyId);
  if (!access.authorized) {
    return res.status(403).json({ message: `Forbidden: ${access.reason}` });
  }

  const rules = await listAutomationRules(companyId, jobId);
  res.json(rules);
}));

// POST /api/automation/rules - Create new automation rule
router.post("/rules", requireAuth, asyncHandler(async (req, res) => {
  const {
    companyId,
    jobId,
    name,
    description,
    trigger,
    conditions,
    action,
    targetStage,
    allowConsequentialTransition,
  } = req.body;

  if (!companyId || !name || !trigger || !action) {
    return badRequest(res, "companyId, name, trigger, and action are required.");
  }

  const isGlobalAdmin = (req.user.role || "").toLowerCase() === "admin";
  if (!isGlobalAdmin) {
    const access = await verifyCompanyAccess(req.user, companyId, COMPANY_ROLES.HIRING_MANAGER);
    if (!access.authorized) {
      return res.status(403).json({ message: `Forbidden: ${access.reason}` });
    }
  }

  const rule = await createAutomationRule({
    companyId,
    jobId,
    name,
    description,
    trigger,
    conditions,
    action,
    targetStage,
    allowConsequentialTransition,
    user: req.user,
  });

  created(res, rule);
}));

// PATCH /api/automation/rules/:id - Update automation rule
router.patch("/rules/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid rule ID");

  const db = getDb();
  const existing = await db.collection("pipeline_automation_rules").findOne({ _id });
  if (!existing) return notFound(res, "Automation rule not found");

  const isGlobalAdmin = (req.user.role || "").toLowerCase() === "admin";
  if (!isGlobalAdmin) {
    const access = await verifyCompanyAccess(req.user, existing.companyId, COMPANY_ROLES.HIRING_MANAGER);
    if (!access.authorized) {
      return res.status(403).json({ message: `Forbidden: ${access.reason}` });
    }
  }

  const updated = await updateAutomationRule(req.params.id, req.body, req.user);
  res.json(updated);
}));

// PATCH /api/automation/rules/:id/toggle - Toggle rule enabled/disabled
router.patch("/rules/:id/toggle", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid rule ID");

  const db = getDb();
  const existing = await db.collection("pipeline_automation_rules").findOne({ _id });
  if (!existing) return notFound(res, "Automation rule not found");

  const isGlobalAdmin = (req.user.role || "").toLowerCase() === "admin";
  if (!isGlobalAdmin) {
    const access = await verifyCompanyAccess(req.user, existing.companyId, COMPANY_ROLES.HIRING_MANAGER);
    if (!access.authorized) {
      return res.status(403).json({ message: `Forbidden: ${access.reason}` });
    }
  }

  const isEnabled = typeof req.body.isEnabled === "boolean" ? req.body.isEnabled : !existing.isEnabled;
  const updated = await toggleAutomationRule(req.params.id, isEnabled, req.user);
  res.json(updated);
}));

// GET /api/automation/logs - View execution audit logs
router.get("/logs", requireAuth, asyncHandler(async (req, res) => {
  const { companyId, limit } = req.query;
  if (!companyId) return badRequest(res, "companyId query parameter is required.");

  const access = await verifyCompanyAccess(req.user, companyId);
  if (!access.authorized) {
    return res.status(403).json({ message: `Forbidden: ${access.reason}` });
  }

  const logs = await getAutomationExecutionLogs(companyId, limit);
  res.json(logs);
}));

export default router;
