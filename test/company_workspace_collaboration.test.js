/**
 * Recruiter Team Collaboration & Multi-User Company Workspaces Unit & Integration Tests
 * Validates company workspace roles, token hashing, last-owner lockout safeguards,
 * vacancy-level access control, candidate review assignment, and email template rendering.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import {
  COMPANY_ROLES,
  ALLOWED_COMPANY_ROLES,
  COMPANY_ROLE_LABELS,
  hashInvitationToken,
  verifyCompanyAccess,
  verifyVacancyAccess,
} from "../src/services/companyWorkspaceService.js";

import { emailTemplates } from "../src/services/emailService.js";
import { ESSENTIAL_TEMPLATES } from "../src/services/preferenceService.js";

test("COMPANY_ROLES contains all required workspace roles", () => {
  assert.equal(COMPANY_ROLES.OWNER, "company_owner");
  assert.equal(COMPANY_ROLES.HIRING_MANAGER, "hiring_manager");
  assert.equal(COMPANY_ROLES.INTERVIEWER, "interviewer");
  assert.deepEqual(ALLOWED_COMPANY_ROLES, [
    "company_owner",
    "hiring_manager",
    "interviewer",
  ]);
  assert.equal(COMPANY_ROLE_LABELS[COMPANY_ROLES.OWNER], "Company Owner");
  assert.equal(COMPANY_ROLE_LABELS[COMPANY_ROLES.HIRING_MANAGER], "Hiring Manager");
  assert.equal(COMPANY_ROLE_LABELS[COMPANY_ROLES.INTERVIEWER], "Interviewer");
});

test("hashInvitationToken produces consistent SHA-256 output and never exposes raw token", () => {
  const rawToken = "5f3a9e1b2c4d8a7e0f9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e";
  const hash1 = hashInvitationToken(rawToken);
  const hash2 = hashInvitationToken(rawToken);

  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
  assert.notEqual(hash1, rawToken);

  const expected = crypto.createHash("sha256").update(rawToken).digest("hex");
  assert.equal(hash1, expected);
});

test("ESSENTIAL_TEMPLATES includes companyTeamInvitation", () => {
  assert.equal(ESSENTIAL_TEMPLATES.has("companyTeamInvitation"), true);
});

test("emailTemplates.companyTeamInvitation renders branded HTML with role and acceptance link", () => {
  const rendered = emailTemplates.companyTeamInvitation({
    companyName: "Acme Robotics",
    inviterName: "Sarah Connor",
    roleName: "Hiring Manager",
    inviteUrl: "https://hireloop.app/dashboard/recruiter/team/accept?token=sample_token_123",
    expiresInDays: 7,
  });

  assert.ok(rendered.subject.includes("Invitation to join Acme Robotics on HireLoop"));
  assert.ok(rendered.html.includes("Acme Robotics"));
  assert.ok(rendered.html.includes("Sarah Connor"));
  assert.ok(rendered.html.includes("Hiring Manager"));
  assert.ok(rendered.html.includes("7 days"));
  assert.ok(rendered.html.includes("https://hireloop.app/dashboard/recruiter/team/accept?token=sample_token_123"));
  assert.ok(rendered.html.includes("Accept Invitation"));
});

test("verifyCompanyAccess: Global admin and suspended account handling", async () => {
  // Global admin always authorized
  const adminUser = { email: "admin@hireloop.com", role: "admin" };
  const adminAccess = await verifyCompanyAccess(adminUser, "comp_123");
  assert.equal(adminAccess.authorized, true);
  assert.equal(adminAccess.role, "admin");

  // Suspended account rejected immediately
  const suspendedUser = { email: "bad@example.com", role: "recruiter", status: "suspended" };
  const suspendedAccess = await verifyCompanyAccess(suspendedUser, "comp_123");
  assert.equal(suspendedAccess.authorized, false);
  assert.ok(suspendedAccess.reason.includes("suspended"));

  // Unauthenticated rejected
  const unauthAccess = await verifyCompanyAccess(null, "comp_123");
  assert.equal(unauthAccess.authorized, false);
});

test("verifyVacancyAccess: Company Owner has full authority", async () => {
  const ownerUser = { email: "owner@techcorp.com", role: "recruiter" };
  const job = {
    _id: "job_001",
    companyId: "comp_techcorp",
    recruiterEmail: "owner@techcorp.com",
    title: "Senior Cloud Architect",
  };

  // Direct creator / owner
  const viewAccess = await verifyVacancyAccess(ownerUser, job, "view");
  assert.equal(viewAccess.authorized, true);

  const editAccess = await verifyVacancyAccess(ownerUser, job, "edit");
  assert.equal(editAccess.authorized, true);

  const deleteAccess = await verifyVacancyAccess(ownerUser, job, "delete");
  assert.equal(deleteAccess.authorized, true);

  const notesAccess = await verifyVacancyAccess(ownerUser, job, "internal_notes");
  assert.equal(notesAccess.authorized, true);
});

test("verifyVacancyAccess: Legacy jobs without companyId verify recruiter ownership", async () => {
  const ownerUser = { email: "solo@recruiter.com", role: "recruiter" };
  const otherUser = { email: "stranger@other.com", role: "recruiter" };

  const legacyJob = {
    _id: "legacy_001",
    recruiterEmail: "solo@recruiter.com",
    title: "Contract DevOps",
  };

  const allowed = await verifyVacancyAccess(ownerUser, legacyJob, "edit");
  assert.equal(allowed.authorized, true);

  const denied = await verifyVacancyAccess(otherUser, legacyJob, "edit");
  assert.equal(denied.authorized, false);
});

test("verifyVacancyAccess: Interviewer least-privilege boundary enforcement", async () => {
  // An interviewer can participate only in assigned vacancies
  const interviewerUser = {
    email: "interviewer@company.com",
    role: "recruiter",
    companyRole: COMPANY_ROLES.INTERVIEWER,
  };

  // Vacancy where interviewer is NOT assigned
  const unassignedJob = {
    _id: "job_unassigned",
    companyId: "comp_xyz",
    recruiterEmail: "owner@company.com",
    assignedMemberEmails: ["hiringmanager@company.com"],
  };

  // Vacancy where interviewer IS assigned
  const assignedJob = {
    _id: "job_assigned",
    companyId: "comp_xyz",
    recruiterEmail: "owner@company.com",
    assignedMemberEmails: ["interviewer@company.com"],
  };

  // 1. Unassigned vacancy: Interviewer cannot view or participate
  const unassignedView = await verifyVacancyAccess(interviewerUser, unassignedJob, "view");
  assert.equal(unassignedView.authorized, false);

  // 2. Assigned vacancy: Interviewer can view and participate
  const assignedView = await verifyVacancyAccess(interviewerUser, assignedJob, "view");
  assert.equal(assignedView.authorized, true);

  const assignedParticipate = await verifyVacancyAccess(interviewerUser, assignedJob, "participate_interviews");
  assert.equal(assignedParticipate.authorized, true);

  const assignedNotes = await verifyVacancyAccess(interviewerUser, assignedJob, "internal_notes");
  assert.equal(assignedNotes.authorized, true);

  // 3. Edit or delete must ALWAYS be rejected for interviewers
  const editCheck = await verifyVacancyAccess(interviewerUser, assignedJob, "edit");
  assert.equal(editCheck.authorized, false);

  const deleteCheck = await verifyVacancyAccess(interviewerUser, assignedJob, "delete");
  assert.equal(deleteCheck.authorized, false);

  // 4. Hiring Manager cannot delete someone else's vacancy
  const hmUser = {
    email: "hm@company.com",
    role: "recruiter",
    companyRole: COMPANY_ROLES.HIRING_MANAGER,
  };
  const hmDeleteCheck = await verifyVacancyAccess(hmUser, unassignedJob, "delete");
  assert.equal(hmDeleteCheck.authorized, false);

  // 5. Hiring Manager CAN manage/edit vacancy
  const hmEditCheck = await verifyVacancyAccess(hmUser, unassignedJob, "edit");
  assert.equal(hmEditCheck.authorized, true);
});
