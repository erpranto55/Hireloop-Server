/**
 * Interviewer Availability Routes for HireLoop
 * Endpoints for managing weekly working hours, date exceptions,
 * and preflight conflict/availability checks for scheduling coordinators.
 */

import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getInterviewerAvailability,
  setInterviewerAvailability,
  validateSlotConflictAndAvailability,
  findInterviewConflicts,
} from "../services/availabilityService.js";

const router = Router();

// GET /api/availability/mine - Get authenticated user's availability profile
router.get("/mine", requireAuth, asyncHandler(async (req, res) => {
  const email = req.user.email.toLowerCase().trim();
  const profile = await getInterviewerAvailability(email);

  res.json(profile || {
    userEmail: email,
    timezone: "UTC",
    weeklyHours: [
      { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
      { dayOfWeek: 2, startTime: "09:00", endTime: "17:00" },
      { dayOfWeek: 3, startTime: "09:00", endTime: "17:00" },
      { dayOfWeek: 4, startTime: "09:00", endTime: "17:00" },
      { dayOfWeek: 5, startTime: "09:00", endTime: "17:00" },
    ],
    exceptions: [],
  });
}));

// PUT /api/availability/mine - Update authenticated user's availability profile
router.put("/mine", requireAuth, asyncHandler(async (req, res) => {
  const email = req.user.email.toLowerCase().trim();
  const { timezone, weeklyHours, exceptions } = req.body;

  try {
    const updated = await setInterviewerAvailability(email, {
      timezone,
      weeklyHours,
      exceptions,
    });
    res.json(updated);
  } catch (err) {
    return badRequest(res, err.message);
  }
}));

// GET /api/availability/:email - Retrieve availability for specific interviewer (Recruiter/Admin)
router.get("/:email", requireAuth, asyncHandler(async (req, res) => {
  const targetEmail = req.params.email.toLowerCase().trim();
  const profile = await getInterviewerAvailability(targetEmail);

  if (!profile) {
    return res.json({
      userEmail: targetEmail,
      timezone: "UTC",
      weeklyHours: [],
      exceptions: [],
      isConfigured: false,
    });
  }

  res.json({ ...profile, isConfigured: true });
}));

// POST /api/availability/check - Preflight slot availability & conflict check for panel scheduling
router.post("/check", requireAuth, asyncHandler(async (req, res) => {
  const {
    interviewers = [],
    seekerEmail,
    scheduledAt,
    durationMinutes = 45,
    excludeInterviewId = null,
  } = req.body;

  if (!scheduledAt) return badRequest(res, "scheduledAt is required.");

  const startDate = new Date(scheduledAt);
  if (isNaN(startDate.getTime())) return badRequest(res, "Invalid scheduledAt timestamp.");

  const duration = Math.min(180, Math.max(15, Number(durationMinutes) || 45));
  const endDate = new Date(startDate.getTime() + duration * 60 * 1000);

  try {
    const result = await validateSlotConflictAndAvailability({
      interviewers,
      seekerEmail,
      startDate,
      endDate,
      excludeInterviewId,
    });

    res.json({
      ...result,
      startDate,
      endDate,
      durationMinutes: duration,
    });
  } catch (err) {
    return badRequest(res, err.message);
  }
}));

export default router;

