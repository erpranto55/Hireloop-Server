/**
 * Recruiter Candidate Search & Talent Pool Route
 * Enables recruiters to search and filter candidates within their authorized applicant pool.
 */

import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  getUserCompanyMemberships,
  verifyVacancyAccess,
  COMPANY_ROLES,
} from "../services/companyWorkspaceService.js";

const router = Router();

// GET /api/candidates/search - Recruiter Candidate Search
router.get("/search", requireAuth, requireRole("recruiter", "admin"), asyncHandler(async (req, res) => {
  const {
    q,
    jobId,
    status,
    skill,
    hasResume,
    page = 1,
    limit = 15,
  } = req.query;

  const db = getDb();
  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const recruiterEmail = req.user.email.toLowerCase().trim();

  // 1. Establish authorized job scope across company workspaces
  let authorizedJobs = [];

  if (isAdmin) {
    const jobFilter = {};
    if (jobId) {
      const jobObjectId = toObjectId(jobId);
      jobFilter._id = jobObjectId ? jobObjectId : jobId;
    }
    authorizedJobs = await db.collection("jobs").find(jobFilter, {
      projection: { _id: 1, title: 1, companyName: 1, recruiterEmail: 1, companyId: 1 },
    }).toArray();
  } else {
    const memberships = await getUserCompanyMemberships(recruiterEmail);
    const membershipMap = new Map();
    memberships.forEach((m) => membershipMap.set(m.companyId, m.role));

    // Interviewers cannot perform global candidate search; they can only see jobs they are assigned to
    const ownerOrHmCompanyIds = memberships
      .filter((m) => m.role === COMPANY_ROLES.OWNER || m.role === COMPANY_ROLES.HIRING_MANAGER)
      .map((m) => m.companyId);

    const queryOr = [
      { recruiterEmail: new RegExp(`^${recruiterEmail}$`, "i") },
      { assignedMemberEmails: recruiterEmail },
    ];
    if (ownerOrHmCompanyIds.length > 0) {
      queryOr.push({ companyId: { $in: ownerOrHmCompanyIds } });
    }

    const candidateJobs = await db.collection("jobs").find(
      { $or: queryOr },
      { projection: { _id: 1, title: 1, companyName: 1, recruiterEmail: 1, companyId: 1, assignedMemberEmails: 1 } }
    ).toArray();

    // Verify access
    for (const job of candidateJobs) {
      if (jobId && job._id.toString() !== jobId.toString()) continue;
      const access = await verifyVacancyAccess(req.user, job, "view");
      if (access.authorized) {
        authorizedJobs.push(job);
      }
    }
  }

  const authorizedJobIds = authorizedJobs.map((j) => j._id.toString());

  // If recruiter has no jobs, return early with empty paginated result
  if (authorizedJobIds.length === 0 && !isAdmin) {
    return res.json({
      candidates: [],
      total: 0,
      page: 1,
      limit: Number(limit) || 15,
      totalPages: 1,
      recruiterJobs: [],
    });
  }

  // 2. Build application filter strictly scoped to authorized jobs
  const appFilter = {};
  if (!isAdmin) {
    appFilter.jobId = { $in: authorizedJobIds };
  } else if (jobId) {
    appFilter.jobId = jobId;
  }

  if (status && status !== "All") {
    appFilter.status = new RegExp(`^${status.trim()}$`, "i");
  }

  if (hasResume === "true") {
    appFilter.$or = [
      { resumeUrl: { $exists: true, $ne: "" } },
      { resumeFileId: { $exists: true, $ne: "" } },
    ];
  } else if (hasResume === "false") {
    appFilter.resumeUrl = { $in: [null, ""] };
    appFilter.resumeFileId = { $in: [null, ""] };
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const pageLimit = Math.min(50, Math.max(1, Number(limit) || 15));
  const skip = (pageNum - 1) * pageLimit;

  // 3. Search query filter
  if (q && q.trim()) {
    const searchRegex = new RegExp(q.trim(), "i");
    appFilter.$or = [
      { seekerName: searchRegex },
      { seekerEmail: searchRegex },
      { jobTitle: searchRegex },
      { coverLetter: searchRegex },
    ];
  }

  // Query applications with pagination
  const [applications, totalCount] = await Promise.all([
    db.collection("applications")
      .find(appFilter)
      .sort({ appliedAt: -1 })
      .skip(skip)
      .limit(pageLimit)
      .toArray(),
    db.collection("applications").countDocuments(appFilter),
  ]);

  // 4. Enrich with candidate profile information and parsed resume summary
  const seekerEmails = [...new Set(applications.map((a) => (a.seekerEmail || "").toLowerCase()).filter(Boolean))];
  const resumeFileIds = [...new Set(applications.map((a) => a.resumeFileId).filter(Boolean))];

  const [users, parsedResumes] = await Promise.all([
    db.collection("user").find(
      { email: { $in: seekerEmails.map((e) => new RegExp(`^${e}$`, "i")) } },
      { projection: { password: 0, stripeCustomerId: 0 } }
    ).toArray(),
    db.collection("parsed_resumes").find(
      { fileId: { $in: resumeFileIds } }
    ).toArray(),
  ]);

  const userMap = new Map();
  users.forEach((u) => {
    if (u.email) userMap.set(u.email.toLowerCase(), u);
  });

  const parsedResumeMap = new Map();
  parsedResumes.forEach((pr) => {
    if (pr.fileId) parsedResumeMap.set(pr.fileId, pr);
  });

  // Filter by skill if requested
  let candidates = applications.map((app) => {
    const userProfile = userMap.get((app.seekerEmail || "").toLowerCase());
    const parsedData = parsedResumeMap.get(app.resumeFileId);

    // Profile skills (comma-separated string in user model)
    const profileSkills = userProfile?.skills
      ? userProfile.skills.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    // Extracted resume skills (from parsed resume service)
    const resumeSkills = parsedData?.data?.skills || [];
    const allSkills = [...new Set([...profileSkills, ...resumeSkills])];

    return {
      applicationId: app._id.toString(),
      jobId: app.jobId,
      jobTitle: app.jobTitle,
      companyName: app.companyName,
      seekerName: app.seekerName || userProfile?.name || "Candidate",
      seekerEmail: app.seekerEmail,
      headline: userProfile?.headline || "",
      bio: userProfile?.bio || "",
      image: userProfile?.image || "",
      status: app.status,
      appliedAt: app.appliedAt,
      resumeUrl: app.resumeUrl || (app.resumeFileId ? `/api/resumes/${app.resumeFileId}` : ""),
      resumeFileId: app.resumeFileId || "",
      skills: allSkills,
      parsedSummary: parsedData?.data?.summary || null,
      parsedEducation: parsedData?.data?.education || [],
      parsingStatus: parsedData?.status || "not_parsed",
      // Include recruiter's own notes for this application, but NEVER notes from another recruiter
      recruiterNotes: (!isAdmin && app.recruiterEmail?.toLowerCase() !== recruiterEmail)
        ? undefined
        : app.recruiterNotes,
    };
  });

  if (skill && skill !== "All") {
    const skillRegex = new RegExp(`^${skill.trim()}$`, "i");
    candidates = candidates.filter((c) => c.skills.some((s) => skillRegex.test(s)));
  }

  res.json({
    candidates,
    total: totalCount,
    page: pageNum,
    limit: pageLimit,
    totalPages: Math.ceil(totalCount / pageLimit) || 1,
    recruiterJobs: authorizedJobs.map((j) => ({
      _id: j._id.toString(),
      title: j.title,
    })),
  });
}));

export default router;
