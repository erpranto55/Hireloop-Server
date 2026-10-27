/**
 * Company Workspace & Recruiter Team Collaboration Service for HireLoop
 * Implements secure multi-user company workspaces, role-based authorization,
 * cryptographically secure team invitations, vacancy-level access control,
 * candidate review assignments, and company-scoped activity tracking.
 */

import crypto from "crypto";
import { getDb, toObjectId } from "../db.js";
import { recordAuditLog } from "./auditService.js";
import { queueTransactionalEmail } from "./emailService.js";
import { config } from "../config.js";

export const COMPANY_ROLES = Object.freeze({
  OWNER: "company_owner",
  HIRING_MANAGER: "hiring_manager",
  INTERVIEWER: "interviewer",
});

export const ALLOWED_COMPANY_ROLES = Object.values(COMPANY_ROLES);

export const COMPANY_ROLE_LABELS = Object.freeze({
  [COMPANY_ROLES.OWNER]: "Company Owner",
  [COMPANY_ROLES.HIRING_MANAGER]: "Hiring Manager",
  [COMPANY_ROLES.INTERVIEWER]: "Interviewer",
});

/**
 * Hash invitation tokens using SHA-256 for secure constant-time storage & lookup.
 */
export function hashInvitationToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Idempotently migrates existing verified or registered companies so that
 * their primary creator/recruiter is assigned an active `company_owner` membership.
 */
export async function migrateCompanyMemberships() {
  const db = getDb();
  const companies = await db.collection("companies").find({}).toArray();

  let migratedCount = 0;
  for (const company of companies) {
    if (!company.recruiterEmail) continue;

    const companyId = company._id.toString();
    const ownerEmail = company.recruiterEmail.toLowerCase().trim();

    const existingMembership = await db.collection("company_memberships").findOne({
      companyId,
      userEmail: ownerEmail,
    });

    if (!existingMembership) {
      const user = await db.collection("user").findOne({
        email: new RegExp(`^${ownerEmail}$`, "i"),
      });

      await db.collection("company_memberships").insertOne({
        companyId,
        companyName: company.name || "Company",
        userEmail: ownerEmail,
        userName: user?.name || "Company Owner",
        role: COMPANY_ROLES.OWNER,
        status: "active",
        invitedBy: "system_bootstrap",
        createdAt: company.createdAt || new Date(),
        updatedAt: new Date(),
        acceptedAt: company.createdAt || new Date(),
      });
      migratedCount++;
    }
  }

  return { totalCompanies: companies.length, migratedCount };
}

/**
 * Retrieves the active membership record for a given user email in a company.
 * Falls back to checking if the user is the company's authoritative creator if
 * membership record is pending sync.
 */
export async function getCompanyMembership(userEmail, companyId) {
  if (!userEmail || !companyId) return null;
  const db = getDb();
  const normalizedEmail = userEmail.toLowerCase().trim();
  const normalizedCompanyId = companyId.toString();

  const membership = await db.collection("company_memberships").findOne({
    companyId: normalizedCompanyId,
    userEmail: normalizedEmail,
    status: "active",
  });

  if (membership) return membership;

  // Check if user is the direct recruiterEmail owner of the company record
  const compObjectId = toObjectId(normalizedCompanyId);
  if (compObjectId) {
    const company = await db.collection("companies").findOne({ _id: compObjectId });
    if (company && company.recruiterEmail?.toLowerCase() === normalizedEmail) {
      // Auto-heal membership
      const user = await db.collection("user").findOne({ email: new RegExp(`^${normalizedEmail}$`, "i") });
      const newMembership = {
        companyId: normalizedCompanyId,
        companyName: company.name || "Company",
        userEmail: normalizedEmail,
        userName: user?.name || "Company Owner",
        role: COMPANY_ROLES.OWNER,
        status: "active",
        invitedBy: "system_autoheal",
        createdAt: new Date(),
        updatedAt: new Date(),
        acceptedAt: new Date(),
      };
      await db.collection("company_memberships").updateOne(
        { companyId: normalizedCompanyId, userEmail: normalizedEmail },
        { $setOnInsert: newMembership },
        { upsert: true }
      );
      return newMembership;
    }
  }

  return null;
}

/**
 * Retrieves all companies where the user has an active membership.
 */
export async function getUserCompanyMemberships(userEmail) {
  if (!userEmail) return [];
  const db = getDb();
  const normalizedEmail = userEmail.toLowerCase().trim();

  const memberships = await db.collection("company_memberships")
    .find({ userEmail: normalizedEmail, status: "active" })
    .toArray();

  return memberships;
}

/**
 * Verifies if a user has authorized company access and meets a minimum role requirement.
 */
export async function verifyCompanyAccess(user, companyId, requiredRole = null) {
  if (!user) return { authorized: false, reason: "Unauthenticated" };

  const isGlobalAdmin = (user.role || "").toLowerCase() === "admin";
  if (isGlobalAdmin) {
    return { authorized: true, role: "admin", membership: null };
  }

  if (user.status === "suspended") {
    return { authorized: false, reason: "Account is suspended" };
  }

  const membership = await getCompanyMembership(user.email, companyId);
  if (!membership) {
    return { authorized: false, reason: "Not a member of this company workspace" };
  }

  if (requiredRole) {
    if (requiredRole === COMPANY_ROLES.OWNER && membership.role !== COMPANY_ROLES.OWNER) {
      return { authorized: false, reason: "Requires Company Owner privileges" };
    }
    if (
      requiredRole === COMPANY_ROLES.HIRING_MANAGER &&
      membership.role !== COMPANY_ROLES.OWNER &&
      membership.role !== COMPANY_ROLES.HIRING_MANAGER
    ) {
      return { authorized: false, reason: "Requires Hiring Manager or Owner privileges" };
    }
  }

  return { authorized: true, role: membership.role, membership };
}

/**
 * Authorizes a user's action on a specific vacancy (job listing).
 * Capabilities:
 * - "view": Company owner, hiring manager, or explicitly assigned interviewer.
 * - "edit": Company owner, or hiring manager (if creator or assigned or general HM).
 * - "delete": Company owner only.
 * - "review_applications": Company owner, hiring manager, or assigned interviewer.
 * - "internal_notes": Company owner, hiring manager, or assigned interviewer.
 * - "manage_interviews": Company owner or hiring manager.
 * - "participate_interviews": Company owner, hiring manager, or assigned interviewer.
 * - "messaging": Company owner, hiring manager, or assigned interviewer.
 * - "assign_members": Company owner or hiring manager.
 */
export async function verifyVacancyAccess(user, job, capability = "view") {
  if (!user || !job) return { authorized: false, reason: "Missing user or job parameters" };

  const isGlobalAdmin = (user.role || "").toLowerCase() === "admin";
  if (isGlobalAdmin) return { authorized: true, role: "admin" };

  if (user.status === "suspended") {
    return { authorized: false, reason: "Account is suspended" };
  }

  const userEmail = user.email.toLowerCase().trim();
  const companyId = job.companyId?.toString();

  const isCreator = job.recruiterEmail?.toLowerCase() === userEmail;

  let companyRole = user.companyRole;
  if (!companyRole) {
    if (isCreator) {
      companyRole = COMPANY_ROLES.OWNER;
    } else if (!companyId) {
      return { authorized: false, reason: "Not authorized for this legacy job" };
    } else {
      const access = await verifyCompanyAccess(user, companyId);
      if (!access.authorized) {
        return access;
      }
      companyRole = access.role;
    }
  }
  const isAssigned = Array.isArray(job.assignedMemberEmails) &&
    job.assignedMemberEmails.some((e) => e.toLowerCase() === userEmail);

  // 1. Company Owner has comprehensive access
  if (companyRole === COMPANY_ROLES.OWNER) {
    return { authorized: true, role: COMPANY_ROLES.OWNER };
  }

  // 2. Hiring Manager capabilities
  if (companyRole === COMPANY_ROLES.HIRING_MANAGER) {
    if (capability === "delete") {
      // Only company owner or creator can delete a vacancy
      if (!isCreator) {
        return { authorized: false, reason: "Only the company owner or job creator can delete a vacancy." };
      }
    }
    return { authorized: true, role: COMPANY_ROLES.HIRING_MANAGER };
  }

  // 3. Interviewer capabilities (strict least-privilege)
  if (companyRole === COMPANY_ROLES.INTERVIEWER) {
    const readOrParticipateCaps = [
      "view",
      "review_applications",
      "internal_notes",
      "participate_interviews",
      "messaging",
    ];

    if (!readOrParticipateCaps.includes(capability)) {
      return {
        authorized: false,
        reason: `Interviewers cannot perform '${capability}' operations.`,
      };
    }

    // Interviewer MUST be explicitly assigned to the vacancy (or assigned as a reviewer)
    if (!isAssigned && !isCreator) {
      return {
        authorized: false,
        reason: "Interviewers can only access vacancies they are explicitly assigned to.",
      };
    }

    return { authorized: true, role: COMPANY_ROLES.INTERVIEWER };
  }

  return { authorized: false, reason: "Insufficient company role privileges" };
}

/**
 * Creates and queues a secure, cryptographically random team invitation.
 */
export async function createTeamInvitation({ companyId, inviterUser, inviteeEmail, role }) {
  const db = getDb();
  const normalizedEmail = inviteeEmail.toLowerCase().trim();
  const normalizedCompanyId = companyId.toString();

  // Validate company existence and verification standing
  const compObjectId = toObjectId(normalizedCompanyId);
  if (!compObjectId) throw new Error("Invalid company ID");

  const company = await db.collection("companies").findOne({ _id: compObjectId });
  if (!company) throw new Error("Company not found");

  if (company.status === "rejected") {
    throw new Error("Cannot invite team members to a rejected company profile.");
  }

  // Validate inviter authorization (must be owner or hiring manager)
  const isGlobalAdmin = (inviterUser.role || "").toLowerCase() === "admin";
  if (!isGlobalAdmin) {
    const inviterAccess = await verifyCompanyAccess(inviterUser, normalizedCompanyId, COMPANY_ROLES.HIRING_MANAGER);
    if (!inviterAccess.authorized) {
      throw new Error("Forbidden: You must be a Company Owner or Hiring Manager to invite team members.");
    }
    // Only owner can invite another owner
    if (role === COMPANY_ROLES.OWNER && inviterAccess.role !== COMPANY_ROLES.OWNER) {
      throw new Error("Forbidden: Only an existing Company Owner can invite another owner.");
    }
  }

  // Validate proposed role against allowlist
  if (!ALLOWED_COMPANY_ROLES.includes(role)) {
    throw new Error(`Invalid role '${role}'. Allowed roles: ${ALLOWED_COMPANY_ROLES.join(", ")}`);
  }

  // Check if already an active member of this company
  const existingMember = await db.collection("company_memberships").findOne({
    companyId: normalizedCompanyId,
    userEmail: normalizedEmail,
    status: "active",
  });
  if (existingMember) {
    throw new Error("This user is already an active member of this company workspace.");
  }

  // Check for duplicate pending invitation
  const existingPending = await db.collection("company_invitations").findOne({
    companyId: normalizedCompanyId,
    inviteeEmail: normalizedEmail,
    status: "pending",
    expiresAt: { $gt: new Date() },
  });
  if (existingPending) {
    throw new Error("An active pending invitation has already been sent to this email address.");
  }

  // Generate cryptographically random token & its SHA-256 hash
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashInvitationToken(rawToken);
  const expiresInDays = 7;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const invitationDoc = {
    companyId: normalizedCompanyId,
    companyName: company.name,
    inviteeEmail: normalizedEmail,
    inviterEmail: inviterUser.email.toLowerCase().trim(),
    inviterName: inviterUser.name || "A team member",
    role,
    tokenHash,
    status: "pending",
    expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.collection("company_invitations").insertOne(invitationDoc);

  // Queue transactional email
  const clientUrl = config.clientOrigin || "http://localhost:3000";
  const inviteUrl = `${clientUrl}/dashboard/recruiter/team/accept?token=${rawToken}`;

  await queueTransactionalEmail({
    to: normalizedEmail,
    type: "companyTeamInvitation",
    templateData: {
      companyName: company.name,
      inviterName: inviterUser.name || inviterUser.email,
      roleName: COMPANY_ROLE_LABELS[role] || role,
      inviteUrl,
      expiresInDays,
    },
    idempotencyKey: `invite_${result.insertedId}_${Date.now()}`,
  }).catch((err) => {
    console.error("[CompanyWorkspace] Invitation email delivery warning:", err.message);
  });

  // Record audit log
  recordAuditLog({
    actor: inviterUser,
    action: "company.invitation_created",
    targetType: "company_invitation",
    targetId: result.insertedId.toString(),
    targetIdentifier: `${normalizedEmail} -> ${company.name}`,
    companyId: normalizedCompanyId,
    after: {
      inviteeEmail: normalizedEmail,
      role,
      expiresAt,
    },
  });

  return {
    invitation: { ...invitationDoc, _id: result.insertedId },
    rawToken, // Returned only once during generation for testing / links
  };
}

/**
 * Safely previews invitation details without accepting it.
 */
export async function getInvitationByToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string") return null;
  const db = getDb();
  const tokenHash = hashInvitationToken(rawToken.trim());

  const invitation = await db.collection("company_invitations").findOne({
    tokenHash,
    status: "pending",
    expiresAt: { $gt: new Date() },
  });

  if (!invitation) return null;

  return {
    _id: invitation._id.toString(),
    companyId: invitation.companyId,
    companyName: invitation.companyName,
    inviteeEmail: invitation.inviteeEmail,
    inviterName: invitation.inviterName,
    role: invitation.role,
    roleLabel: COMPANY_ROLE_LABELS[invitation.role] || invitation.role,
    expiresAt: invitation.expiresAt,
  };
}

/**
 * Accepts a team invitation, activating membership in the company workspace.
 */
export async function acceptTeamInvitation({ rawToken, authenticatedUser }) {
  if (!rawToken) throw new Error("Invitation token is required.");
  if (!authenticatedUser) throw new Error("Authentication is required to accept an invitation.");

  const db = getDb();
  const tokenHash = hashInvitationToken(rawToken.trim());
  const userEmail = authenticatedUser.email.toLowerCase().trim();

  // Find valid pending invitation
  const invitation = await db.collection("company_invitations").findOne({
    tokenHash,
    status: "pending",
  });

  if (!invitation) {
    throw new Error("Invalid or already accepted invitation token.");
  }

  if (new Date() > new Date(invitation.expiresAt)) {
    await db.collection("company_invitations").updateOne(
      { _id: invitation._id },
      { $set: { status: "expired", updatedAt: new Date() } }
    );
    throw new Error("This invitation has expired. Please request a new invitation.");
  }

  // Verify that the authenticated account email matches the intended invitee email
  if (invitation.inviteeEmail.toLowerCase() !== userEmail) {
    throw new Error(
      `This invitation was issued to ${invitation.inviteeEmail}. You are currently logged in as ${userEmail}. Please sign in with the invited email address.`
    );
  }

  // Ensure user account is not suspended
  if (authenticatedUser.status === "suspended") {
    throw new Error("Suspended accounts cannot accept workspace invitations.");
  }

  // Fetch company
  const compObjectId = toObjectId(invitation.companyId);
  const company = compObjectId
    ? await db.collection("companies").findOne({ _id: compObjectId })
    : null;

  if (!company) {
    throw new Error("The associated company profile no longer exists.");
  }

  const now = new Date();

  // Upsert active membership record
  const membershipDoc = {
    companyId: invitation.companyId,
    companyName: company.name,
    userEmail,
    userName: authenticatedUser.name || "Team Member",
    role: invitation.role, // Role assigned by inviter, immutable by invitee
    status: "active",
    invitedBy: invitation.inviterEmail,
    createdAt: now,
    updatedAt: now,
    acceptedAt: now,
  };

  await db.collection("company_memberships").updateOne(
    { companyId: invitation.companyId, userEmail },
    { $set: membershipDoc },
    { upsert: true }
  );

  // Mark invitation as accepted
  await db.collection("company_invitations").updateOne(
    { _id: invitation._id },
    {
      $set: {
        status: "accepted",
        acceptedByEmail: userEmail,
        acceptedAt: now,
        updatedAt: now,
      },
    }
  );

  // If user role was seeker, promote or ensure they have recruiter access
  if ((authenticatedUser.role || "").toLowerCase() === "seeker") {
    await db.collection("user").updateOne(
      { email: new RegExp(`^${userEmail}$`, "i") },
      { $set: { role: "recruiter", updatedAt: now } }
    );
  }

  // Record audit log
  recordAuditLog({
    actor: authenticatedUser,
    action: "company.invitation_accepted",
    targetType: "company_membership",
    targetId: `${invitation.companyId}:${userEmail}`,
    targetIdentifier: `${userEmail} joined ${company.name} as ${invitation.role}`,
    companyId: invitation.companyId,
    after: {
      role: invitation.role,
      acceptedAt: now,
    },
  });

  return {
    success: true,
    companyId: invitation.companyId,
    companyName: company.name,
    role: invitation.role,
  };
}

/**
 * Revokes an unexpired pending invitation.
 */
export async function revokeTeamInvitation({ invitationId, actorUser }) {
  const _id = toObjectId(invitationId);
  if (!_id) throw new Error("Invalid invitation ID.");

  const db = getDb();
  const invitation = await db.collection("company_invitations").findOne({ _id });
  if (!invitation) throw new Error("Invitation not found.");

  if (invitation.status !== "pending") {
    throw new Error(`Cannot revoke invitation with status '${invitation.status}'.`);
  }

  // Verify actor permission (must be owner, or hiring manager who sent it, or admin)
  const isGlobalAdmin = (actorUser.role || "").toLowerCase() === "admin";
  if (!isGlobalAdmin) {
    const access = await verifyCompanyAccess(actorUser, invitation.companyId, COMPANY_ROLES.HIRING_MANAGER);
    if (!access.authorized) throw new Error("Forbidden: Insufficient workspace permissions.");

    if (access.role !== COMPANY_ROLES.OWNER && invitation.inviterEmail !== actorUser.email.toLowerCase()) {
      throw new Error("Forbidden: Only a Company Owner can revoke invitations issued by other members.");
    }
  }

  await db.collection("company_invitations").updateOne(
    { _id },
    {
      $set: {
        status: "revoked",
        revokedBy: actorUser.email.toLowerCase(),
        revokedAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );

  recordAuditLog({
    actor: actorUser,
    action: "company.invitation_revoked",
    targetType: "company_invitation",
    targetId: _id.toString(),
    targetIdentifier: `${invitation.inviteeEmail} (${invitation.companyName})`,
    companyId: invitation.companyId,
    before: { status: "pending" },
    after: { status: "revoked" },
  });

  return { success: true };
}

/**
 * Lists all active team members for a company workspace.
 */
export async function listCompanyMembers(companyId) {
  const db = getDb();
  const normalizedCompanyId = companyId.toString();

  const members = await db.collection("company_memberships")
    .find({ companyId: normalizedCompanyId, status: "active" })
    .sort({ createdAt: 1 })
    .toArray();

  return members;
}

/**
 * Lists pending invitations for a company workspace.
 */
export async function listCompanyInvitations(companyId) {
  const db = getDb();
  const normalizedCompanyId = companyId.toString();

  const invitations = await db.collection("company_invitations")
    .find({
      companyId: normalizedCompanyId,
      status: "pending",
      expiresAt: { $gt: new Date() },
    })
    .sort({ createdAt: -1 })
    .toArray();

  return invitations.map((inv) => {
    const sanitized = { ...inv };
    delete sanitized.tokenHash; // Never leak token hashes to client
    return sanitized;
  });
}

/**
 * Updates a company member's role with strict Last-Owner protection.
 */
export async function updateMemberRole({ companyId, targetEmail, newRole, actorUser }) {
  const normalizedEmail = targetEmail.toLowerCase().trim();
  const normalizedCompanyId = companyId.toString();

  if (!ALLOWED_COMPANY_ROLES.includes(newRole)) {
    throw new Error(`Invalid role '${newRole}'. Allowed: ${ALLOWED_COMPANY_ROLES.join(", ")}`);
  }

  // Authorization check: Only company owners or global admins can change roles
  const isGlobalAdmin = (actorUser.role || "").toLowerCase() === "admin";
  if (!isGlobalAdmin) {
    const access = await verifyCompanyAccess(actorUser, normalizedCompanyId, COMPANY_ROLES.OWNER);
    if (!access.authorized) {
      throw new Error("Forbidden: Only a Company Owner can change member roles.");
    }
  }

  const db = getDb();
  const targetMember = await db.collection("company_memberships").findOne({
    companyId: normalizedCompanyId,
    userEmail: normalizedEmail,
    status: "active",
  });

  if (!targetMember) {
    throw new Error("Active membership not found for this user in this workspace.");
  }

  if (targetMember.role === newRole) {
    return targetMember;
  }

  // LAST OWNER LOCKOUT SAFEGUARD:
  // If demoting an owner to a non-owner role, verify at least one other active owner exists!
  if (targetMember.role === COMPANY_ROLES.OWNER && newRole !== COMPANY_ROLES.OWNER) {
    const activeOwnerCount = await db.collection("company_memberships").countDocuments({
      companyId: normalizedCompanyId,
      role: COMPANY_ROLES.OWNER,
      status: "active",
    });

    if (activeOwnerCount <= 1) {
      throw new Error(
        "Cannot demote the company's only active owner. Please assign another member as Company Owner first."
      );
    }
  }

  const now = new Date();
  const result = await db.collection("company_memberships").findOneAndUpdate(
    { companyId: normalizedCompanyId, userEmail: normalizedEmail },
    {
      $set: {
        role: newRole,
        updatedAt: now,
      },
    },
    { returnDocument: "after" }
  );

  recordAuditLog({
    actor: actorUser,
    action: "company.member_role_updated",
    targetType: "company_membership",
    targetId: `${normalizedCompanyId}:${normalizedEmail}`,
    targetIdentifier: `${normalizedEmail} role changed to ${newRole}`,
    companyId: normalizedCompanyId,
    before: { role: targetMember.role },
    after: { role: newRole },
  });

  return result;
}

/**
 * Removes a member from a company workspace with strict Last-Owner protection.
 */
export async function removeCompanyMember({ companyId, targetEmail, actorUser }) {
  const normalizedEmail = targetEmail.toLowerCase().trim();
  const normalizedCompanyId = companyId.toString();
  const actorEmail = actorUser.email.toLowerCase().trim();

  const isGlobalAdmin = (actorUser.role || "").toLowerCase() === "admin";
  const isSelf = actorEmail === normalizedEmail;

  if (!isGlobalAdmin && !isSelf) {
    const access = await verifyCompanyAccess(actorUser, normalizedCompanyId, COMPANY_ROLES.OWNER);
    if (!access.authorized) {
      throw new Error("Forbidden: Only a Company Owner can remove other members.");
    }
  }

  const db = getDb();
  const targetMember = await db.collection("company_memberships").findOne({
    companyId: normalizedCompanyId,
    userEmail: normalizedEmail,
    status: "active",
  });

  if (!targetMember) {
    throw new Error("Active membership not found for this user in this workspace.");
  }

  // LAST OWNER LOCKOUT SAFEGUARD:
  if (targetMember.role === COMPANY_ROLES.OWNER) {
    const activeOwnerCount = await db.collection("company_memberships").countDocuments({
      companyId: normalizedCompanyId,
      role: COMPANY_ROLES.OWNER,
      status: "active",
    });

    if (activeOwnerCount <= 1) {
      throw new Error(
        "Cannot remove the company's only active owner. Please transfer ownership to another member before leaving."
      );
    }
  }

  // Revoke membership (soft delete / status change preserves historical integrity)
  const now = new Date();
  await db.collection("company_memberships").updateOne(
    { companyId: normalizedCompanyId, userEmail: normalizedEmail },
    {
      $set: {
        status: "revoked",
        revokedAt: now,
        revokedBy: actorEmail,
        updatedAt: now,
      },
    }
  );

  // Unassign member from active vacancy assignments
  await db.collection("jobs").updateMany(
    { companyId: normalizedCompanyId, assignedMemberEmails: normalizedEmail },
    { $pull: { assignedMemberEmails: normalizedEmail } }
  );

  recordAuditLog({
    actor: actorUser,
    action: "company.member_removed",
    targetType: "company_membership",
    targetId: `${normalizedCompanyId}:${normalizedEmail}`,
    targetIdentifier: `${normalizedEmail} removed from workspace`,
    companyId: normalizedCompanyId,
    before: { role: targetMember.role, status: "active" },
    after: { status: "revoked" },
  });

  return { success: true };
}

/**
 * Transfers primary company ownership to another active team member.
 */
export async function transferCompanyOwnership({ companyId, newOwnerEmail, actorUser }) {
  const normalizedCompanyId = companyId.toString();
  const targetEmail = newOwnerEmail.toLowerCase().trim();
  const actorEmail = actorUser.email.toLowerCase().trim();

  const isGlobalAdmin = (actorUser.role || "").toLowerCase() === "admin";
  if (!isGlobalAdmin) {
    const access = await verifyCompanyAccess(actorUser, normalizedCompanyId, COMPANY_ROLES.OWNER);
    if (!access.authorized) {
      throw new Error("Forbidden: Only the current Company Owner can transfer ownership.");
    }
  }

  const db = getDb();
  const compObjectId = toObjectId(normalizedCompanyId);
  const company = compObjectId ? await db.collection("companies").findOne({ _id: compObjectId }) : null;
  if (!company) throw new Error("Company not found.");

  // Target must be an active member of this company
  const targetMember = await db.collection("company_memberships").findOne({
    companyId: normalizedCompanyId,
    userEmail: targetEmail,
    status: "active",
  });

  if (!targetMember) {
    throw new Error("Target user must be an active member of this company workspace before receiving ownership.");
  }

  const now = new Date();

  // 1. Promote target member to Company Owner
  await db.collection("company_memberships").updateOne(
    { companyId: normalizedCompanyId, userEmail: targetEmail },
    { $set: { role: COMPANY_ROLES.OWNER, updatedAt: now } }
  );

  // 2. Update company primary recruiterEmail field
  await db.collection("companies").updateOne(
    { _id: compObjectId },
    {
      $set: {
        recruiterEmail: targetEmail,
        updatedAt: now,
      },
      $push: {
        ownershipHistory: {
          from: company.recruiterEmail || actorEmail,
          to: targetEmail,
          transferredBy: actorEmail,
          transferredAt: now,
        },
      },
    }
  );

  recordAuditLog({
    actor: actorUser,
    action: "company.ownership_transferred",
    targetType: "company",
    targetId: normalizedCompanyId,
    targetIdentifier: `${company.name} ownership -> ${targetEmail}`,
    companyId: normalizedCompanyId,
    before: { ownerEmail: company.recruiterEmail },
    after: { ownerEmail: targetEmail },
  });

  return { success: true, newOwner: targetEmail };
}

/**
 * Assigns or unassigns team members to a specific vacancy.
 */
export async function assignVacancyMembers({ jobId, memberEmails = [], actorUser }) {
  const db = getDb();
  const jobObjectId = toObjectId(jobId);
  if (!jobObjectId) throw new Error("Invalid job ID.");

  const job = await db.collection("jobs").findOne({ _id: jobObjectId });
  if (!job) throw new Error("Job listing not found.");

  const companyId = job.companyId?.toString();
  if (!companyId) throw new Error("Job does not have an associated company workspace.");

  // Verify actor has permission to assign members on this vacancy
  const access = await verifyVacancyAccess(actorUser, job, "assign_members");
  if (!access.authorized) {
    throw new Error(`Forbidden: ${access.reason}`);
  }

  const normalizedEmails = [...new Set(memberEmails.map((e) => e.toLowerCase().trim()).filter(Boolean))];

  // Validate that all assigned members are active members of this company workspace
  if (normalizedEmails.length > 0) {
    const activeMembers = await db.collection("company_memberships")
      .find({
        companyId,
        userEmail: { $in: normalizedEmails },
        status: "active",
      })
      .toArray();

    const activeMemberEmails = new Set(activeMembers.map((m) => m.userEmail.toLowerCase()));
    const unverified = normalizedEmails.filter((e) => !activeMemberEmails.has(e));

    if (unverified.length > 0) {
      throw new Error(
        `The following users are not active members of this company workspace: ${unverified.join(", ")}`
      );
    }
  }

  const now = new Date();
  await db.collection("jobs").updateOne(
    { _id: jobObjectId },
    {
      $set: {
        assignedMemberEmails: normalizedEmails,
        updatedAt: now,
      },
    }
  );

  recordAuditLog({
    actor: actorUser,
    action: "company.vacancy_assigned",
    targetType: "job",
    targetId: jobObjectId.toString(),
    targetIdentifier: `${job.title} assigned to ${normalizedEmails.length} member(s)`,
    companyId,
    before: { assignedMemberEmails: job.assignedMemberEmails || [] },
    after: { assignedMemberEmails: normalizedEmails },
  });

  return { success: true, assignedMemberEmails: normalizedEmails };
}

/**
 * Assigns a candidate review to a specific team member.
 */
export async function assignCandidateReview({ applicationId, reviewerEmail, actorUser }) {
  const db = getDb();
  const appObjectId = toObjectId(applicationId);
  if (!appObjectId) throw new Error("Invalid application ID.");

  const application = await db.collection("applications").findOne({ _id: appObjectId });
  if (!application) throw new Error("Application not found.");

  const jobObjectId = toObjectId(application.jobId);
  const job = jobObjectId ? await db.collection("jobs").findOne({ _id: jobObjectId }) : null;

  const companyId = application.companyId || job?.companyId;
  if (!companyId) throw new Error("Application does not belong to a company workspace.");

  // Verify actor has review assignment permissions
  if (job) {
    const access = await verifyVacancyAccess(actorUser, job, "assign_members");
    if (!access.authorized) {
      throw new Error(`Forbidden: ${access.reason}`);
    }
  }

  const normalizedReviewerEmail = reviewerEmail ? reviewerEmail.toLowerCase().trim() : null;

  let reviewerName = null;
  if (normalizedReviewerEmail) {
    const membership = await getCompanyMembership(normalizedReviewerEmail, companyId);
    if (!membership) {
      throw new Error("Assigned reviewer must be an active member of this company workspace.");
    }
    reviewerName = membership.userName || normalizedReviewerEmail;
  }

  const now = new Date();
  const updatePayload = normalizedReviewerEmail
    ? {
        assignedReviewerEmail: normalizedReviewerEmail,
        assignedReviewerName: reviewerName,
        assignedByEmail: actorUser.email.toLowerCase().trim(),
        assignedAt: now,
        reviewStatus: application.reviewStatus || "pending_review",
        updatedAt: now,
      }
    : {
        assignedReviewerEmail: null,
        assignedReviewerName: null,
        assignedByEmail: null,
        assignedAt: null,
        updatedAt: now,
      };

  await db.collection("applications").updateOne(
    { _id: appObjectId },
    { $set: updatePayload }
  );

  recordAuditLog({
    actor: actorUser,
    action: "company.candidate_review_assigned",
    targetType: "application",
    targetId: appObjectId.toString(),
    targetIdentifier: `${application.seekerName || application.seekerEmail} -> ${normalizedReviewerEmail || "Unassigned"}`,
    companyId: companyId.toString(),
    before: { assignedReviewerEmail: application.assignedReviewerEmail || null },
    after: { assignedReviewerEmail: normalizedReviewerEmail },
  });

  return { success: true, ...updatePayload };
}

/**
 * Returns company-scoped activity history without leaking global compliance logs.
 */
export async function getCompanyActivityLogs({ companyId, limit = 20, page = 1 }) {
  const db = getDb();
  const normalizedCompanyId = companyId.toString();
  const pageNum = Math.max(1, Number(page) || 1);
  const pageLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * pageLimit;

  const filter = {
    $or: [
      { companyId: normalizedCompanyId },
      { "before.companyId": normalizedCompanyId },
      { "after.companyId": normalizedCompanyId },
      { targetType: "company", targetId: normalizedCompanyId },
    ],
  };

  const [logs, total] = await Promise.all([
    db.collection("audit_logs")
      .find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(pageLimit)
      .toArray(),
    db.collection("audit_logs").countDocuments(filter),
  ]);

  // Sanitize audit records (strip raw tokens, passwords, sensitive internal IPs)
  const sanitized = logs.map((log) => ({
    _id: log._id.toString(),
    action: log.action,
    actorEmail: log.actorEmail,
    actorName: log.actorName,
    targetType: log.targetType,
    targetIdentifier: log.targetIdentifier,
    timestamp: log.timestamp,
    safeDetails: {
      before: log.before,
      after: log.after,
    },
  }));

  return {
    activity: sanitized,
    total,
    page: pageNum,
    limit: pageLimit,
    totalPages: Math.ceil(total / pageLimit) || 1,
  };
}
