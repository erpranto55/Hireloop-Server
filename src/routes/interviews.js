/**
 * Interview Scheduling Route for HireLoop
 * Implements multi-interviewer panel interviews, conflict prevention,
 * participant responses, coordinated rescheduling, and calendar synchronization.
 */

import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { createNotification } from "../services/notificationService.js";
import { recordAuditLog } from "../services/auditService.js";
import { generateIcsInvite, generateGoogleCalendarUrl } from "../services/calendarService.js";
import { scheduleInterviewReminders, invalidateInterviewReminders, scheduleInterviewRemindersForRecipient } from "../services/reminderService.js";
import {
  verifyVacancyAccess,
  getUserCompanyMemberships,
  getCompanyMembership,
} from "../services/companyWorkspaceService.js";
import {
  findInterviewConflicts,
  validateSlotConflictAndAvailability,
} from "../services/availabilityService.js";
import { withBookingLock } from "../services/bookingLockService.js";
import { getCalendarSyncStatus } from "../services/calendarSyncService.js";

const router = Router();

export const INTERVIEW_STATUSES = [
  "Proposed",
  "Confirmed",
  "Rescheduled",
  "Canceled",
  "Completed",
];

// Helper: Calculate end date from start date and duration
function calculateEndDate(startDate, durationMinutes = 45) {
  const start = new Date(startDate);
  return new Date(start.getTime() + durationMinutes * 60 * 1000);
}

// GET /api/interviews/calendar-sync-status - Check calendar integration status
router.get("/calendar-sync-status", requireAuth, (_req, res) => {
  res.json(getCalendarSyncStatus());
});

// POST /api/interviews/check-conflicts - Preflight check for conflicts and availability
router.post("/check-conflicts", requireAuth, asyncHandler(async (req, res) => {
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
  const endDate = calculateEndDate(startDate, duration);

  const check = await validateSlotConflictAndAvailability({
    interviewers,
    seekerEmail,
    startDate,
    endDate,
    excludeInterviewId,
  });

  res.json({
    ...check,
    scheduledAt: startDate,
    endAt: endDate,
    durationMinutes: duration,
  });
}));

// POST /api/interviews - Propose / Schedule an interview (1-on-1 or Panel)
router.post("/", requireAuth, asyncHandler(async (req, res) => {
  const {
    applicationId,
    scheduledAt,
    durationMinutes = 45,
    timezone = "UTC",
    format = "video",
    location,
    agenda = "",
    interviewType, // "single" | "panel"
    interviewers = [], // array of { email, name, role }
  } = req.body;

  if (!applicationId) return badRequest(res, "applicationId is required.");
  if (!scheduledAt) return badRequest(res, "scheduledAt date is required.");

  const interviewDate = new Date(scheduledAt);
  if (isNaN(interviewDate.getTime())) {
    return badRequest(res, "Invalid scheduledAt timestamp.");
  }

  const appObjectId = toObjectId(applicationId);
  if (!appObjectId) return badRequest(res, "Invalid applicationId identifier.");

  const db = getDb();
  const application = await db.collection("applications").findOne({ _id: appObjectId });
  if (!application) return notFound(res, "Job application not found.");

  const userRole = (req.user.role || "").toLowerCase();
  const userEmail = req.user.email.toLowerCase().trim();
  const isAdmin = userRole === "admin";

  let isAuthorized = isAdmin;
  const jobObjectId = toObjectId(application.jobId);
  const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;

  if (!isAdmin) {
    if (job) {
      const access = await verifyVacancyAccess(req.user, job, "manage_interviews");
      isAuthorized = access.authorized;
    } else {
      isAuthorized = application.recruiterEmail?.toLowerCase() === userEmail;
    }
  }

  if (!isAuthorized) {
    return res.status(403).json({
      message: "Forbidden: You are not authorized to schedule interviews for this job application.",
    });
  }

  const duration = Math.min(180, Math.max(15, Number(durationMinutes) || 45));
  const endDate = calculateEndDate(interviewDate, duration);

  // Normalize interviewers list
  let resolvedInterviewers = [];
  if (Array.isArray(interviewers) && interviewers.length > 0) {
    for (const item of interviewers) {
      const email = (typeof item === "string" ? item : item.email)?.toLowerCase().trim();
      const name = (typeof item === "object" ? item.name : "") || email;
      const role = (typeof item === "object" ? item.role : "") || "panelist";

      if (!email) continue;

      // Validate membership & vacancy access for each interviewer
      if (!isAdmin && job?.companyId) {
        const membership = await getCompanyMembership(email, job.companyId);
        if (!membership || membership.status !== "active") {
          return badRequest(res, `Interviewer ${email} is not an active member of this company workspace.`);
        }
        const memberAccess = await verifyVacancyAccess(
          { email, companyRole: membership.role },
          job,
          "participate_interviews"
        );
        if (!memberAccess.authorized) {
          return badRequest(res, `Interviewer ${email} does not have access to participate in interviews for this vacancy.`);
        }
      }

      const isCurrentScheduler = email === userEmail;
      resolvedInterviewers.push({
        email,
        name,
        role: ["lead_interviewer", "panelist", "coordinator", "observer"].includes(role) ? role : "panelist",
        responseStatus: isCurrentScheduler ? "Accepted" : "Pending",
        respondedAt: isCurrentScheduler ? new Date() : null,
        invitedAt: new Date(),
      });
    }
  }

  // Fallback to scheduling recruiter if no interviewers specified
  if (resolvedInterviewers.length === 0) {
    resolvedInterviewers.push({
      email: userEmail,
      name: req.user.name || "Recruiter",
      role: "lead_interviewer",
      responseStatus: "Accepted",
      respondedAt: new Date(),
      invitedAt: new Date(),
    });
  }

  const isPanel = interviewType === "panel" || resolvedInterviewers.length > 1;

  // Conflict validation & atomic persistence under distributed booking lock
  const allInterviewerEmails = resolvedInterviewers.map((i) => i.email);
  const lockParticipants = [application.seekerEmail, ...allInterviewerEmails];

  let interviewDoc;
  try {
    interviewDoc = await withBookingLock(lockParticipants, async () => {
      const conflictCheck = await findInterviewConflicts({
        interviewers: allInterviewerEmails,
        seekerEmail: application.seekerEmail,
        startDate: interviewDate,
        endDate,
      });

      if (conflictCheck.hasConflict) {
        const conflictReasons = [];
        if (conflictCheck.candidateConflict) {
          conflictReasons.push(`Candidate has another appointment at this time`);
        }
        if (conflictCheck.interviewerConflicts.length > 0) {
          conflictReasons.push(
            `Interviewer(s) ${conflictCheck.interviewerConflicts.map((c) => c.email).join(", ")} already booked`
          );
        }
        const err = new Error(
          `Scheduling conflict detected: ${conflictReasons.join("; ")}. Please choose another time.`
        );
        err.status = 409;
        err.conflictDetails = conflictCheck;
        throw err;
      }

      const doc = {
        applicationId: application._id.toString(),
        jobId: application.jobId,
        jobTitle: application.jobTitle,
        companyName: application.companyName,
        companyId: (job?.companyId || application.companyId || "").toString(),
        recruiterEmail: application.recruiterEmail || userEmail,
        recruiterName: req.user.name || "Recruiter",
        seekerEmail: (application.seekerEmail || "").toLowerCase().trim(),
        seekerName: application.seekerName || "Candidate",
        scheduledAt: interviewDate,
        durationMinutes: duration,
        endAt: endDate,
        timezone,
        format: ["video", "in-person", "phone"].includes(format) ? format : "video",
        location: location ? location.trim() : (format === "video" ? "HireLoop Video Call Room" : ""),
        agenda: agenda ? agenda.trim() : "",
        status: "Proposed",
        interviewType: isPanel ? "panel" : "single",
        sequence: 0,
        interviewers: resolvedInterviewers,
        history: [
          {
            action: "proposed",
            by: userEmail,
            timestamp: new Date(),
            notes: agenda || (isPanel ? "Panel interview scheduled" : "Initial interview scheduled"),
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await db.collection("interviews").insertOne(doc);
      doc._id = result.insertedId;
      return doc;
    });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({
        message: err.message,
        conflictDetails: err.conflictDetails || null,
      });
    }
    throw err;
  }

  const interviewId = interviewDoc._id.toString();

  // Schedule durable 24h & 1h reminders for all participants
  scheduleInterviewReminders(interviewDoc).catch((err) => {
    console.error("[Interviews] Reminder schedule error:", err.message);
  });

  // Advance application status to "Interview Scheduled" if in Applied/Under Review/Shortlisted
  const currentAppStatus = application.status || "Applied";
  if (["Applied", "Under Review", "Shortlisted"].includes(currentAppStatus)) {
    await db.collection("applications").updateOne(
      { _id: application._id },
      {
        $set: { status: "Interview Scheduled", updatedAt: new Date() },
        $push: {
          statusHistory: {
            from: currentAppStatus,
            to: "Interview Scheduled",
            changedBy: userEmail,
            changedAt: new Date(),
            note: `${isPanel ? "Panel interview" : "Interview"} scheduled for ${interviewDate.toUTCString()}`,
          },
        },
      }
    );
  }

  // Generate Google Calendar Link with all participants
  const allAttendees = [
    { email: interviewDoc.seekerEmail, name: interviewDoc.seekerName },
    ...resolvedInterviewers,
  ];

  const googleCalUrl = generateGoogleCalendarUrl({
    title: `${isPanel ? "Panel Interview" : "Interview"}: ${application.jobTitle} - ${application.companyName}`,
    description: `HireLoop ${isPanel ? "Panel " : ""}Interview Appointment\nPosition: ${application.jobTitle}\nFormat: ${interviewDoc.format}\nLocation: ${interviewDoc.location}\nAgenda: ${interviewDoc.agenda}`,
    location: interviewDoc.location,
    startDate: interviewDate,
    endDate,
    attendees: allAttendees,
  });

  // Notify Candidate via In-app Notification & Transactional Email
  if (interviewDoc.seekerEmail) {
    createNotification({
      recipientEmail: interviewDoc.seekerEmail,
      role: "seeker",
      type: "interview_invitation",
      title: `Interview Invitation: ${application.jobTitle}`,
      message: `${interviewDoc.companyName} has invited you to an interview scheduled for ${interviewDate.toLocaleDateString()} at ${interviewDate.toLocaleTimeString()} (${timezone}).`,
      link: `/dashboard/seeker/applications`,
      referenceId: interviewId,
      referenceType: "interview",
      idempotencyKey: `interview_invite_${interviewId}`,
      sendEmail: true,
      emailTemplate: "interviewInvitation",
      emailData: {
        jobTitle: application.jobTitle,
        companyName: application.companyName,
        scheduledAt: `${interviewDate.toLocaleDateString()} at ${interviewDate.toLocaleTimeString()}`,
        durationMinutes: duration,
        timezone,
        format: interviewDoc.format,
        location: interviewDoc.location,
        agenda: interviewDoc.agenda,
        calendarUrl: googleCalUrl,
        viewUrl: `/dashboard/seeker/applications`,
      },
    }).catch((err) => {
      console.error("[Interviews] Seeker notification error:", err.message);
    });
  }

  // Notify each invited panel interviewer (excluding the coordinator who scheduled it)
  for (const interviewer of resolvedInterviewers) {
    if (interviewer.email.toLowerCase() === userEmail) continue;

    createNotification({
      recipientEmail: interviewer.email,
      role: "recruiter",
      type: "panel_interview_invitation",
      title: `Panel Interview Assignment: ${application.jobTitle}`,
      message: `You have been assigned as an interviewer on the panel for ${interviewDoc.seekerName} (${application.jobTitle}) scheduled for ${interviewDate.toLocaleDateString()} at ${interviewDate.toLocaleTimeString()} (${timezone}).`,
      link: `/dashboard/recruiter/interviews`,
      referenceId: interviewId,
      referenceType: "interview",
      idempotencyKey: `panel_invite_${interviewId}_${interviewer.email}`,
      sendEmail: true,
      emailTemplate: "panelInterviewInvitation",
      emailData: {
        recipientName: interviewer.name,
        candidateName: interviewDoc.seekerName,
        jobTitle: application.jobTitle,
        companyName: application.companyName,
        scheduledAt: `${interviewDate.toLocaleDateString()} at ${interviewDate.toLocaleTimeString()}`,
        durationMinutes: duration,
        timezone,
        format: interviewDoc.format,
        location: interviewDoc.location,
        roleName: interviewer.role?.replace(/_/g, " "),
        panelMembers: resolvedInterviewers.map((i) => i.name || i.email),
        calendarUrl: googleCalUrl,
        viewUrl: `/dashboard/recruiter/interviews`,
      },
    }).catch((err) => {
      console.error(`[Interviews] Panelist ${interviewer.email} notification error:`, err.message);
    });
  }

  recordAuditLog({
    actor: req.user,
    companyId: interviewDoc.companyId,
    action: isPanel ? "panel_interview_scheduled" : "interview_scheduled",
    targetType: "interview",
    targetId: interviewId,
    targetIdentifier: `${application.jobTitle} - ${interviewDoc.seekerEmail}`,
    after: {
      scheduledAt: interviewDate,
      durationMinutes: duration,
      interviewType: interviewDoc.interviewType,
      interviewersCount: resolvedInterviewers.length,
    },
  });

  created(res, { ...interviewDoc, _id: result.insertedId, googleCalendarUrl: googleCalUrl });
}));

// GET /api/interviews - List interviews for authenticated user
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const { status, applicationId, period = "all" } = req.query;
  const userRole = (req.user.role || "").toLowerCase();
  const userEmail = req.user.email.toLowerCase().trim();
  const isAdmin = userRole === "admin";
  const db = getDb();

  const filter = {};

  if (!isAdmin) {
    if (userRole === "recruiter") {
      const memberships = await getUserCompanyMemberships(userEmail);
      const companyIds = memberships.map((m) => m.companyId);

      const candidateJobs = await db.collection("jobs").find({
        $or: [
          { companyId: { $in: companyIds } },
          { recruiterEmail: new RegExp(`^${userEmail}$`, "i") },
          { assignedMemberEmails: userEmail },
        ],
      }, { projection: { _id: 1, companyId: 1, recruiterEmail: 1, assignedMemberEmails: 1 } }).toArray();

      const accessibleJobIds = [];
      for (const j of candidateJobs) {
        const access = await verifyVacancyAccess(req.user, j, "participate_interviews");
        if (access.authorized) {
          accessibleJobIds.push(j._id.toString());
        }
      }

      filter.$or = [
        { jobId: { $in: accessibleJobIds } },
        { recruiterEmail: new RegExp(`^${userEmail}$`, "i") },
        { "interviewers.email": new RegExp(`^${userEmail}$`, "i") },
      ];
    } else {
      filter.seekerEmail = new RegExp(`^${userEmail}$`, "i");
    }
  }

  if (applicationId) {
    filter.applicationId = applicationId;
  }

  if (status && status !== "All") {
    filter.status = new RegExp(`^${status}$`, "i");
  }

  const now = new Date();
  if (period === "upcoming") {
    filter.scheduledAt = { $gte: now };
  } else if (period === "past") {
    filter.scheduledAt = { $lt: now };
  }

  const interviews = await db
    .collection("interviews")
    .find(filter)
    .sort({ scheduledAt: period === "past" ? -1 : 1 })
    .toArray();

  res.json(interviews);
}));

// GET /api/interviews/:id - Retrieve specific interview details
router.get("/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid interview id");

  const db = getDb();
  const interview = await db.collection("interviews").findOne({ _id });
  if (!interview) return notFound(res, "Interview not found");

  const userRole = (req.user.role || "").toLowerCase();
  const userEmail = req.user.email.toLowerCase().trim();
  const isAdmin = userRole === "admin";

  const isPanelist = Array.isArray(interview.interviewers) &&
    interview.interviewers.some((i) => i.email?.toLowerCase().trim() === userEmail);

  let isAuthorized = isAdmin ||
    interview.recruiterEmail?.toLowerCase() === userEmail ||
    interview.seekerEmail?.toLowerCase() === userEmail ||
    isPanelist;

  if (!isAuthorized) {
    const jobObjectId = toObjectId(interview.jobId);
    const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;
    if (job) {
      const access = await verifyVacancyAccess(req.user, job, "participate_interviews");
      isAuthorized = access.authorized;
    }
  }

  if (!isAuthorized) {
    return res.status(403).json({
      message: "Forbidden: You are not authorized to access this interview appointment.",
    });
  }

  res.json(interview);
}));

// PATCH /api/interviews/:id/participants - Add or remove panel interviewers
router.patch("/:id/participants", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid interview id");

  const { action, email, name, role } = req.body;
  if (!action || !["add", "remove"].includes(action)) {
    return badRequest(res, "action must be 'add' or 'remove'.");
  }
  if (!email) return badRequest(res, "interviewer email is required.");

  const normalizedEmail = email.toLowerCase().trim();
  const db = getDb();
  const interview = await db.collection("interviews").findOne({ _id });
  if (!interview) return notFound(res, "Interview not found");

  const userEmail = req.user.email.toLowerCase().trim();
  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const isDirectRecruiter = interview.recruiterEmail?.toLowerCase() === userEmail;

  let isAuthorized = isAdmin || isDirectRecruiter;
  const jobObjectId = toObjectId(interview.jobId);
  const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;

  if (!isAuthorized && job) {
    const access = await verifyVacancyAccess(req.user, job, "manage_interviews");
    isAuthorized = access.authorized;
  }

  if (!isAuthorized) {
    return res.status(403).json({
      message: "Forbidden: Only authorized hiring managers or coordinators can modify panel participants.",
    });
  }

  if (action === "add") {
    // Validate that proposed panelist has active membership and vacancy access
    if (!isAdmin && job?.companyId) {
      const membership = await getCompanyMembership(normalizedEmail, job.companyId);
      if (!membership || membership.status !== "active") {
        return badRequest(res, `User ${normalizedEmail} is not an active member of this company workspace.`);
      }
      const memberAccess = await verifyVacancyAccess(
        { email: normalizedEmail, companyRole: membership.role },
        job,
        "participate_interviews"
      );
      if (!memberAccess.authorized) {
        return badRequest(res, `User ${normalizedEmail} does not have vacancy permission to participate in interviews.`);
      }
    }

    // Check time conflict and atomically persist newly added panelist under booking lock
    let updated;
    try {
      updated = await withBookingLock([normalizedEmail], async () => {
        const conflict = await findInterviewConflicts({
          interviewers: [normalizedEmail],
          startDate: interview.scheduledAt,
          endDate: interview.endAt,
          excludeInterviewId: _id,
        });

        if (conflict.hasConflict) {
          const err = new Error(
            `Conflict: Interviewer ${normalizedEmail} already has an overlapping appointment at this time.`
          );
          err.status = 409;
          err.conflictDetails = conflict;
          throw err;
        }

        const newParticipant = {
          email: normalizedEmail,
          name: name || normalizedEmail,
          role: ["lead_interviewer", "panelist", "coordinator", "observer"].includes(role) ? role : "panelist",
          responseStatus: "Pending",
          respondedAt: null,
          invitedAt: new Date(),
        };

        // Add or reactivate participant
        const existingIndex = (interview.interviewers || []).findIndex(
          (i) => i.email.toLowerCase() === normalizedEmail
        );

        if (existingIndex >= 0) {
          return await db.collection("interviews").findOneAndUpdate(
            { _id, "interviewers.email": normalizedEmail },
            {
              $set: {
                "interviewers.$.responseStatus": "Pending",
                "interviewers.$.role": newParticipant.role,
                "interviewers.$.name": newParticipant.name,
                "interviewers.$.invitedAt": new Date(),
                updatedAt: new Date(),
              },
              $push: {
                history: {
                  action: "panelist_added",
                  by: userEmail,
                  timestamp: new Date(),
                  notes: `Re-added interviewer ${normalizedEmail} (${newParticipant.role}) to panel`,
                },
              },
            },
            { returnDocument: "after" }
          );
        } else {
          return await db.collection("interviews").findOneAndUpdate(
            { _id },
            {
              $set: { interviewType: "panel", updatedAt: new Date() },
              $push: {
                interviewers: newParticipant,
                history: {
                  action: "panelist_added",
                  by: userEmail,
                  timestamp: new Date(),
                  notes: `Added interviewer ${normalizedEmail} (${newParticipant.role}) to panel`,
                },
              },
            },
            { returnDocument: "after" }
          );
        }
      });
    } catch (err) {
      if (err.status === 409) {
        return res.status(409).json({
          message: err.message,
          conflictDetails: err.conflictDetails || null,
        });
      }
      throw err;
    }

    // Schedule reminders for new panelist
    scheduleInterviewRemindersForRecipient(updated, normalizedEmail).catch(() => {});

    // Notify added panelist
    createNotification({
      recipientEmail: normalizedEmail,
      role: "recruiter",
      type: "panel_interview_invitation",
      title: `Panel Interview Assignment: ${interview.jobTitle}`,
      message: `You were added to the interview panel for ${interview.seekerName} (${interview.jobTitle}).`,
      link: `/dashboard/recruiter/interviews`,
      referenceId: _id.toString(),
      referenceType: "interview",
      sendEmail: true,
      emailTemplate: "panelInterviewInvitation",
      emailData: {
        recipientName: newParticipant.name,
        candidateName: interview.seekerName,
        jobTitle: interview.jobTitle,
        companyName: interview.companyName,
        scheduledAt: new Date(interview.scheduledAt).toLocaleString(),
        durationMinutes: interview.durationMinutes,
        timezone: interview.timezone,
        format: interview.format,
        location: interview.location,
        roleName: newParticipant.role,
        panelMembers: (updated.interviewers || []).map((i) => i.name || i.email),
        viewUrl: `/dashboard/recruiter/interviews`,
      },
    }).catch(() => {});

    recordAuditLog({
      actor: req.user,
      companyId: interview.companyId,
      action: "panel_participant_added",
      targetType: "interview",
      targetId: _id.toString(),
      targetIdentifier: `${interview.jobTitle} - ${normalizedEmail}`,
      after: { addedEmail: normalizedEmail, role: newParticipant.role },
    });

    return res.json(updated);
  } else {
    // action === "remove"
    const updated = await db.collection("interviews").findOneAndUpdate(
      { _id, "interviewers.email": normalizedEmail },
      {
        $set: {
          "interviewers.$.responseStatus": "Removed",
          updatedAt: new Date(),
        },
        $push: {
          history: {
            action: "panelist_removed",
            by: userEmail,
            timestamp: new Date(),
            notes: `Removed interviewer ${normalizedEmail} from panel`,
          },
        },
      },
      { returnDocument: "after" }
    );

    // Invalidate reminders for removed panelist
    await db.collection("scheduled_reminders").updateMany(
      { interviewId: _id.toString(), recipientEmail: normalizedEmail, status: "pending" },
      { $set: { status: "canceled", reason: "panelist_removed", updatedAt: new Date() } }
    );

    recordAuditLog({
      actor: req.user,
      companyId: interview.companyId,
      action: "panel_participant_removed",
      targetType: "interview",
      targetId: _id.toString(),
      targetIdentifier: `${interview.jobTitle} - ${normalizedEmail}`,
      after: { removedEmail: normalizedEmail },
    });

    return res.json(updated);
  }
}));

// PATCH /api/interviews/:id/participants/respond - Accept or Decline panel invitation
router.patch("/:id/participants/respond", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid interview id");

  const { responseStatus, reason = "" } = req.body;
  if (!responseStatus || !["Accepted", "Declined"].includes(responseStatus)) {
    return badRequest(res, "responseStatus must be 'Accepted' or 'Declined'.");
  }

  const db = getDb();
  const interview = await db.collection("interviews").findOne({ _id });
  if (!interview) return notFound(res, "Interview not found");

  const userEmail = req.user.email.toLowerCase().trim();
  const isAdmin = (req.user.role || "").toLowerCase() === "admin";

  const isPanelist = Array.isArray(interview.interviewers) &&
    interview.interviewers.some((i) => i.email.toLowerCase() === userEmail);

  if (!isPanelist && !isAdmin && interview.recruiterEmail?.toLowerCase() !== userEmail) {
    return res.status(403).json({
      message: "Forbidden: You are not assigned to this interview panel.",
    });
  }

  const historyEntry = {
    action: `participant_${responseStatus.toLowerCase()}`,
    by: userEmail,
    timestamp: new Date(),
    notes: reason || `Interviewer ${userEmail} marked response as ${responseStatus}`,
  };

  const updated = await db.collection("interviews").findOneAndUpdate(
    { _id, "interviewers.email": userEmail },
    {
      $set: {
        "interviewers.$.responseStatus": responseStatus,
        "interviewers.$.respondedAt": new Date(),
        "interviewers.$.declineReason": responseStatus === "Declined" ? reason.trim() : null,
        updatedAt: new Date(),
      },
      $push: { history: historyEntry },
    },
    { returnDocument: "after" }
  );

  // If declined, cancel pending reminders for this panelist
  if (responseStatus === "Declined") {
    await db.collection("scheduled_reminders").updateMany(
      { interviewId: _id.toString(), recipientEmail: userEmail, status: "pending" },
      { $set: { status: "canceled", reason: "participant_declined", updatedAt: new Date() } }
    );
  }

  // Notify coordinator / lead recruiter about response
  const coordinatorEmail = interview.recruiterEmail;
  if (coordinatorEmail && coordinatorEmail.toLowerCase() !== userEmail) {
    createNotification({
      recipientEmail: coordinatorEmail,
      role: "recruiter",
      type: "panel_response_received",
      title: `Panel Response: ${req.user.name || userEmail} (${responseStatus})`,
      message: `${req.user.name || userEmail} responded "${responseStatus}" to the panel interview for ${interview.seekerName} (${interview.jobTitle}).`,
      link: `/dashboard/recruiter/interviews`,
      referenceId: _id.toString(),
      referenceType: "interview",
      sendEmail: true,
      emailTemplate: "panelParticipantResponded",
      emailData: {
        recipientName: interview.recruiterName || "Coordinator",
        panelistName: req.user.name || userEmail,
        candidateName: interview.seekerName,
        jobTitle: interview.jobTitle,
        responseStatus,
        reason,
        viewUrl: `/dashboard/recruiter/interviews`,
      },
    }).catch(() => {});
  }

  res.json(updated);
}));

// PATCH /api/interviews/:id/reschedule - Reschedule an interview appointment with conflict revalidation
router.patch("/:id/reschedule", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid interview id");

  const {
    scheduledAt,
    durationMinutes,
    timezone,
    location,
    reason,
  } = req.body;

  if (!scheduledAt) return badRequest(res, "New scheduledAt timestamp is required.");

  const newStartDate = new Date(scheduledAt);
  if (isNaN(newStartDate.getTime())) {
    return badRequest(res, "Invalid scheduledAt timestamp.");
  }

  const db = getDb();
  const interview = await db.collection("interviews").findOne({ _id });
  if (!interview) return notFound(res, "Interview not found");

  const userRole = (req.user.role || "").toLowerCase();
  const userEmail = req.user.email.toLowerCase().trim();
  const isAdmin = userRole === "admin";
  const isDirectRecruiter = interview.recruiterEmail?.toLowerCase() === userEmail;
  const isSeeker = interview.seekerEmail?.toLowerCase() === userEmail;

  let isAuthorizedRecruiter = isDirectRecruiter;
  if (!isAuthorizedRecruiter && !isSeeker && !isAdmin) {
    const jobObjectId = toObjectId(interview.jobId);
    const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;
    if (job) {
      const access = await verifyVacancyAccess(req.user, job, "manage_interviews");
      isAuthorizedRecruiter = access.authorized;
    }
  }

  if (!isAdmin && !isAuthorizedRecruiter && !isSeeker) {
    return res.status(403).json({
      message: "Forbidden: You are not authorized to reschedule this appointment.",
    });
  }

  const duration = durationMinutes
    ? Math.min(180, Math.max(15, Number(durationMinutes)))
    : (interview.durationMinutes || 45);
  const newEndDate = calculateEndDate(newStartDate, duration);

  // Active interviewers to check for conflicts
  const activeInterviewers = (interview.interviewers || []).filter(
    (i) => i.responseStatus !== "Declined" && i.responseStatus !== "Removed"
  );
  const interviewerEmails = activeInterviewers.map((i) => i.email);
  if (interviewerEmails.length === 0 && interview.recruiterEmail) {
    interviewerEmails.push(interview.recruiterEmail);
  }

  // Conflict validation & atomic update under distributed booking lock
  const lockParticipants = [interview.seekerEmail, ...interviewerEmails];

  let updated;
  try {
    updated = await withBookingLock(lockParticipants, async () => {
      const conflict = await findInterviewConflicts({
        interviewers: interviewerEmails,
        seekerEmail: interview.seekerEmail,
        startDate: newStartDate,
        endDate: newEndDate,
        excludeInterviewId: _id,
      });

      if (conflict.hasConflict) {
        const reasons = [];
        if (conflict.candidateConflict) reasons.push("Candidate has a scheduling conflict");
        if (conflict.interviewerConflicts.length > 0) {
          reasons.push(
            `Interviewer(s) ${conflict.interviewerConflicts.map((c) => c.email).join(", ")} have a conflict`
          );
        }
        const err = new Error(`Cannot reschedule: ${reasons.join("; ")} at the requested time.`);
        err.status = 409;
        err.conflictDetails = conflict;
        throw err;
      }

      const nextSequence = (Number(interview.sequence) || 0) + 1;

      const historyEntry = {
        action: "rescheduled",
        by: userEmail,
        timestamp: new Date(),
        previousScheduledAt: interview.scheduledAt,
        newScheduledAt: newStartDate,
        notes: reason || "Appointment rescheduled",
        sequence: nextSequence,
      };

      const updateFields = {
        scheduledAt: newStartDate,
        durationMinutes: duration,
        endAt: newEndDate,
        status: "Rescheduled",
        sequence: nextSequence,
        updatedAt: new Date(),
      };

      if (timezone) updateFields.timezone = timezone;
      if (location) updateFields.location = location.trim();

      // Reset panelists responseStatus to Pending on reschedule (except the person rescheduling)
      if (Array.isArray(interview.interviewers)) {
        updateFields.interviewers = interview.interviewers.map((p) => {
          if (p.responseStatus === "Removed") return p;
          const isRescheduler = p.email.toLowerCase() === userEmail;
          return {
            ...p,
            responseStatus: isRescheduler ? "Accepted" : "Pending",
            respondedAt: isRescheduler ? new Date() : null,
          };
        });
      }

      return await db.collection("interviews").findOneAndUpdate(
        { _id },
        {
          $set: updateFields,
          $push: { history: historyEntry },
        },
        { returnDocument: "after" }
      );
    });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({
        message: err.message,
        conflictDetails: err.conflictDetails || null,
      });
    }
    throw err;
  }

  // Invalidate old reminders and schedule new ones for updated appointment time
  invalidateInterviewReminders(_id, "rescheduled")
    .then(() => scheduleInterviewReminders(updated))
    .catch((err) => console.error("[Interviews] Reschedule reminder update failed:", err.message));

  // Generate updated Google Calendar link
  const allAttendees = [
    { email: interview.seekerEmail, name: interview.seekerName },
    ...(updated.interviewers || []),
  ];

  const googleCalUrl = generateGoogleCalendarUrl({
    title: `${interview.interviewType === "panel" ? "Panel Interview" : "Interview"}: ${interview.jobTitle} - ${interview.companyName}`,
    description: `HireLoop Interview (Rescheduled)\nPosition: ${interview.jobTitle}\nLocation: ${updateFields.location || interview.location}\nNotes: ${reason || ""}`,
    location: updateFields.location || interview.location,
    startDate: newStartDate,
    endDate: newEndDate,
    attendees: allAttendees,
  });

  // Notify candidate
  if (interview.seekerEmail) {
    createNotification({
      recipientEmail: interview.seekerEmail,
      role: "seeker",
      type: "interview_rescheduled",
      title: `Interview Rescheduled: ${interview.jobTitle}`,
      message: `${req.user.name || userEmail} rescheduled your interview to ${newStartDate.toLocaleDateString()} at ${newStartDate.toLocaleTimeString()} (${updateFields.timezone || interview.timezone}).`,
      link: `/dashboard/seeker/applications`,
      referenceId: _id.toString(),
      referenceType: "interview",
      idempotencyKey: `interview_resched_${_id}_${historyEntry.timestamp.getTime()}`,
      sendEmail: true,
      emailTemplate: "interviewRescheduled",
      emailData: {
        jobTitle: interview.jobTitle,
        companyName: interview.companyName,
        previousTime: new Date(interview.scheduledAt).toLocaleString(),
        newTime: newStartDate.toLocaleString(),
        timezone: updateFields.timezone || interview.timezone,
        format: interview.format,
        location: updateFields.location || interview.location,
        reason: reason || "Schedule adjustment",
        calendarUrl: googleCalUrl,
        viewUrl: `/dashboard/seeker/applications`,
      },
    }).catch(() => {});
  }

  // Notify each panel interviewer
  for (const panelist of (updated.interviewers || [])) {
    if (panelist.email.toLowerCase() === userEmail) continue;

    createNotification({
      recipientEmail: panelist.email,
      role: "recruiter",
      type: "panel_interview_rescheduled",
      title: `Panel Rescheduled: ${interview.seekerName} (${interview.jobTitle})`,
      message: `The interview panel for ${interview.seekerName} has been rescheduled to ${newStartDate.toLocaleDateString()} at ${newStartDate.toLocaleTimeString()}.`,
      link: `/dashboard/recruiter/interviews`,
      referenceId: _id.toString(),
      referenceType: "interview",
      sendEmail: true,
      emailTemplate: "interviewRescheduled",
      emailData: {
        jobTitle: interview.jobTitle,
        companyName: interview.companyName,
        previousTime: new Date(interview.scheduledAt).toLocaleString(),
        newTime: newStartDate.toLocaleString(),
        timezone: updateFields.timezone || interview.timezone,
        format: interview.format,
        location: updateFields.location || interview.location,
        reason: reason || "Panel schedule adjustment",
        calendarUrl: googleCalUrl,
        viewUrl: `/dashboard/recruiter/interviews`,
      },
    }).catch(() => {});
  }

  res.json({ ...updated, googleCalendarUrl: googleCalUrl });
}));

// PATCH /api/interviews/:id/status - Update interview status (Confirm, Cancel, Complete)
router.patch("/:id/status", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid interview id");

  const { status, note } = req.body;
  if (!status) return badRequest(res, "Status is required.");

  const matchedStatus = INTERVIEW_STATUSES.find(
    (s) => s.toLowerCase() === status.trim().toLowerCase()
  );
  if (!matchedStatus) {
    return badRequest(res, `Invalid status. Permitted values: ${INTERVIEW_STATUSES.join(", ")}`);
  }

  const db = getDb();
  const interview = await db.collection("interviews").findOne({ _id });
  if (!interview) return notFound(res, "Interview not found");

  const userRole = (req.user.role || "").toLowerCase();
  const userEmail = req.user.email.toLowerCase().trim();
  const isAdmin = userRole === "admin";
  const isDirectRecruiter = interview.recruiterEmail?.toLowerCase() === userEmail;
  const isSeeker = interview.seekerEmail?.toLowerCase() === userEmail;

  let isAuthorizedRecruiter = isDirectRecruiter;
  if (!isAuthorizedRecruiter && !isSeeker && !isAdmin) {
    const jobObjectId = toObjectId(interview.jobId);
    const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;
    if (job) {
      const access = await verifyVacancyAccess(req.user, job, "manage_interviews");
      isAuthorizedRecruiter = access.authorized;
    }
  }

  if (!isAdmin && !isAuthorizedRecruiter && !isSeeker) {
    return res.status(403).json({
      message: "Forbidden: You do not have permission to modify this interview appointment.",
    });
  }

  const historyEntry = {
    action: matchedStatus.toLowerCase(),
    by: userEmail,
    timestamp: new Date(),
    notes: note || `Status updated to ${matchedStatus}`,
  };

  const updated = await db.collection("interviews").findOneAndUpdate(
    { _id },
    {
      $set: { status: matchedStatus, updatedAt: new Date() },
      $push: { history: historyEntry },
    },
    { returnDocument: "after" }
  );

  // Sync scheduled reminders with new status
  if (matchedStatus === "Canceled") {
    invalidateInterviewReminders(_id, "canceled").catch(() => {});
  } else if (matchedStatus === "Completed") {
    invalidateInterviewReminders(_id, "completed").catch(() => {});
    import("../services/pipelineAutomationService.js")
      .then(({ evaluatePipelineAutomation, AUTOMATION_TRIGGERS }) => {
        evaluatePipelineAutomation({
          trigger: AUTOMATION_TRIGGERS.INTERVIEW_COMPLETED,
          applicationId: interview.applicationId,
          jobId: interview.jobId,
          companyId: interview.companyId,
          metadata: { interviewId: _id.toString() },
        }).catch((err) => console.error("[Interviews] Automation trigger error:", err.message));
      })
      .catch(() => {});
  } else if (matchedStatus === "Confirmed") {
    scheduleInterviewReminders(updated).catch(() => {});
  }

  if (matchedStatus === "Canceled") {
    recordAuditLog({
      actor: req.user,
      companyId: interview.companyId,
      action: "interview_canceled",
      targetType: "interview",
      targetId: _id.toString(),
      targetIdentifier: `${interview.jobTitle} - ${interview.seekerEmail}`,
      before: { status: interview.status, scheduledAt: interview.scheduledAt },
      after: { status: "Canceled", note },
    });
  }

  // Notify candidate and active panelists
  const allRecipients = new Set();
  if (interview.seekerEmail) allRecipients.add(interview.seekerEmail.toLowerCase().trim());
  if (interview.recruiterEmail) allRecipients.add(interview.recruiterEmail.toLowerCase().trim());
  for (const p of (interview.interviewers || [])) {
    if (p.responseStatus !== "Removed") allRecipients.add(p.email.toLowerCase().trim());
  }
  allRecipients.delete(userEmail); // Don't notify caller

  for (const recipient of allRecipients) {
    const isCandidate = recipient === interview.seekerEmail?.toLowerCase().trim();
    createNotification({
      recipientEmail: recipient,
      role: isCandidate ? "seeker" : "recruiter",
      type: "interview_status_changed",
      title: `Interview ${matchedStatus}: ${interview.jobTitle}`,
      message: `${req.user.name || userEmail} marked the interview as "${matchedStatus}".`,
      link: `/dashboard/${isCandidate ? "seeker/applications" : "recruiter/interviews"}`,
      referenceId: _id.toString(),
      referenceType: "interview",
      idempotencyKey: `interview_status_${_id}_${matchedStatus}_${historyEntry.timestamp.getTime()}_${recipient}`,
      sendEmail: true,
      emailTemplate: matchedStatus === "Canceled" ? "interviewCanceled" : "interviewStatusUpdated",
      emailData: {
        jobTitle: interview.jobTitle,
        companyName: interview.companyName,
        scheduledAt: new Date(interview.scheduledAt).toLocaleString(),
        newStatus: matchedStatus,
        canceledBy: req.user.name || userEmail,
        reason: note || "",
        viewUrl: `/dashboard/${isCandidate ? "seeker/applications" : "recruiter/interviews"}`,
      },
    }).catch(() => {});
  }

  res.json(updated);
}));

// GET /api/interviews/:id/ics - Export RFC 5545 iCalendar .ics file
router.get("/:id/ics", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid interview id");

  const db = getDb();
  const interview = await db.collection("interviews").findOne({ _id });
  if (!interview) return notFound(res, "Interview not found");

  const userRole = (req.user.role || "").toLowerCase();
  const userEmail = req.user.email.toLowerCase().trim();
  const isAdmin = userRole === "admin";
  const isParticipant =
    interview.recruiterEmail?.toLowerCase() === userEmail ||
    interview.seekerEmail?.toLowerCase() === userEmail ||
    (Array.isArray(interview.interviewers) && interview.interviewers.some((i) => i.email.toLowerCase() === userEmail));

  if (!isAdmin && !isParticipant) {
    return res.status(403).json({
      message: "Forbidden: You are not authorized to download calendar data for this interview.",
    });
  }

  // Assemble full attendee list
  const attendeesList = [
    {
      name: interview.seekerName || "Candidate",
      email: interview.seekerEmail,
      role: "candidate",
      responseStatus: "Accepted",
    },
    ...(interview.interviewers || []),
  ];

  const icsContent = generateIcsInvite({
    interviewId: interview._id.toString(),
    title: `${interview.interviewType === "panel" ? "Panel Interview" : "Interview"}: ${interview.jobTitle} - ${interview.companyName}`,
    description: `Position: ${interview.jobTitle}\nCompany: ${interview.companyName}\nCandidate: ${interview.seekerName}\nFormat: ${interview.format}\nAgenda: ${interview.agenda || "General Interview"}`,
    location: interview.location || "Online Video Call",
    startDate: new Date(interview.scheduledAt),
    endDate: new Date(interview.endAt || calculateEndDate(interview.scheduledAt, interview.durationMinutes)),
    organizerName: interview.companyName || "HireLoop Recruiter",
    organizerEmail: interview.recruiterEmail,
    attendees: attendeesList,
    status: interview.status === "Canceled" ? "CANCELLED" : "CONFIRMED",
    sequence: interview.sequence || 0,
  });

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="interview-${interview._id}.ics"`);
  res.send(icsContent);
}));

export default router;
