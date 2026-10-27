/**
 * Team Invitations & Workspace Public Verification Routes
 * Handles invitation verification, acceptance, and decline operations.
 */

import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, notFound } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getInvitationByToken,
  acceptTeamInvitation,
  hashInvitationToken,
} from "../services/companyWorkspaceService.js";
import { getDb } from "../db.js";

const router = Router();

// GET /api/team/invitations/verify - Verify and preview invitation details
router.get("/invitations/verify", asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== "string") {
    return badRequest(res, "Invitation token is required.");
  }

  const invitation = await getInvitationByToken(token);
  if (!invitation) {
    return notFound(res, "Invalid or expired invitation token.");
  }

  res.json({ invitation });
}));

// POST /api/team/invitations/accept - Accept invitation and join workspace
router.post("/invitations/accept", requireAuth, asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return badRequest(res, "Invitation token is required.");
  }

  try {
    const result = await acceptTeamInvitation({
      rawToken: token,
      authenticatedUser: req.user,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}));

// POST /api/team/invitations/decline - Decline pending invitation
router.post("/invitations/decline", requireAuth, asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return badRequest(res, "Invitation token is required.");
  }

  const db = getDb();
  const tokenHash = hashInvitationToken(token.trim());
  const userEmail = req.user.email.toLowerCase().trim();

  const invitation = await db.collection("company_invitations").findOne({
    tokenHash,
    status: "pending",
  });

  if (!invitation) {
    return notFound(res, "Invalid or expired invitation token.");
  }

  if (invitation.inviteeEmail.toLowerCase() !== userEmail) {
    return res.status(403).json({
      message: `This invitation was issued to ${invitation.inviteeEmail}. You are logged in as ${userEmail}.`,
    });
  }

  await db.collection("company_invitations").updateOne(
    { _id: invitation._id },
    {
      $set: {
        status: "declined",
        declinedBy: userEmail,
        declinedAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );

  res.json({ success: true, message: "Invitation declined successfully." });
}));

export default router;
