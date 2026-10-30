import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getSeekerApplicationLimit } from "../config/plans.js";
import { createNotification } from "../services/notificationService.js";
import {
  verifyVacancyAccess,
  getUserCompanyMemberships,
  assignCandidateReview,
} from "../services/companyWorkspaceService.js";

const router = Router();

// Standardized application lifecycle stages
export const APPLICATION_STATUSES = [
  "Applied",
  "Under Review",
  "Shortlisted",
  "Interview Scheduled",
  "Offered",
  "Accepted",
  "Rejected",
];

// Valid transition rules for recruiters
export const ALLOWED_STATUS_TRANSITIONS = {
  "Applied": ["Under Review", "Rejected"],
  "Under Review": ["Shortlisted", "Rejected"],
  "Shortlisted": ["Interview Scheduled", "Offered", "Rejected"],
  "Interview Scheduled": ["Offered", "Rejected"],
  "Offered": ["Accepted", "Rejected"],
  "Accepted": [], // Terminal stage
  "Rejected": [], // Terminal stage
};

/**
 * Strips private recruiter notes and internal review data from seeker responses.
 */
export function sanitizeApplicationForSeeker(app) {
  if (!app) return app;
  const sanitized = { ...app };
  delete sanitized.recruiterNotes;
  delete sanitized.notesHistory;
  delete sanitized.reviewStatus;
  delete sanitized.reviewStatusUpdatedAt;
  delete sanitized.evaluationSummary;
  delete sanitized.evaluations;
  delete sanitized.scorecard;
  delete sanitized.candidateReviewAssignments;
  return sanitized;
}

// GET /api/applications - List applications with strict role scoping and note redaction
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const { seekerEmail, jobId, recruiterEmail, status } = req.query;
  const filter = {};
  const userRole = (req.user.role || "seeker").toLowerCase();
  const db = getDb();

  if (userRole === "admin") {
    // Admin can filter by any parameter
    if (seekerEmail) filter.seekerEmail = new RegExp(`^${seekerEmail}$`, "i");
    if (jobId) filter.jobId = jobId;
    if (recruiterEmail) filter.recruiterEmail = new RegExp(`^${recruiterEmail}$`, "i");
  } else if (userRole === "recruiter") {
    // Recruiter can view applications for all company vacancies they have access to
    if (jobId) {
      const jobObjectId = toObjectId(jobId);
      const job = await db.collection("jobs").findOne(jobObjectId ? { _id: jobObjectId } : { id: jobId });
      if (!job) return notFound(res, "Job listing not found");

      const access = await verifyVacancyAccess(req.user, job, "view");
      if (!access.authorized) {
        return res.status(403).json({
          message: `Forbidden: ${access.reason}`,
        });
      }
      filter.jobId = jobId;
    } else {
      // Find all company workspaces user belongs to
      const memberships = await getUserCompanyMemberships(req.user.email);
      const companyIds = memberships.map((m) => m.companyId);

      // Find all jobs belonging to these companies or directly created by this user
      const candidateJobs = await db.collection("jobs").find({
        $or: [
          { companyId: { $in: companyIds } },
          { recruiterEmail: new RegExp(`^${req.user.email}$`, "i") },
          { assignedMemberEmails: req.user.email.toLowerCase() },
        ],
      }, { projection: { _id: 1, companyId: 1, recruiterEmail: 1, assignedMemberEmails: 1 } }).toArray();

      const accessibleJobIds = [];
      for (const j of candidateJobs) {
        const access = await verifyVacancyAccess(req.user, j, "view");
        if (access.authorized) {
          accessibleJobIds.push(j._id.toString());
        }
      }

      filter.$or = [
        { jobId: { $in: accessibleJobIds } },
        { recruiterEmail: new RegExp(`^${req.user.email}$`, "i") },
      ];
    }
  } else {
    // Seeker can strictly only view their own applications
    filter.seekerEmail = new RegExp(`^${req.user.email}$`, "i");
    if (jobId) filter.jobId = jobId;
  }

  if (status) {
    filter.status = new RegExp(`^${status}$`, "i");
  }

  const applications = await db
    .collection("applications")
    .find(filter)
    .sort({ appliedAt: -1 })
    .toArray();

  // Redact private recruiter notes if viewed by a seeker
  if (userRole === "seeker") {
    return res.json(applications.map(sanitizeApplicationForSeeker));
  }

  res.json(applications);
}));

// GET /api/applications/:id - View single application details
router.get("/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid application id");

  const db = getDb();
  const application = await db.collection("applications").findOne({ _id });
  if (!application) return notFound(res, "Application not found");

  const userRole = (req.user.role || "").toLowerCase();
  const userEmail = req.user.email.toLowerCase();

  const isOwnerSeeker = application.seekerEmail?.toLowerCase() === userEmail;
  const isAdmin = userRole === "admin";

  let isAuthorizedRecruiter = application.recruiterEmail?.toLowerCase() === userEmail;
  if (!isAuthorizedRecruiter && !isAdmin && !isOwnerSeeker) {
    const jobObjectId = toObjectId(application.jobId);
    const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;
    if (job) {
      const access = await verifyVacancyAccess(req.user, job, "view");
      isAuthorizedRecruiter = access.authorized;
    }
  }

  if (!isOwnerSeeker && !isAuthorizedRecruiter && !isAdmin) {
    return res.status(403).json({
      message: "Forbidden: You do not have permission to view this application.",
    });
  }

  if (isOwnerSeeker && !isAdmin && !isAuthorizedRecruiter) {
    return res.json(sanitizeApplicationForSeeker(application));
  }

  res.json(application);
}));

// POST /api/applications - Submit application (Seekers or Admin)
router.post("/", requireAuth, requireRole("seeker", "admin"), asyncHandler(async (req, res) => {
  const required = ["jobId", "jobTitle", "companyName"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const seekerEmail = isAdmin && req.body.seekerEmail ? req.body.seekerEmail.toLowerCase() : req.user.email.toLowerCase();
  const seekerName = isAdmin && req.body.seekerName ? req.body.seekerName : (req.user.name || "Candidate");

  const db = getDb();

  // Fetch job to ensure it exists and is currently active
  const jobObjectId = toObjectId(req.body.jobId);
  const job = await db.collection("jobs").findOne(jobObjectId ? { _id: jobObjectId } : { id: req.body.jobId });
  if (!job) return notFound(res, "Job listing not found");

  if (job.status && job.status.toLowerCase() !== "active") {
    return res.status(400).json({
      message: "This job listing is no longer active and is not accepting applications.",
    });
  }

  // Prevent duplicate applications for the same job by the same seeker
  const existingApp = await db.collection("applications").findOne({
    jobId: req.body.jobId,
    seekerEmail: new RegExp(`^${seekerEmail}$`, "i"),
  });

  if (existingApp) {
    return res.status(409).json({
      message: "You have already submitted an application for this job listing.",
      applicationId: existingApp._id,
    });
  }

  // Check monthly application quota for job seekers
  if (!isAdmin) {
    const user = await db.collection("user").findOne({ email: new RegExp(`^${seekerEmail}$`, "i") });
    const planName = user?.plan || "Free";
    const limit = getSeekerApplicationLimit(planName);

    if (limit !== Infinity) {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const monthlyCount = await db.collection("applications").countDocuments({
        seekerEmail: new RegExp(`^${seekerEmail}$`, "i"),
        appliedAt: { $gte: startOfMonth },
      });

      if (monthlyCount >= limit) {
        return res.status(403).json({
          message: `Monthly application limit reached for your ${planName} plan (${limit} applications allowed per month). Please upgrade your plan to apply to more jobs.`,
          limit,
          monthlyCount,
          plan: planName,
        });
      }
    }
  }

  // Sanitize input: Disallow client-provided privileged status or recruiter notes
  const application = {
    jobId: req.body.jobId,
    jobTitle: job.title || req.body.jobTitle,
    companyId: job.companyId || req.body.companyId || "",
    companyName: job.companyName || req.body.companyName,
    seekerEmail,
    seekerName,
    recruiterEmail: job.recruiterEmail ? job.recruiterEmail.toLowerCase() : (req.body.recruiterEmail || "").toLowerCase(),
    resumeUrl: req.body.resumeUrl || "",
    resumeFileId: req.body.resumeFileId || "",
    coverLetter: req.body.coverLetter || "",
    status: "Applied", // Always initialize to "Applied"
    statusHistory: [
      {
        status: "Applied",
        changedBy: req.user.email,
        changedAt: new Date(),
      },
    ],
    appliedAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection("applications").insertOne(application);

  if (jobObjectId) {
    await db.collection("jobs").updateOne({ _id: jobObjectId }, { $inc: { applicantsCount: 1 } });
  }

  // Notify recruiter of new application submission
  if (application.recruiterEmail) {
    createNotification({
      recipientEmail: application.recruiterEmail,
      role: "recruiter",
      type: "application_received",
      title: "New Application Received",
      message: `${application.seekerName} submitted an application for ${application.jobTitle}.`,
      link: `/dashboard/jobs/${application.jobId}/applicants`,
      referenceId: result.insertedId.toString(),
      referenceType: "application",
      idempotencyKey: `app_create_${result.insertedId}`,
      sendEmail: true,
      emailTemplate: "applicationReceived",
      emailData: {
        seekerName: application.seekerName,
        jobTitle: application.jobTitle,
        companyName: application.companyName,
        reviewUrl: `/dashboard/jobs/${application.jobId}/applicants`,
      },
    }).catch((err) => {
      console.error("[Applications] Recruiter notification error:", err.message);
    });
  }

  created(res, { ...application, _id: result.insertedId });
}));

// PATCH /api/applications/:id/status - Update application lifecycle status (Recruiter or Admin only)
router.patch("/:id/status", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid application id");
  if (!req.body.status) return badRequest(res, "Status is required");

  const newStatus = req.body.status.trim();
  const matchedStatus = APPLICATION_STATUSES.find(
    (s) => s.toLowerCase() === newStatus.toLowerCase()
  );

  if (!matchedStatus) {
    return badRequest(
      res,
      `Invalid status: "${newStatus}". Permitted statuses are: ${APPLICATION_STATUSES.join(", ")}`
    );
  }

  const db = getDb();
  const application = await db.collection("applications").findOne({ _id });
  if (!application) return notFound(res, "Application not found");

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";

  let isAuthorizedRecruiter = false;
  if (!isAdmin) {
    const jobObjectId = toObjectId(application.jobId);
    const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;
    if (job) {
      const access = await verifyVacancyAccess(req.user, job, "review_applications");
      isAuthorizedRecruiter = access.authorized;
    } else {
      isAuthorizedRecruiter = application.recruiterEmail?.toLowerCase() === req.user.email?.toLowerCase();
    }
  }

  if (!isAdmin && !isAuthorizedRecruiter) {
    return res.status(403).json({
      message: "Forbidden: Only an authorized company recruiter or administrator can update application status.",
    });
  }

  // Validate state transitions for recruiters (Admin can override)
  const currentStatus = application.status || "Applied";

  if (!isAdmin && currentStatus.toLowerCase() !== matchedStatus.toLowerCase()) {
    const allowed = ALLOWED_STATUS_TRANSITIONS[currentStatus] || [];
    const isAllowed = allowed.some((s) => s.toLowerCase() === matchedStatus.toLowerCase());

    if (!isAllowed) {
      return res.status(400).json({
        message: `Cannot transition application status from "${currentStatus}" to "${matchedStatus}". Permitted next stages: ${allowed.length ? allowed.join(", ") : "None (application is closed)"}.`,
      });
    }
  }

  const statusHistoryEntry = {
    from: currentStatus,
    to: matchedStatus,
    changedBy: req.user.email,
    changedAt: new Date(),
    note: req.body.note || undefined,
  };

  const result = await db.collection("applications").findOneAndUpdate(
    { _id },
    {
      $set: { status: matchedStatus, updatedAt: new Date() },
      $push: { statusHistory: statusHistoryEntry },
    },
    { returnDocument: "after" }
  );

  // Notify seeker if status transitioned to a new stage (never leaking private recruiter notes)
  if (currentStatus.toLowerCase() !== matchedStatus.toLowerCase() && application.seekerEmail) {
    createNotification({
      recipientEmail: application.seekerEmail,
      role: "seeker",
      type: "application_status_changed",
      title: `Application Status: ${matchedStatus}`,
      message: `Your application for ${application.jobTitle} at ${application.companyName} has been updated to "${matchedStatus}".`,
      link: `/dashboard/seeker/applications`,
      referenceId: application._id.toString(),
      referenceType: "application",
      idempotencyKey: `app_status_${application._id}_${matchedStatus}_${statusHistoryEntry.changedAt.getTime()}`,
      sendEmail: true,
      emailTemplate: "applicationStatusChanged",
      emailData: {
        jobTitle: application.jobTitle,
        companyName: application.companyName,
        newStatus: matchedStatus,
        viewUrl: `/dashboard/seeker/applications`,
      },
    }).catch((err) => {
      console.error("[Applications] Seeker notification error:", err.message);
    });
  }

  res.json(result);
}));

// PATCH /api/applications/:id/notes - Add or edit private recruiter notes (Recruiter or Admin only)
router.patch("/:id/notes", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid application id");

  const notesText = typeof req.body.notes === "string" ? req.body.notes : req.body.note;
  if (notesText === undefined) {
    return badRequest(res, "Notes content is required.");
  }

  const db = getDb();
  const application = await db.collection("applications").findOne({ _id });
  if (!application) return notFound(res, "Application not found");

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";

  let isAuthorizedRecruiter = false;
  if (!isAdmin) {
    const jobObjectId = toObjectId(application.jobId);
    const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;
    if (job) {
      const access = await verifyVacancyAccess(req.user, job, "internal_notes");
      isAuthorizedRecruiter = access.authorized;
    } else {
      isAuthorizedRecruiter = application.recruiterEmail?.toLowerCase() === req.user.email?.toLowerCase();
    }
  }

  if (!isAdmin && !isAuthorizedRecruiter) {
    return res.status(403).json({
      message: "Forbidden: Only an authorized company recruiter or administrator can modify private notes.",
    });
  }

  const noteEntry = {
    content: notesText,
    author: req.user.email,
    authorName: req.user.name || "Recruiter",
    updatedAt: new Date(),
  };

  const result = await db.collection("applications").findOneAndUpdate(
    { _id },
    {
      $set: {
        recruiterNotes: notesText,
        updatedAt: new Date(),
      },
      $push: {
        notesHistory: noteEntry,
      },
    },
    { returnDocument: "after" }
  );

  res.json(result);
}));

// PATCH /api/applications/:id/assign - Assign candidate review to team member
router.patch("/:id/assign", requireAuth, asyncHandler(async (req, res) => {
  const { reviewerEmail } = req.body;
  try {
    const result = await assignCandidateReview({
      applicationId: req.params.id,
      reviewerEmail,
      actorUser: req.user,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}));

export default router;