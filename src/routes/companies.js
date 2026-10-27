import { Router } from "express";
import { getDb, toObjectId } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { optionalAuth, requireAuth, requireRole, requirePermission, hasPermission } from "../middleware/auth.js";
import { recordAuditLog } from "../services/auditService.js";
import { PERMISSIONS } from "../services/permissionService.js";
import {
  COMPANY_ROLES,
  getCompanyMembership,
  getUserCompanyMemberships,
  verifyCompanyAccess,
  createTeamInvitation,
  revokeTeamInvitation,
  listCompanyMembers,
  listCompanyInvitations,
  updateMemberRole,
  removeCompanyMember,
  transferCompanyOwnership,
  getCompanyActivityLogs,
} from "../services/companyWorkspaceService.js";

const router = Router();

// GET /api/companies - Public view of approved companies, recruiter's own, or admin full list
router.get("/", optionalAuth, asyncHandler(async (req, res) => {
  const { status = "approved", industry, recruiterEmail } = req.query;
  const filter = {};
  const isAdmin = req.user && (req.user.role || "").toLowerCase() === "admin";
  const isOwnerRecruiter = req.user && recruiterEmail && req.user.email.toLowerCase() === recruiterEmail.toLowerCase();

  if (isAdmin) {
    if (status !== "all") filter.status = status;
  } else if (isOwnerRecruiter) {
    // A recruiter can see their own company regardless of whether it's pending or approved
    if (status !== "all") filter.status = status;
  } else {
    // General public and other users only see approved companies
    filter.status = "approved";
  }

  if (industry) filter.industry = industry;
  if (recruiterEmail) filter.recruiterEmail = new RegExp(`^${recruiterEmail}$`, "i");

  const companies = await getDb()
    .collection("companies")
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray();

  res.json(companies);
}));

// GET /api/companies/admin/queue - Administrator verification queue with metrics
router.get("/admin/queue", requireAuth, requirePermission(PERMISSIONS.COMPANIES_REVIEW), asyncHandler(async (req, res) => {
  const { status = "all", industry, q, page = 1, limit = 20 } = req.query;
  const db = getDb();
  const pageNum = Math.max(1, Number(page) || 1);
  const pageLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * pageLimit;

  const filter = {};
  if (status && status !== "all") {
    filter.status = status;
  }
  if (industry) {
    filter.industry = industry;
  }
  if (q) {
    const searchRegex = new RegExp(q.trim(), "i");
    filter.$or = [
      { name: searchRegex },
      { location: searchRegex },
      { industry: searchRegex },
      { recruiterEmail: searchRegex },
    ];
  }

  const [companies, total, pendingCount, approvedCount, rejectedCount] = await Promise.all([
    db.collection("companies")
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageLimit)
      .toArray(),
    db.collection("companies").countDocuments(filter),
    db.collection("companies").countDocuments({ status: "pending" }),
    db.collection("companies").countDocuments({ status: "approved" }),
    db.collection("companies").countDocuments({ status: "rejected" }),
  ]);

  res.json({
    companies,
    total,
    page: pageNum,
    limit: pageLimit,
    totalPages: Math.ceil(total / pageLimit) || 1,
    counts: {
      pending: pendingCount,
      approved: approvedCount,
      rejected: rejectedCount,
      all: pendingCount + approvedCount + rejectedCount,
    },
  });
}));

// GET /api/companies/my-workspaces - List all company workspaces where user is owner or active member
router.get("/my-workspaces", requireAuth, asyncHandler(async (req, res) => {
  const userEmail = req.user.email.toLowerCase().trim();
  const db = getDb();

  // 1. Fetch active memberships
  const memberships = await getUserCompanyMemberships(userEmail);
  const membershipMap = new Map();
  memberships.forEach((m) => membershipMap.set(m.companyId, m));

  // 2. Fetch directly owned companies
  const ownedCompanies = await db.collection("companies")
    .find({ recruiterEmail: new RegExp(`^${userEmail}$`, "i") })
    .toArray();

  const allCompanyIds = new Set([
    ...memberships.map((m) => m.companyId),
    ...ownedCompanies.map((c) => c._id.toString()),
  ]);

  const companyObjectIds = [...allCompanyIds].map((id) => toObjectId(id)).filter(Boolean);
  const companies = await db.collection("companies")
    .find({ _id: { $in: companyObjectIds } })
    .sort({ createdAt: -1 })
    .toArray();

  const enriched = companies.map((comp) => {
    const compId = comp._id.toString();
    const membership = membershipMap.get(compId);
    const isDirectOwner = comp.recruiterEmail?.toLowerCase() === userEmail;

    const myRole = membership?.role || (isDirectOwner ? COMPANY_ROLES.OWNER : null);

    return {
      ...comp,
      myRole,
      membershipStatus: membership?.status || (isDirectOwner ? "active" : null),
    };
  });

  res.json({ workspaces: enriched });
}));

// GET /api/companies/:id - Public company profile
router.get("/:id", asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid company id");

  const company = await getDb().collection("companies").findOne({ _id });
  if (!company) return notFound(res, "Company not found");

  res.json(company);
}));

// POST /api/companies - Create company (Recruiter or Admin)
router.post("/", requireAuth, requireRole("recruiter", "admin"), asyncHandler(async (req, res) => {
  const required = ["name", "industry", "location"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const recruiterEmail = isAdmin && req.body.recruiterEmail ? req.body.recruiterEmail : req.user.email;

  const company = {
    ...req.body,
    recruiterEmail,
    status: isAdmin && req.body.status ? req.body.status : "pending",
    openJobs: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await getDb().collection("companies").insertOne(company);
  const companyId = result.insertedId.toString();

  // Automatically create company_owner membership record
  await getDb().collection("company_memberships").updateOne(
    { companyId, userEmail: recruiterEmail.toLowerCase().trim() },
    {
      $setOnInsert: {
        companyId,
        companyName: company.name,
        userEmail: recruiterEmail.toLowerCase().trim(),
        userName: req.user.name || "Company Owner",
        role: COMPANY_ROLES.OWNER,
        status: "active",
        invitedBy: "creator",
        createdAt: new Date(),
        updatedAt: new Date(),
        acceptedAt: new Date(),
      },
    },
    { upsert: true }
  );

  created(res, { ...company, _id: result.insertedId });
}));

// PATCH /api/companies/:id - Update company or approve standing
router.patch("/:id", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid company id");

  const db = getDb();
  const existingCompany = await db.collection("companies").findOne({ _id });
  if (!existingCompany) return notFound(res, "Company not found");

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const isOwner = existingCompany.recruiterEmail?.toLowerCase() === req.user.email?.toLowerCase();

  if (!isAdmin && !isOwner) {
    return res.status(403).json({
      message: "Forbidden: You do not have permission to edit this company.",
    });
  }

  const updateFields = { ...req.body };
  delete updateFields._id;

  // Company moderation status checks
  if (updateFields.status !== undefined) {
    if (!isAdmin || !hasPermission(req.user, PERMISSIONS.COMPANIES_WRITE)) {
      return res.status(403).json({
        message: "Forbidden: Insufficient permissions to modify company verification status.",
      });
    }

    // Rule: Recruiters cannot approve their own company submissions
    if (isOwner) {
      return res.status(403).json({
        message: "Forbidden: Administrators cannot moderate or approve their own registered company.",
      });
    }

    const allowedStatuses = ["pending", "approved", "rejected"];
    if (!allowedStatuses.includes(updateFields.status)) {
      return badRequest(res, `Invalid status. Allowed statuses: ${allowedStatuses.join(", ")}`);
    }

    // Require rejection reason if status is being set to rejected
    if (updateFields.status === "rejected" && !updateFields.rejectionReason) {
      return badRequest(res, "A rejection reason is required when rejecting company verification.");
    }

    updateFields.verifiedAt = new Date();
    updateFields.verifiedBy = req.user.email;
  }

  // Non-admins cannot transfer company ownership
  if (!isAdmin) {
    delete updateFields.recruiterEmail;
  }

  updateFields.updatedAt = new Date();

  const result = await db.collection("companies").findOneAndUpdate(
    { _id },
    { $set: updateFields },
    { returnDocument: "after" },
  );

  if (isAdmin && updateFields.status && updateFields.status !== existingCompany.status) {
    recordAuditLog({
      actor: req.user,
      action: "company_moderated",
      targetType: "company",
      targetId: existingCompany._id.toString(),
      targetIdentifier: existingCompany.name,
      before: { status: existingCompany.status },
      after: {
        status: updateFields.status,
        rejectionReason: updateFields.rejectionReason || null,
      },
    });
  }

  res.json(result);
}));

// GET /api/companies/:id/team - Get team members, pending invitations, and caller role
router.get("/:id/team", requireAuth, asyncHandler(async (req, res) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return badRequest(res, "Invalid company id");

  const access = await verifyCompanyAccess(req.user, req.params.id);
  if (!access.authorized) {
    return res.status(403).json({ message: `Forbidden: ${access.reason}` });
  }

  const db = getDb();
  const company = await db.collection("companies").findOne({ _id });
  if (!company) return notFound(res, "Company not found");

  const [members, pendingInvitations] = await Promise.all([
    listCompanyMembers(req.params.id),
    listCompanyInvitations(req.params.id),
  ]);

  res.json({
    company: {
      _id: company._id,
      name: company.name,
      status: company.status,
      recruiterEmail: company.recruiterEmail,
      logo: company.logo,
      industry: company.industry,
    },
    members,
    pendingInvitations,
    myRole: access.role,
  });
}));

// POST /api/companies/:id/team/invitations - Send team invitation
router.post("/:id/team/invitations", requireAuth, asyncHandler(async (req, res) => {
  const { inviteeEmail, role } = req.body;
  if (!inviteeEmail) return badRequest(res, "inviteeEmail is required.");
  if (!role) return badRequest(res, "role is required.");

  try {
    const result = await createTeamInvitation({
      companyId: req.params.id,
      inviterUser: req.user,
      inviteeEmail,
      role,
    });
    created(res, result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}));

// DELETE /api/companies/:id/team/invitations/:invitationId - Revoke invitation
router.delete("/:id/team/invitations/:invitationId", requireAuth, asyncHandler(async (req, res) => {
  try {
    const result = await revokeTeamInvitation({
      invitationId: req.params.invitationId,
      actorUser: req.user,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}));

// PATCH /api/companies/:id/team/members/:email/role - Change member role
router.patch("/:id/team/members/:email/role", requireAuth, asyncHandler(async (req, res) => {
  const { role } = req.body;
  if (!role) return badRequest(res, "role is required.");

  try {
    const result = await updateMemberRole({
      companyId: req.params.id,
      targetEmail: req.params.email,
      newRole: role,
      actorUser: req.user,
    });
    res.json({ member: result });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}));

// DELETE /api/companies/:id/team/members/:email - Remove member
router.delete("/:id/team/members/:email", requireAuth, asyncHandler(async (req, res) => {
  try {
    const result = await removeCompanyMember({
      companyId: req.params.id,
      targetEmail: req.params.email,
      actorUser: req.user,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}));

// POST /api/companies/:id/team/transfer-ownership - Transfer company ownership
router.post("/:id/team/transfer-ownership", requireAuth, asyncHandler(async (req, res) => {
  const { newOwnerEmail } = req.body;
  if (!newOwnerEmail) return badRequest(res, "newOwnerEmail is required.");

  try {
    const result = await transferCompanyOwnership({
      companyId: req.params.id,
      newOwnerEmail,
      actorUser: req.user,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}));

// GET /api/companies/:id/team/activity - Scoped activity logs
router.get("/:id/team/activity", requireAuth, asyncHandler(async (req, res) => {
  const access = await verifyCompanyAccess(req.user, req.params.id);
  if (!access.authorized) {
    return res.status(403).json({ message: `Forbidden: ${access.reason}` });
  }

  const { page, limit } = req.query;
  const result = await getCompanyActivityLogs({
    companyId: req.params.id,
    page,
    limit,
  });
  res.json(result);
}));

export default router;