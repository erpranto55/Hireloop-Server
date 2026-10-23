import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { listAuditLogs } from "../services/auditService.js";

const router = Router();

// GET /api/admin/audit-logs - Administrator compliance audit reporting
router.get("/audit-logs", requireAuth, requireRole("admin"), asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    action,
    targetType,
    actorEmail,
    startDate,
    endDate,
    q,
  } = req.query;

  const result = await listAuditLogs({
    page,
    limit,
    action,
    targetType,
    actorEmail,
    startDate,
    endDate,
    q,
  });

  res.json(result);
}));

export default router;
