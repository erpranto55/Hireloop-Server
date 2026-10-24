import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { getDb } from "../db.js";
import {
  createReport,
  listReports,
  getReportDetails,
  updateReportStatus,
  executeModerationAction,
  SUPPORTED_TARGET_TYPES,
  SUPPORTED_CATEGORIES,
} from "../services/reportService.js";

const router = Router();

// GET /api/reports/meta - Public/Auth metadata for supported report options
router.get("/meta", (_req, res) => {
  res.json({
    targetTypes: SUPPORTED_TARGET_TYPES,
    categories: SUPPORTED_CATEGORIES,
  });
});

// POST /api/reports - Authenticated users submit a violation report
router.post("/", requireAuth, asyncHandler(async (req, res) => {
  const { targetType, targetId, category, reason } = req.body;

  if (!targetType || !targetId || !category || !reason) {
    return badRequest(res, "targetType, targetId, category, and reason are required.");
  }

  try {
    const report = await createReport({
      reporterEmail: req.user.email,
      targetType,
      targetId,
      category,
      reason,
    });
    created(res, report);
  } catch (err) {
    return badRequest(res, err.message);
  }
}));

// GET /api/reports/my - Authenticated user views their own submitted reports
router.get("/my", requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const reports = await db.collection("reports")
    .find(
      { reporterEmail: req.user.email.toLowerCase().trim() },
      { projection: { assignedAdminEmail: 0, resolutionNotes: 0 } }
    )
    .sort({ createdAt: -1 })
    .toArray();

  res.json(reports);
}));

// -------------------------------------------------------------
// ADMINISTRATOR MODERATION ROUTES (Supports /api/admin/reports and /api/reports/admin)
// -------------------------------------------------------------

// GET / - List all reports with filters and pagination
router.get(["/", "/admin"], requireAuth, requireRole("admin"), asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    status,
    category,
    targetType,
    startDate,
    endDate,
    q,
  } = req.query;

  const result = await listReports({
    page,
    limit,
    status,
    category,
    targetType,
    startDate,
    endDate,
    q,
  });

  res.json(result);
}));

// GET /:id - View single report with target context
router.get(["/:id", "/admin/:id"], requireAuth, requireRole("admin"), asyncHandler(async (req, res) => {
  const result = await getReportDetails(req.params.id, req.user);
  if (!result) {
    return notFound(res, "Report not found.");
  }

  res.json(result);
}));

// PATCH /:id - Update report status (e.g. claim, in_review)
router.patch(["/:id", "/admin/:id"], requireAuth, requireRole("admin"), asyncHandler(async (req, res) => {
  const { status, assignedAdminEmail, resolutionNotes } = req.body;

  try {
    const updated = await updateReportStatus(req.params.id, req.user, {
      status,
      assignedAdminEmail,
      resolutionNotes,
    });
    res.json(updated);
  } catch (err) {
    return badRequest(res, err.message);
  }
}));

// POST /:id/action - Execute moderation action on target entity
router.post(["/:id/action", "/admin/:id/action"], requireAuth, requireRole("admin"), asyncHandler(async (req, res) => {
  const { actionType, resolutionNotes } = req.body;

  if (!actionType || !resolutionNotes) {
    return badRequest(res, "actionType and resolutionNotes are required.");
  }

  try {
    const outcome = await executeModerationAction(req.params.id, req.user, {
      actionType,
      resolutionNotes,
    });
    res.json(outcome);
  } catch (err) {
    return badRequest(res, err.message);
  }
}));

export default router;
