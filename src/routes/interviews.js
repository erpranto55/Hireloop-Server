/**
 * Interview Scheduling Route for HireLoop
 * Propose, manage, confirm, reschedule, and export interview appointments.
 */

import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { requireAuth } from "../middleware/auth.js";
import { createNotification } from "../services/notificationService.js";
import { recordAuditLog } from "../services/auditService.js";
import { generateIcsInvite, generateGoogleCalendarUrl } from "../services/calendarService.js";
import { scheduleInterviewReminders, invalidateInterviewReminders } from "../services/reminderService.js";
import {
  verifyVacancyAccess,
  getUserCompanyMemberships,
} from "../services/companyWorkspaceService.js";

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

// POST /api/interviews - Propose / Schedule an interview (Recruiter or Admin)
router.post("/", requireAuth, asyncHandler(async (req, res) => {
  const {
    applicationId,
    scheduledAt,
    durationMinutes = 45,
    timezone = "UTC",
    format = "video",
    location,
    agenda = "",
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
  const userEmail = req.user.email.toLowerCase();
  const isAdmin = userRole === "admin";

  let isAuthorized = isAdmin;
  if (!isAdmin) {
    const jobObjectId = toObjectId(application.jobId);
    const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;
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

  const interviewDoc = {
    applicationId: application._id.toString(),
    jobId: application.jobId,
    jobTitle: application.jobTitle,
    companyName: application.companyName,
    recruiterEmail: application.recruiterEmail || userEmail,
    recruiterName: req.user.name || "Recruiter",
    seekerEmail: (application.seekerEmail || "").toLowerCase(),
    seekerName: application.seekerName || "Candidate",
    scheduledAt: interviewDate,
    durationMinutes: duration,
    endAt: endDate,
    timezone,
    format: ["video", "in-person", "phone"].includes(format) ? format : "video",
    location: location ? location.trim() : (format === "video" ? "HireLoop Video Call Room" : ""),
    agenda: agenda ? agenda.trim() : "",
    status: "Proposed",
    history: [
      {
        action: "proposed",
        by: userEmail,
        timestamp: new Date(),
        notes: agenda || "Initial interview scheduled",
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection("interviews").insertOne(interviewDoc);
  const interviewId = result.insertedId.toString();
  interviewDoc._id = result.insertedId;

  // Schedule durable 24h & 1h reminders
  scheduleInterviewReminders(interviewDoc).catch((err) => {
    console.error("[Interviews] Reminder schedule error:", err.message);
  });

  // If application is in Applied or Under Review or Shortlisted, advance status to Interview Scheduled
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
            note: `Interview scheduled for ${interviewDate.toUTCString()}`,
          },
        },
      }
    );
  }

  // Generate Google Calendar Link for notification CTA
  const googleCalUrl = generateGoogleCalendarUrl({
    title: `Interview: ${application.jobTitle} with ${application.companyName}`,
    description: `HireLoop Interview Appointment\nPosition: ${application.jobTitle}\nFormat: ${interviewDoc.format}\nLocation: ${interviewDoc.location}\nAgenda: ${interviewDoc.agenda}`,
    location: interviewDoc.location,
    startDate: interviewDate,
    endDate,
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

  created(res, { ...interviewDoc, _id: result.insertedId, googleCalendarUrl: googleCalUrl });
}));

// GET /api/interviews - List interviews for authenticated user
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const { status, applicationId, period = "all" } = req.query;
  const userRole = (req.user.role || "").toLowerCase();
  const userEmail = req.user.email.toLowerCase();
  const isAdmin = userRole === "admin";

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

  const db = getDb();
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
  const userEmail = req.user.email.toLowerCase();
  const isAdmin = userRole === "admin";

  let isAuthorized = isAdmin ||
    interview.recruiterEmail?.toLowerCase() === userEmail ||
    interview.seekerEmail?.toLowerCase() === userEmail;

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
  const userEmail = req.user.email.toLowerCase();
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

  // If canceled, record administrative/recruiter audit entry
  if (matchedStatus === "Canceled") {
    recordAuditLog({
      actor: req.user,
      action: "interview_canceled",
      targetType: "interview",
      targetId: _id.toString(),
      targetIdentifier: `${interview.jobTitle} - ${interview.seekerEmail}`,
      before: { status: interview.status, scheduledAt: interview.scheduledAt },
      after: { status: "Canceled", note },
    });
  }

  // Notify the other participant
  const recipientEmail = isSeeker ? interview.recruiterEmail : interview.seekerEmail;
  const recipientRole = isSeeker ? "recruiter" : "seeker";

  if (recipientEmail) {
    createNotification({
      recipientEmail,
      role: recipientRole,
      type: "interview_status_changed",
      title: `Interview ${matchedStatus}: ${interview.jobTitle}`,
      message: `${req.user.name || userEmail} marked the interview as "${matchedStatus}".`,
      link: `/dashboard/${recipientRole === "recruiter" ? "jobs" : "seeker/applications"}`,
      referenceId: _id.toString(),
      referenceType: "interview",
      idempotencyKey: `interview_status_${_id}_${matchedStatus}_${historyEntry.timestamp.getTime()}`,
      sendEmail: true,
      emailTemplate: matchedStatus === "Canceled" ? "interviewCanceled" : "interviewStatusUpdated",
      emailData: {
        jobTitle: interview.jobTitle,
        companyName: interview.companyName,
        scheduledAt: new Date(interview.scheduledAt).toLocaleString(),
        newStatus: matchedStatus,
        canceledBy: req.user.name || userEmail,
        reason: note || "",
        viewUrl: `/dashboard/${recipientRole === "recruiter" ? "recruiter" : "seeker/applications"}`,
      },
    }).catch((err) => {
      console.error("[Interviews] Notification dispatch error:", err.message);
    });
  }

  res.json(updated);
}));

// PATCH /api/interviews/:id/reschedule - Reschedule an interview appointment
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
  const userEmail = req.user.email.toLowerCase();
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

  const historyEntry = {
    action: "rescheduled",
    by: userEmail,
    timestamp: new Date(),
    previousScheduledAt: interview.scheduledAt,
    newScheduledAt: newStartDate,
    notes: reason || "Appointment rescheduled",
  };

  const updateFields = {
    scheduledAt: newStartDate,
    durationMinutes: duration,
    endAt: newEndDate,
    status: "Rescheduled",
    updatedAt: new Date(),
  };

  if (timezone) updateFields.timezone = timezone;
  if (location) updateFields.location = location.trim();

  const updated = await db.collection("interviews").findOneAndUpdate(
    { _id },
    {
      $set: updateFields,
      $push: { history: historyEntry },
    },
    { returnDocument: "after" }
  );

  // Invalidate old reminders and schedule new ones for updated appointment time
  invalidateInterviewReminders(_id, "rescheduled")
    .then(() => scheduleInterviewReminders(updated))
    .catch((err) => console.error("[Interviews] Reschedule reminder update failed:", err.message));

  // Notify the other party
  const recipientEmail = isSeeker ? interview.recruiterEmail : interview.seekerEmail;
  const recipientRole = isSeeker ? "recruiter" : "seeker";

  const googleCalUrl = generateGoogleCalendarUrl({
    title: `Interview: ${interview.jobTitle} with ${interview.companyName}`,
    description: `HireLoop Interview (Rescheduled)\nPosition: ${interview.jobTitle}\nLocation: ${updateFields.location || interview.location}\nNotes: ${reason || ""}`,
    location: updateFields.location || interview.location,
    startDate: newStartDate,
    endDate: newEndDate,
  });

  if (recipientEmail) {
    createNotification({
      recipientEmail,
      role: recipientRole,
      type: "interview_rescheduled",
      title: `Interview Rescheduled: ${interview.jobTitle}`,
      message: `${req.user.name || userEmail} rescheduled the interview to ${newStartDate.toLocaleDateString()} at ${newStartDate.toLocaleTimeString()}.`,
      link: `/dashboard/${recipientRole === "recruiter" ? "jobs" : "seeker/applications"}`,
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
        viewUrl: `/dashboard/${recipientRole === "recruiter" ? "jobs" : "seeker/applications"}`,
      },
    }).catch((err) => {
      console.error("[Interviews] Notification dispatch error:", err.message);
    });
  }

  res.json({ ...updated, googleCalendarUrl: googleCalUrl });
}));

// GET /api/interviews/:id/ics - Export RFC 5545 iCalendar .ics file
router.get("/:id/ics", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid interview id");

  const db = getDb();
  const interview = await db.collection("interviews").findOne({ _id });
  if (!interview) return notFound(res, "Interview not found");

  const userRole = (req.user.role || "").toLowerCase();
  const userEmail = req.user.email.toLowerCase();
  const isAdmin = userRole === "admin";
  const isParticipant =
    interview.recruiterEmail?.toLowerCase() === userEmail ||
    interview.seekerEmail?.toLowerCase() === userEmail;

  if (!isAdmin && !isParticipant) {
    return res.status(403).json({
      message: "Forbidden: You are not authorized to download calendar data for this interview.",
    });
  }

  const icsContent = generateIcsInvite({
    interviewId: interview._id.toString(),
    title: `HireLoop Interview: ${interview.jobTitle} - ${interview.companyName}`,
    description: `Position: ${interview.jobTitle}\nCompany: ${interview.companyName}\nCandidate: ${interview.seekerName}\nFormat: ${interview.format}\nAgenda: ${interview.agenda || "General Interview"}`,
    location: interview.location || "Online Video Call",
    startDate: new Date(interview.scheduledAt),
    endDate: new Date(interview.endAt || calculateEndDate(interview.scheduledAt, interview.durationMinutes)),
    organizerName: interview.companyName,
    organizerEmail: interview.recruiterEmail,
    attendeeName: interview.seekerName,
    attendeeEmail: interview.seekerEmail,
    status: interview.status === "Canceled" ? "CANCELLED" : "CONFIRMED",
  });

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="interview-${interview._id}.ics"`);
  res.send(icsContent);
}));

export default router;
