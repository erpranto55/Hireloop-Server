import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created } from "../utils/http.js";
import {
  getAudienceCount,
  dispatchAnnouncementCampaign,
  listAnnouncementCampaigns,
  SUPPORTED_AUDIENCES,
} from "../services/announcementService.js";

const router = Router();

// GET /api/admin/announcements/audience-count - Audience preview count
router.get("/audience-count", requireAuth, requireRole("admin"), asyncHandler(async (req, res) => {
  const { audience = "all", selectedEmails } = req.query;
  const emails = selectedEmails ? selectedEmails.split(",").map((e) => e.trim()) : [];
  const result = await getAudienceCount(audience, emails);
  res.json(result);
}));

// GET /api/admin/announcements - List historical broadcast campaigns
router.get("/", requireAuth, requireRole("admin"), asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const result = await listAnnouncementCampaigns({ page, limit });
  res.json(result);
}));

// POST /api/admin/announcements - Dispatch controlled system broadcast
router.post("/", requireAuth, requireRole("admin"), asyncHandler(async (req, res) => {
  const {
    title,
    message,
    audience = "all",
    selectedEmails = [],
    channels = ["in_app"],
    campaignId,
    idempotencyKey,
  } = req.body;

  if (!title || !message) {
    return badRequest(res, "title and message are required.");
  }

  if (!SUPPORTED_AUDIENCES.includes(audience)) {
    return badRequest(res, `Invalid audience. Supported: ${SUPPORTED_AUDIENCES.join(", ")}`);
  }

  try {
    const campaign = await dispatchAnnouncementCampaign(req.user, {
      title,
      message,
      audience,
      selectedEmails,
      channels,
      campaignId,
      idempotencyKey,
    });
    created(res, campaign);
  } catch (err) {
    return badRequest(res, err.message);
  }
}));

export default router;
