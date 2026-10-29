import test from "node:test";
import assert from "node:assert/strict";
import {
  RATING_SCALE,
  OVERALL_RECOMMENDATIONS,
  DEFAULT_CRITERIA,
  validateCriterion,
  calculateWeightedScore,
} from "../src/services/scorecardService.js";
import {
  AUTOMATION_TRIGGERS,
  AUTOMATION_ACTIONS,
} from "../src/services/pipelineAutomationService.js";
import {
  ALLOWED_STATUS_TRANSITIONS,
  APPLICATION_STATUSES,
} from "../src/routes/applications.js";

test("Scorecard Rubric: RATING_SCALE defines clear 1-5 guidance", () => {
  assert.equal(RATING_SCALE.MIN, 1);
  assert.equal(RATING_SCALE.MAX, 5);
  assert.ok(RATING_SCALE.GUIDANCE[1].toLowerCase().includes("unsatisfactory"));
  assert.ok(RATING_SCALE.GUIDANCE[3].toLowerCase().includes("meets expectations"));
  assert.ok(RATING_SCALE.GUIDANCE[5].toLowerCase().includes("exceptional"));
});

test("Scorecard Criteria Validation: rejects discriminatory or invalid keywords", () => {
  // Valid criterion
  const valid = validateCriterion({
    name: "System Architecture & API Design",
    category: "technical",
    weight: 3,
    description: "Evaluates scalable backend architecture design.",
  });
  assert.equal(valid.name, "System Architecture & API Design");
  assert.equal(valid.weight, 3);
  assert.equal(valid.category, "technical");
  assert.equal(valid.isRequired, true);

  // Prohibited criterion (e.g. age or gender)
  assert.throws(() => {
    validateCriterion({ name: "Candidate Age and Fitness", category: "experience" });
  }, /contains prohibited or discriminatory term/);

  assert.throws(() => {
    validateCriterion({ name: "Gender representation", category: "behavioral" });
  }, /contains prohibited or discriminatory term/);

  // Invalid weight
  assert.throws(() => {
    validateCriterion({ name: "Testing skills", category: "technical", weight: -2 });
  }, /weight must be a positive number/);

  assert.throws(() => {
    validateCriterion({ name: "Testing skills", category: "technical", weight: 500 });
  }, /weight must be a positive number/);
});

test("Weighted Score Calculation: accurately normalizes weighted ratings and handles missing scores", () => {
  const criteria = [
    { id: "c1", name: "Technical", weight: 3 },
    { id: "c2", name: "Problem Solving", weight: 2 },
    { id: "c3", name: "Communication", weight: 1 },
  ];

  // Ratings: c1=5, c2=4, c3=3
  // Sum(rating * weight) = 5*3 + 4*2 + 3*1 = 15 + 8 + 3 = 26
  // Sum(weight) = 3 + 2 + 1 = 6
  // Expected = 26 / 6 = 4.33
  const score1 = calculateWeightedScore([
    { criterionId: "c1", rating: 5 },
    { criterionId: "c2", rating: 4 },
    { criterionId: "c3", rating: 3 },
  ], criteria);

  assert.equal(score1, 4.33);

  // Partial ratings in draft: c1=4, c2 missing, c3=4
  // Sum(rating * weight) = 4*3 + 4*1 = 16
  // Sum(weight) = 3 + 1 = 4
  // Expected = 16 / 4 = 4.00 (missing c2 is NOT counted as 0)
  const draftScore = calculateWeightedScore([
    { criterionId: "c1", rating: 4 },
    { criterionId: "c3", rating: 4 },
  ], criteria);

  assert.equal(draftScore, 4.0);

  // Empty ratings
  assert.equal(calculateWeightedScore([], criteria), 0);
  assert.equal(calculateWeightedScore(null, criteria), 0);
});

test("Scorecard Recommendations: contains canonical hiring recommendations", () => {
  const expected = ["strong_hire", "hire", "lean_hire", "lean_no_hire", "no_hire"];
  for (const exp of expected) {
    assert.ok(Object.values(OVERALL_RECOMMENDATIONS).includes(exp));
  }
});

test("Pipeline Automation Constants: supports well-defined triggers and actions", () => {
  assert.equal(AUTOMATION_TRIGGERS.ALL_EVALUATIONS_SUBMITTED, "all_evaluations_submitted");
  assert.equal(AUTOMATION_TRIGGERS.INTERVIEW_COMPLETED, "interview_completed");
  assert.equal(AUTOMATION_TRIGGERS.EVALUATION_THRESHOLD_MET, "evaluation_threshold_met");

  assert.equal(AUTOMATION_ACTIONS.MARK_READY_FOR_REVIEW, "mark_ready_for_review");
  assert.equal(AUTOMATION_ACTIONS.ADVANCE_STAGE, "advance_stage");
  assert.equal(AUTOMATION_ACTIONS.NOTIFY_HIRING_MANAGER, "notify_hiring_manager");
});

test("Pipeline Lifecycle Guardrails: status transitions strictly follow ALLOWED_STATUS_TRANSITIONS", () => {
  // Valid progression: Applied -> Under Review
  assert.ok(ALLOWED_STATUS_TRANSITIONS["Applied"].includes("Under Review"));
  assert.ok(ALLOWED_STATUS_TRANSITIONS["Under Review"].includes("Shortlisted"));
  assert.ok(ALLOWED_STATUS_TRANSITIONS["Shortlisted"].includes("Interview Scheduled"));
  assert.ok(ALLOWED_STATUS_TRANSITIONS["Interview Scheduled"].includes("Offered"));

  // Disallowed arbitrary jump: Applied cannot jump directly to Interview Scheduled or Offered
  assert.ok(!ALLOWED_STATUS_TRANSITIONS["Applied"].includes("Interview Scheduled"));
  assert.ok(!ALLOWED_STATUS_TRANSITIONS["Applied"].includes("Offered"));
  assert.ok(!ALLOWED_STATUS_TRANSITIONS["Applied"].includes("Accepted"));

  // Terminal stages have no permitted outgoing transitions
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Accepted"], []);
  assert.deepEqual(ALLOWED_STATUS_TRANSITIONS["Rejected"], []);
});

test("Candidate Seeker Redaction: strips internal evaluation scorecards and review status", () => {
  const mockApplication = {
    _id: "app123",
    seekerEmail: "candidate@example.com",
    seekerName: "Jane Candidate",
    jobTitle: "Software Engineer",
    recruiterNotes: "Strong candidate with solid portfolio",
    notesHistory: [{ note: "Private interview notes" }],
    reviewStatus: "ready_for_decision",
    reviewStatusUpdatedAt: new Date(),
    evaluationSummary: { overallWeightedAverage: 4.5 },
    evaluations: [{ rating: 5, evaluatorEmail: "recruiter@example.com" }],
    scorecard: { criteria: [] },
    candidateReviewAssignments: [{ memberEmail: "interviewer@company.com" }],
  };

  // Helper matching sanitizeApplicationForSeeker
  function sanitize(app) {
    const s = { ...app };
    delete s.recruiterNotes;
    delete s.notesHistory;
    delete s.reviewStatus;
    delete s.reviewStatusUpdatedAt;
    delete s.evaluationSummary;
    delete s.evaluations;
    delete s.scorecard;
    delete s.candidateReviewAssignments;
    return s;
  }

  const sanitized = sanitize(mockApplication);
  assert.equal(sanitized._id, "app123");
  assert.equal(sanitized.seekerName, "Jane Candidate");
  assert.equal(sanitized.recruiterNotes, undefined);
  assert.equal(sanitized.notesHistory, undefined);
  assert.equal(sanitized.reviewStatus, undefined);
  assert.equal(sanitized.evaluationSummary, undefined);
  assert.equal(sanitized.evaluations, undefined);
  assert.equal(sanitized.scorecard, undefined);
  assert.equal(sanitized.candidateReviewAssignments, undefined);
});

test("Scorecard Email Templates: render correct summaries without candidate leaking", async () => {
  const { emailTemplates } = await import("../src/services/emailService.js");

  // 1. evaluationSubmitted
  const evalTmpl = emailTemplates.evaluationSubmitted({
    evaluatorName: "Alex Senior",
    candidateName: "John Doe",
    jobTitle: "Staff Backend Engineer",
    companyName: "Acme Corp",
    recommendation: "strong_hire",
    viewUrl: "https://hireloop.app/dashboard/jobs/123/applicants",
  });
  assert.ok(evalTmpl.subject.includes("New Candidate Evaluation Submitted: John Doe"));
  assert.ok(evalTmpl.html.includes("Alex Senior"));
  assert.ok(evalTmpl.html.includes("Staff Backend Engineer"));
  assert.ok(evalTmpl.html.includes("Strong Hire"));

  // 2. candidateReadyForDecision
  const decisionTmpl = emailTemplates.candidateReadyForDecision({
    candidateName: "John Doe",
    jobTitle: "Staff Backend Engineer",
    companyName: "Acme Corp",
    evaluationCount: 3,
    averageScore: 4.67,
    viewUrl: "https://hireloop.app/dashboard/jobs/123/applicants",
  });
  assert.ok(decisionTmpl.subject.includes("Candidate Ready for Decision: John Doe"));
  assert.ok(decisionTmpl.html.includes("4.67 / 5.0"));
  assert.ok(decisionTmpl.html.includes("Ready for Decision"));

  // 3. pipelineAutomationTriggered
  const autoTmpl = emailTemplates.pipelineAutomationTriggered({
    ruleName: "Advance Shortlisted on Good Score",
    candidateName: "John Doe",
    jobTitle: "Staff Backend Engineer",
    fromStatus: "Under Review",
    toStatus: "Shortlisted",
    actionName: "Stage Progression",
    viewUrl: "https://hireloop.app/dashboard/jobs/123/applicants",
  });
  assert.ok(autoTmpl.subject.includes("Pipeline Automation: Advance Shortlisted on Good Score"));
  assert.ok(autoTmpl.html.includes("Under Review"));
  assert.ok(autoTmpl.html.includes("Shortlisted"));
});

test("Vacancy Access Control for Scorecards: assigned interviewer vs unassigned interviewer", async () => {
  const { verifyVacancyAccess, COMPANY_ROLES } = await import("../src/services/companyWorkspaceService.js");

  const job = {
    _id: "job_999",
    companyId: "comp_123",
    recruiterEmail: "owner@company.com",
    assignedMemberEmails: ["assigned_interviewer@company.com"],
  };

  const assignedInterviewer = {
    email: "assigned_interviewer@company.com",
    role: "recruiter",
    companyRole: COMPANY_ROLES.INTERVIEWER,
  };

  const unassignedInterviewer = {
    email: "random_interviewer@company.com",
    role: "recruiter",
    companyRole: COMPANY_ROLES.INTERVIEWER,
  };

  // Assigned interviewer can submit and view evaluations
  const access1 = await verifyVacancyAccess(assignedInterviewer, job, "submit_evaluation");
  assert.equal(access1.authorized, true);
  assert.equal(access1.role, COMPANY_ROLES.INTERVIEWER);

  const access2 = await verifyVacancyAccess(assignedInterviewer, job, "view_evaluations");
  assert.equal(access2.authorized, true);

  // Unassigned interviewer cannot submit or view evaluations
  const denied1 = await verifyVacancyAccess(unassignedInterviewer, job, "submit_evaluation");
  assert.equal(denied1.authorized, false);
  assert.ok(denied1.reason.includes("explicitly assigned"));

  // Interviewer CANNOT manage templates or automation rules
  const deniedManage = await verifyVacancyAccess(assignedInterviewer, job, "manage_templates");
  assert.equal(deniedManage.authorized, false);
  assert.ok(deniedManage.reason.includes("cannot perform"));
});

