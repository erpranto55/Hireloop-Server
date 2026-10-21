import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { sanitizeAuditData } from "../src/services/auditService.js";

// Test suite for Audit Service Sanitization & Security
test("sanitizeAuditData strips passwords, tokens, API keys, and credit cards", () => {
  const sensitivePayload = {
    email: "admin@hireloop.com",
    role: "admin",
    password: "SuperSecretPassword123!",
    token: "jwt.token.here",
    sessionToken: "sess_xyz_12345",
    stripeSecretKey: "sk_test_fakekey",
    secret: "internal_webhook_secret",
    creditCard: "4242424242424242",
    cardNumber: "4000123456789010",
    cvv: "123",
    notesHistory: "Private recruiter comments",
    profile: {
      bio: "Software developer",
      password: "nested_secret_leak",
    },
    allowedField: "safe value",
  };

  const sanitized = sanitizeAuditData(sensitivePayload);

  // Assert sensitive fields are completely removed
  assert.equal(sanitized.password, undefined);
  assert.equal(sanitized.token, undefined);
  assert.equal(sanitized.sessionToken, undefined);
  assert.equal(sanitized.stripeSecretKey, undefined);
  assert.equal(sanitized.secret, undefined);
  assert.equal(sanitized.creditCard, undefined);
  assert.equal(sanitized.cardNumber, undefined);
  assert.equal(sanitized.cvv, undefined);
  assert.equal(sanitized.notesHistory, undefined);
  assert.equal(sanitized.profile.password, undefined);

  // Assert safe operational fields are preserved
  assert.equal(sanitized.email, "admin@hireloop.com");
  assert.equal(sanitized.role, "admin");
  assert.equal(sanitized.allowedField, "safe value");
  assert.equal(sanitized.profile.bio, "Software developer");
});

test("sanitizeAuditData handles arrays, nulls, and primitives cleanly", () => {
  assert.equal(sanitizeAuditData(null), null);
  assert.equal(sanitizeAuditData(undefined), undefined);
  assert.equal(sanitizeAuditData("simple_string"), "simple_string");
  assert.equal(sanitizeAuditData(42), 42);

  const arrayPayload = [
    { password: "123", name: "User 1" },
    { token: "abc", name: "User 2" },
  ];
  const cleanArray = sanitizeAuditData(arrayPayload);
  assert.equal(cleanArray.length, 2);
  assert.equal(cleanArray[0].password, undefined);
  assert.equal(cleanArray[0].name, "User 1");
  assert.equal(cleanArray[1].token, undefined);
  assert.equal(cleanArray[1].name, "User 2");
});

// Test suite for Recruiter Pipeline Funnel & Conversion Calculations
test("Recruiter conversion rate returns null with zero views and exact percentage with views", () => {
  const calculateConversion = (applicationsCount, viewsCount) => {
    return viewsCount > 0 ? Number(((applicationsCount / viewsCount) * 100).toFixed(1)) : null;
  };

  // Zero views: must return honest null (insufficient data state)
  assert.equal(calculateConversion(0, 0), null);
  assert.equal(calculateConversion(5, 0), null);

  // Normal conversion: 10 applications out of 100 views = 10.0%
  assert.equal(calculateConversion(10, 100), 10.0);

  // High conversion: 2 applications out of 3 views = 66.7%
  assert.equal(calculateConversion(2, 3), 66.7);
});

// Test suite for Time-to-Hire Calculation
test("Time-to-hire calculates elapsed calendar days accurately with sample size and medians", () => {
  const calculateTimeToHire = (applications) => {
    const hiredApplications = applications.filter((app) => {
      return (
        (app.status === "Accepted" || (app.statusHistory || []).some((h) => h.to === "Accepted")) &&
        app.appliedAt
      );
    });

    if (hiredApplications.length === 0) {
      return { averageDays: null, medianDays: null, sampleSize: 0 };
    }

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
    const averageDays = Number((sum / elapsedDaysList.length).toFixed(1));

    const mid = Math.floor(elapsedDaysList.length / 2);
    const medianDays = elapsedDaysList.length % 2 !== 0
      ? elapsedDaysList[mid]
      : Number(((elapsedDaysList[mid - 1] + elapsedDaysList[mid]) / 2).toFixed(1));

    return { averageDays, medianDays, sampleSize: elapsedDaysList.length };
  };

  // Case 1: No hired candidates -> returns nulls and 0 sample size
  const emptyRes = calculateTimeToHire([
    { status: "Applied", appliedAt: "2026-10-01" },
    { status: "Interview Scheduled", appliedAt: "2026-10-05" },
  ]);
  assert.equal(emptyRes.averageDays, null);
  assert.equal(emptyRes.medianDays, null);
  assert.equal(emptyRes.sampleSize, 0);

  // Case 2: Three hired candidates (10 days, 15 days, 20 days)
  const threeHires = [
    {
      status: "Accepted",
      appliedAt: "2026-10-01T00:00:00Z",
      statusHistory: [{ to: "Accepted", changedAt: "2026-10-11T00:00:00Z" }],
    },
    {
      status: "Accepted",
      appliedAt: "2026-10-01T00:00:00Z",
      statusHistory: [{ to: "Accepted", changedAt: "2026-10-16T00:00:00Z" }],
    },
    {
      status: "Accepted",
      appliedAt: "2026-10-01T00:00:00Z",
      statusHistory: [{ to: "Accepted", changedAt: "2026-10-21T00:00:00Z" }],
    },
  ];
  const metrics = calculateTimeToHire(threeHires);
  assert.equal(metrics.sampleSize, 3);
  assert.equal(metrics.averageDays, 15.0);
  assert.equal(metrics.medianDays, 15.0);
});

// Test suite for Job Seeker Acceptance Rate Calculation
test("Job Seeker acceptance rate ignores pending applications and avoids false rejections", () => {
  const calculateAcceptanceRate = (applications) => {
    let acceptedCount = 0;
    let rejectedCount = 0;

    for (const app of applications) {
      if (app.status === "Accepted") acceptedCount++;
      if (app.status === "Rejected") rejectedCount++;
    }

    const finalizedCount = acceptedCount + rejectedCount;
    const rate = finalizedCount > 0
      ? Number(((acceptedCount / finalizedCount) * 100).toFixed(1))
      : null;

    return { rate, acceptedCount, rejectedCount, finalizedCount, pendingCount: applications.length - finalizedCount };
  };

  // Case 1: 5 applications, all under review or interview -> finalizedCount is 0, rate is null
  const pendingApps = [
    { status: "Applied" },
    { status: "Under Review" },
    { status: "Interview Scheduled" },
    { status: "Interview Scheduled" },
    { status: "Offered" },
  ];
  const resPending = calculateAcceptanceRate(pendingApps);
  assert.equal(resPending.rate, null);
  assert.equal(resPending.finalizedCount, 0);
  assert.equal(resPending.pendingCount, 5);

  // Case 2: 1 accepted, 1 rejected, 3 pending -> rate = 1 / 2 = 50.0%
  const mixedApps = [
    ...pendingApps,
    { status: "Accepted" },
    { status: "Rejected" },
  ];
  const resMixed = calculateAcceptanceRate(mixedApps);
  assert.equal(resMixed.rate, 50.0);
  assert.equal(resMixed.acceptedCount, 1);
  assert.equal(resMixed.rejectedCount, 1);
  assert.equal(resMixed.finalizedCount, 2);
  assert.equal(resMixed.pendingCount, 5);
});

// Test suite for Seeker Evidence-Based Readiness Checklist
test("Evidence-based readiness checklist scores strictly from actual profile and application facts", () => {
  const evaluateReadiness = (user, applications) => {
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

    const checklist = [
      { id: "profile_basics", completed: hasName && hasHeadline, weight: 15 },
      { id: "resume_uploaded", completed: hasResume, weight: 25 },
      { id: "skills_declared", completed: hasSkills, weight: 20 },
      { id: "detailed_bio", completed: hasBio, weight: 15 },
      { id: "application_activity", completed: hasProgressedApp, weight: 15 },
      { id: "interview_ready", completed: hasInterview, weight: 10 },
    ];

    const score = checklist.reduce((acc, item) => acc + (item.completed ? item.weight : 0), 0);
    return { score, checklist };
  };

  // Bare user without profile or resume -> 0 score
  const bareRes = evaluateReadiness({}, []);
  assert.equal(bareRes.score, 0);

  // Fully completed profile with resume and 3 skills, but no applications -> 15 + 25 + 20 + 15 = 75
  const completeProfile = {
    name: "Alex Doe",
    headline: "Senior Software Engineer",
    bio: "Experienced full-stack developer with 8+ years building enterprise applications.",
    resumeUrl: "/uploads/resumes/resume.pdf",
    skills: "React, Node.js, TypeScript, PostgreSQL",
  };
  const profileRes = evaluateReadiness(completeProfile, []);
  assert.equal(profileRes.score, 75);

  // Add progressed application and interview milestone -> 75 + 15 + 10 = 100
  const fullRes = evaluateReadiness(completeProfile, [
    { status: "Interview Scheduled" },
  ]);
  assert.equal(fullRes.score, 100);
});

// Test suite for Job View Deduplication Hash
test("Privacy-conscious viewerKey hashes client details consistently without storing raw IP", () => {
  const computeViewerKey = (ip, userAgent, email) => {
    const rawKey = `${ip}_${userAgent}_${email || "anon"}`;
    return crypto.createHash("sha256").update(rawKey).digest("hex").substring(0, 24);
  };

  const key1 = computeViewerKey("192.168.1.1", "Mozilla/5.0", "seeker@hireloop.com");
  const key2 = computeViewerKey("192.168.1.1", "Mozilla/5.0", "seeker@hireloop.com");
  const key3 = computeViewerKey("192.168.1.2", "Mozilla/5.0", "seeker@hireloop.com");

  // Same client yields identical key
  assert.equal(key1, key2);
  assert.equal(key1.length, 24);

  // Different IP yields distinct key
  assert.notEqual(key1, key3);

  // Key is irreversible hex hash
  assert.equal(key1.includes("192.168.1.1"), false);
  assert.equal(key1.includes("seeker@hireloop.com"), false);
});
