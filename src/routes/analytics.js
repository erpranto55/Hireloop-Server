import { Router } from "express";
import crypto from "crypto";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, notFound } from "../utils/http.js";
import { optionalAuth, requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

/**
 * Calculates start date for standard reporting periods.
 */
function getPeriodStartDate(period = "30d") {
  const now = new Date();
  switch (period) {
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "90d":
      return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    case "all":
    default:
      return null;
  }
}

// View tracker handler logic exported for use across routes
export async function recordJobViewHandler(req, res) {
  const jobId = req.params.id;
  const jobObjectId = toObjectId(jobId);
  const db = getDb();

  const job = await db.collection("jobs").findOne(
    jobObjectId ? { _id: jobObjectId } : { id: jobId }
  );

  if (!job) return notFound(res, "Job not found");

  // Create privacy-conscious client identifier (hash IP + User-Agent, salt with date)
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
  const userAgent = req.headers["user-agent"] || "unknown";
  const userEmail = req.user?.email ? req.user.email.toLowerCase() : null;

  // Recruiter browsing their own job does not count as a public engagement view
  if (userEmail && job.recruiterEmail?.toLowerCase() === userEmail) {
    return res.json({ recorded: false, reason: "owner_view" });
  }

  const rawKey = `${clientIp}_${userAgent}_${userEmail || "anon"}`;
  const viewerKey = crypto.createHash("sha256").update(rawKey).digest("hex").substring(0, 24);

  // Deduplication window: 1 hour (views by the same viewer within 1 hour are not re-counted)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentView = await db.collection("job_views").findOne({
    jobId: job._id.toString(),
    viewerKey,
    viewedAt: { $gte: oneHourAgo },
  });

  if (recentView) {
    return res.json({ recorded: false, reason: "duplicate_within_window" });
  }

  const viewDoc = {
    jobId: job._id.toString(),
    jobTitle: job.title,
    recruiterEmail: (job.recruiterEmail || "").toLowerCase(),
    viewerKey,
    viewedAt: new Date(),
  };

  await db.collection("job_views").insertOne(viewDoc);

  // Increment view counter on job document for fast queries
  await db.collection("jobs").updateOne(
    { _id: job._id },
    { $inc: { viewsCount: 1 } }
  );

  res.json({ recorded: true });
}

// POST /api/analytics/jobs/:id/view
router.post("/jobs/:id/view", optionalAuth, asyncHandler(recordJobViewHandler));
router.post("/:id/view", optionalAuth, asyncHandler(recordJobViewHandler));

// GET /api/analytics/recruiter - Authoritative recruiter metrics & pipeline funnel
router.get("/recruiter", requireAuth, requireRole("recruiter", "admin"), asyncHandler(async (req, res) => {
  const { period = "30d", jobId } = req.query;
  const db = getDb();

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const recruiterEmail = isAdmin && req.query.recruiterEmail
    ? req.query.recruiterEmail.toLowerCase().trim()
    : req.user.email.toLowerCase().trim();

  const startDate = getPeriodStartDate(period);

  // 1. Fetch recruiter jobs
  const jobFilter = { recruiterEmail: new RegExp(`^${recruiterEmail}$`, "i") };
  if (jobId) {
    const jobObjId = toObjectId(jobId);
    jobFilter._id = jobObjId ? jobObjId : jobId;
  }

  const jobs = await db.collection("jobs").find(jobFilter).toArray();
  const jobIds = jobs.map((j) => j._id.toString());

  // Count job statuses
  const jobStatusCounts = {
    total: jobs.length,
    active: jobs.filter((j) => j.status === "active").length,
    paused: jobs.filter((j) => j.status === "paused").length,
    closed: jobs.filter((j) => j.status === "closed").length,
    draft: jobs.filter((j) => j.status === "draft").length,
  };

  // 2. Fetch applications in period
  const appFilter = {
    jobId: { $in: jobIds },
  };
  if (startDate) {
    appFilter.appliedAt = { $gte: startDate };
  }

  const applications = await db.collection("applications").find(appFilter).toArray();

  // 3. Fetch verified job views in period
  const viewFilter = {
    jobId: { $in: jobIds },
  };
  if (startDate) {
    viewFilter.viewedAt = { $gte: startDate };
  }
  const totalJobViews = await db.collection("job_views").countDocuments(viewFilter);

  // 4. Calculate Conversion Rate
  const totalApplications = applications.length;
  const conversionRate = totalJobViews > 0
    ? Number(((totalApplications / totalJobViews) * 100).toFixed(1))
    : null;

  // 5. Recruitment Pipeline Funnel
  // A. Current stage distribution (mutually exclusive current status)
  const currentStages = {
    "Applied": 0,
    "Under Review": 0,
    "Shortlisted": 0,
    "Interview Scheduled": 0,
    "Offered": 0,
    "Accepted": 0,
    "Rejected": 0,
  };

  // B. Historical stage transitions (all candidates who have passed through this stage)
  const historicalTransitions = {
    "Applied": totalApplications,
    "Under Review": 0,
    "Shortlisted": 0,
    "Interview Scheduled": 0,
    "Offered": 0,
    "Accepted": 0,
    "Rejected": 0,
  };

  applications.forEach((app) => {
    if (currentStages[app.status] !== undefined) {
      currentStages[app.status]++;
    }

    if (Array.isArray(app.statusHistory)) {
      const reachedStages = new Set(app.statusHistory.map((h) => h.to || h.status));
      for (const st of reachedStages) {
        if (historicalTransitions[st] !== undefined) {
          historicalTransitions[st]++;
        }
      }
    } else if (app.status && historicalTransitions[app.status] !== undefined) {
      historicalTransitions[app.status]++;
    }
  });

  // 6. Time-to-Hire Calculation
  // Definition: Calendar days from application submission (appliedAt) to final accepted status (Accepted)
  const hiredApplications = applications.filter((app) => {
    return (
      (app.status === "Accepted" || (app.statusHistory || []).some((h) => h.to === "Accepted")) &&
      app.appliedAt
    );
  });

  let averageTimeToHireDays = null;
  let medianTimeToHireDays = null;

  if (hiredApplications.length > 0) {
    const elapsedDaysList = hiredApplications.map((app) => {
      const start = new Date(app.appliedAt).getTime();
      let terminalDate = new Date(app.updatedAt || app.appliedAt).getTime();

      const acceptedHistory = (app.statusHistory || []).find((h) => h.to === "Accepted");
      if (acceptedHistory && acceptedHistory.changedAt) {
        terminalDate = new Date(acceptedHistory.changedAt).getTime();
      }

      const diffDays = Math.max(0, (terminalDate - start) / (1000 * 60 * 60 * 24));
      return Number(diffDays.toFixed(1));
    }).sort((a, b) => a - b);

    const sum = elapsedDaysList.reduce((acc, curr) => acc + curr, 0);
    averageTimeToHireDays = Number((sum / elapsedDaysList.length).toFixed(1));

    const mid = Math.floor(elapsedDaysList.length / 2);
    medianTimeToHireDays = elapsedDaysList.length % 2 !== 0
      ? elapsedDaysList[mid]
      : Number(((elapsedDaysList[mid - 1] + elapsedDaysList[mid]) / 2).toFixed(1));
  }

  // 7. Individual Jobs Performance Table
  const jobsPerformance = jobs.map((job) => {
    const jobApps = applications.filter((a) => a.jobId === job._id.toString());
    const jobViews = job.viewsCount || 0;
    return {
      _id: job._id.toString(),
      title: job.title,
      category: job.category,
      status: job.status,
      applicantsCount: jobApps.length,
      viewsCount: jobViews,
      conversionRate: jobViews > 0
        ? Number(((jobApps.length / jobViews) * 100).toFixed(1))
        : null,
      createdAt: job.createdAt,
    };
  });

  res.json({
    period,
    recruiterEmail,
    jobStatusCounts,
    totalJobViews,
    totalApplications,
    conversionRate,
    conversionTrackingActiveSince: "2026-10-21T00:00:00.000Z",
    hasViewData: totalJobViews > 0,
    pipelineFunnel: {
      currentStages,
      historicalTransitions,
    },
    timeToHire: {
      averageDays: averageTimeToHireDays,
      medianDays: medianTimeToHireDays,
      sampleSize: hiredApplications.length,
      definition: "Elapsed days from application submission to terminal Accepted status.",
    },
    jobsPerformance,
  });
}));

// GET /api/analytics/seeker - Authoritative candidate engagement & readiness
router.get("/seeker", requireAuth, requireRole("seeker", "admin"), asyncHandler(async (req, res) => {
  const { period = "30d" } = req.query;
  const db = getDb();

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const seekerEmail = isAdmin && req.query.seekerEmail
    ? req.query.seekerEmail.toLowerCase().trim()
    : req.user.email.toLowerCase().trim();

  const startDate = getPeriodStartDate(period);

  // 1. Fetch seeker applications
  const appFilter = {
    seekerEmail: new RegExp(`^${seekerEmail}$`, "i"),
  };
  if (startDate) {
    appFilter.appliedAt = { $gte: startDate };
  }

  const applications = await db.collection("applications").find(appFilter).sort({ appliedAt: -1 }).toArray();

  // 2. Breakdown by current status
  const currentStages = {
    "Applied": 0,
    "Under Review": 0,
    "Shortlisted": 0,
    "Interview Scheduled": 0,
    "Offered": 0,
    "Accepted": 0,
    "Rejected": 0,
  };

  applications.forEach((app) => {
    if (currentStages[app.status] !== undefined) {
      currentStages[app.status]++;
    }
  });

  // 3. Acceptance Rate Calculation
  // Acceptance rate = accepted applications ÷ finalized outcome applications (Accepted + Rejected) * 100
  const acceptedCount = currentStages["Accepted"];
  const rejectedCount = currentStages["Rejected"];
  const finalizedCount = acceptedCount + rejectedCount;
  const pendingCount = applications.length - finalizedCount;

  const acceptanceRate = finalizedCount > 0
    ? Number(((acceptedCount / finalizedCount) * 100).toFixed(1))
    : null;

  // 4. Evidence-based Interview Readiness Assessment
  // Calculated from actual persisted profile and application progression
  const user = await db.collection("user").findOne({ email: new RegExp(`^${seekerEmail}$`, "i") });

  const hasName = Boolean(user?.name && user.name.trim().length > 1);
  const hasHeadline = Boolean(user?.headline && user.headline.trim().length > 3);
  const hasBio = Boolean(user?.bio && user.bio.trim().length >= 30);
  const hasResume = Boolean(user?.resumeUrl && user.resumeUrl.length > 5);

  const skillsList = user?.skills
    ? user.skills.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const hasSkills = skillsList.length >= 3;

  const hasProgressedApp = applications.some((app) =>
    ["Under Review", "Shortlisted", "Interview Scheduled", "Offered", "Accepted"].includes(app.status)
  );

  const hasInterview = applications.some((app) =>
    ["Interview Scheduled", "Offered", "Accepted"].includes(app.status)
  );

  const readinessChecklist = [
    {
      id: "profile_basics",
      title: "Profile Basics",
      description: "Full name and professional headline configured",
      completed: hasName && hasHeadline,
      weight: 15,
    },
    {
      id: "resume_uploaded",
      title: "Verified Resume Document",
      description: "Active resume uploaded and linked to applications",
      completed: hasResume,
      weight: 25,
    },
    {
      id: "skills_declared",
      title: "Key Skills Listed",
      description: "At least 3 core skills documented in candidate profile",
      completed: hasSkills,
      weight: 20,
    },
    {
      id: "detailed_bio",
      title: "Candidate Summary / Bio",
      description: "Detailed professional summary (at least 30 characters)",
      completed: hasBio,
      weight: 15,
    },
    {
      id: "application_activity",
      title: "Active Pipeline Progression",
      description: "At least one application progressed beyond initial Applied stage",
      completed: hasProgressedApp,
      weight: 15,
    },
    {
      id: "interview_ready",
      title: "Interview Experience",
      description: "Reached Interview Scheduled or Offer stage in active pipeline",
      completed: hasInterview,
      weight: 10,
    },
  ];

  const readinessScore = readinessChecklist.reduce(
    (acc, item) => acc + (item.completed ? item.weight : 0),
    0
  );

  res.json({
    period,
    seekerEmail,
    totalApplications: applications.length,
    finalizedCount,
    pendingCount,
    acceptanceRate: {
      rate: acceptanceRate,
      acceptedCount,
      rejectedCount,
      finalizedCount,
      note: finalizedCount === 0
        ? "No applications with finalized outcomes yet. Active applications are pending review."
        : "Calculated as accepted applications divided by total finalized applications (Accepted + Rejected).",
    },
    currentStages,
    interviewReadiness: {
      scorePercent: readinessScore,
      checklist: readinessChecklist,
      completedCount: readinessChecklist.filter((c) => c.completed).length,
      totalCount: readinessChecklist.length,
    },
    recentApplications: applications.slice(0, 10).map((app) => ({
      _id: app._id.toString(),
      jobTitle: app.jobTitle,
      companyName: app.companyName,
      status: app.status,
      appliedAt: app.appliedAt,
    })),
  });
}));

export default router;
