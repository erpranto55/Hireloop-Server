import { Router } from "express";
import { requireAuth, requirePermission, hasPermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { listAuditLogs, exportAuditLogs, recordAuditLog } from "../services/auditService.js";
import { PERMISSIONS } from "../services/permissionService.js";

const router = Router();

// GET /api/admin/audit-logs - Administrator compliance audit reporting
router.get(
  "/audit-logs",
  requireAuth,
  requirePermission(PERMISSIONS.AUDIT_READ, PERMISSIONS.AUDIT_READ_BILLING),
  asyncHandler(async (req, res) => {
    let {
      page = 1,
      limit = 20,
      action,
      targetType,
      actorEmail,
      startDate,
      endDate,
      q,
    } = req.query;

    // Scope restrictions: If actor only has AUDIT_READ_BILLING, restrict scope strictly to billing/payment actions
    const hasFullAudit = hasPermission(req.user, PERMISSIONS.AUDIT_READ);
    if (!hasFullAudit) {
      targetType = "billing";
    }

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
  })
);

// GET /api/admin/audit-logs/export - Bounded CSV and JSON export for compliance
router.get(
  "/audit-logs/export",
  requireAuth,
  requirePermission(PERMISSIONS.AUDIT_EXPORT),
  asyncHandler(async (req, res) => {
    const {
      format = "csv",
      action,
      targetType,
      actorEmail,
      startDate,
      endDate,
      q,
    } = req.query;

    const exportResult = await exportAuditLogs({
      format,
      action,
      targetType,
      actorEmail,
      startDate,
      endDate,
      q,
    });

    // Record audit log for the export operation (non-recursive)
    recordAuditLog({
      actor: req.user,
      action: "audit_logs_exported",
    targetType: "compliance",
    targetId: `export_${Date.now()}`,
    targetIdentifier: `${format.toUpperCase()} export (${exportResult.count} records)`,
    outcome: "success",
    metadata: {
      format,
      recordCount: exportResult.count,
      filters: { action, targetType, actorEmail, startDate, endDate, q },
    },
  });

  res.setHeader("Content-Type", exportResult.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${exportResult.filename}"`);
  res.send(exportResult.data);
}));

export default router;
