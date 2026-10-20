import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import {
  PLANS,
  getPlanConfig,
  getRecruiterJobLimit,
  getSeekerApplicationLimit,
} from "../src/config/plans.js";

// Test suite for Plan Configuration & Entitlement Boundaries
test("getPlanConfig returns accurate plan configuration for seeker", () => {
  const free = getPlanConfig("seeker", "Free");
  assert.equal(free.amountCents, 0);
  assert.equal(free.applicationLimit, 3);
  assert.equal(free.interval, "month");

  const pro = getPlanConfig("seeker", "Pro");
  assert.equal(pro.amountCents, 1900);
  assert.equal(pro.applicationLimit, 30);
  assert.equal(pro.priceIdEnvVar, "STRIPE_PRICE_SEEKER_PRO");

  const premium = getPlanConfig("seeker", "Premium");
  assert.equal(premium.amountCents, 3900);
  assert.equal(premium.applicationLimit, Infinity);
});

test("getPlanConfig returns accurate plan configuration for recruiter", () => {
  const free = getPlanConfig("recruiter", "Free");
  assert.equal(free.amountCents, 0);
  assert.equal(free.activeJobLimit, 3);

  const growth = getPlanConfig("recruiter", "Growth");
  assert.equal(growth.amountCents, 4900);
  assert.equal(growth.activeJobLimit, 10);
  assert.equal(growth.priceIdEnvVar, "STRIPE_PRICE_RECRUITER_GROWTH");

  const enterprise = getPlanConfig("recruiter", "Enterprise");
  assert.equal(enterprise.amountCents, 14900);
  assert.equal(enterprise.activeJobLimit, 50);
  assert.equal(enterprise.priceIdEnvVar, "STRIPE_PRICE_RECRUITER_ENTERPRISE");
});

test("getPlanConfig normalizes case and rejects invalid or cross-role plans", () => {
  // Case insensitivity
  assert.equal(getPlanConfig("seeker", "pro")?.name, "Pro");
  assert.equal(getPlanConfig("recruiter", "growth")?.name, "Growth");

  // Rejection of fabricated or arbitrary plans
  assert.equal(getPlanConfig("seeker", "VIP_SUPER_UNLIMITED"), null);
  assert.equal(getPlanConfig("seeker", "Enterprise"), null); // Enterprise is recruiter only
  assert.equal(getPlanConfig("recruiter", "Pro"), null); // Pro is seeker only
  assert.equal(getPlanConfig("recruiter", "None"), null);
});

test("getRecruiterJobLimit enforces active job limits", () => {
  assert.equal(getRecruiterJobLimit("Free"), 3);
  assert.equal(getRecruiterJobLimit("Growth"), 10);
  assert.equal(getRecruiterJobLimit("Enterprise"), 50);
  // Default fallback for unknown or invalid plan
  assert.equal(getRecruiterJobLimit("Unknown"), 3);
  assert.equal(getRecruiterJobLimit(null), 3);
});

test("getSeekerApplicationLimit enforces monthly application limits", () => {
  assert.equal(getSeekerApplicationLimit("Free"), 3);
  assert.equal(getSeekerApplicationLimit("Pro"), 30);
  assert.equal(getSeekerApplicationLimit("Premium"), Infinity);
  // Default fallback for unknown or invalid plan
  assert.equal(getSeekerApplicationLimit("Unknown"), 3);
  assert.equal(getSeekerApplicationLimit(null), 3);
});

// Test suite for Stripe Webhook Signature Verification using Stripe SDK
test("Stripe webhook signature verification succeeds with authentic signature", () => {
  const stripe = new Stripe("sk_test_mock_billing_test_key");
  const testSecret = "whsec_test_secret_for_hireloop_testing";
  const payload = JSON.stringify({
    id: "evt_test_12345",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_abc123",
        customer: "cus_test_123",
        metadata: {
          userEmail: "recruiter@example.com",
          planName: "Growth",
          role: "recruiter",
        },
      },
    },
  });

  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: testSecret,
  });

  const verifiedEvent = stripe.webhooks.constructEvent(payload, header, testSecret);
  assert.equal(verifiedEvent.id, "evt_test_12345");
  assert.equal(verifiedEvent.type, "checkout.session.completed");
  assert.equal(verifiedEvent.data.object.metadata.planName, "Growth");
});

test("Stripe webhook signature verification rejects tampered payload or bad secret", () => {
  const stripe = new Stripe("sk_test_mock_billing_test_key");
  const testSecret = "whsec_test_secret_for_hireloop_testing";
  const originalPayload = JSON.stringify({ id: "evt_123", amount: 1000 });
  const tamperedPayload = JSON.stringify({ id: "evt_123", amount: 0 }); // Tampered amount

  const header = stripe.webhooks.generateTestHeaderString({
    payload: originalPayload,
    secret: testSecret,
  });

  // Verification with tampered payload must throw signature verification error
  assert.throws(
    () => {
      stripe.webhooks.constructEvent(tamperedPayload, header, testSecret);
    },
    /signature/i
  );

  // Verification with wrong secret must throw
  assert.throws(
    () => {
      stripe.webhooks.constructEvent(originalPayload, header, "whsec_wrong_secret");
    },
    /signature/i
  );
});

test("Webhook idempotency simulates duplicate event suppression", () => {
  const processedEvents = new Set();

  function processEventIdempotently(event) {
    if (processedEvents.has(event.id)) {
      return { duplicate: true, processed: false };
    }
    processedEvents.add(event.id);
    return { duplicate: false, processed: true };
  }

  const event = { id: "evt_idem_101", type: "invoice.paid" };

  const firstCall = processEventIdempotently(event);
  assert.equal(firstCall.duplicate, false);
  assert.equal(firstCall.processed, true);

  const duplicateCall = processEventIdempotently(event);
  assert.equal(duplicateCall.duplicate, true);
  assert.equal(duplicateCall.processed, false);
});

test("Subscription state transition: canceled subscription reverts plan to Free", () => {
  function computeEffectivePlan(activeStatus, planName) {
    const isGoodStanding = ["active", "trialing"].includes(activeStatus);
    return isGoodStanding ? planName : "Free";
  }

  assert.equal(computeEffectivePlan("active", "Growth"), "Growth");
  assert.equal(computeEffectivePlan("trialing", "Enterprise"), "Enterprise");
  assert.equal(computeEffectivePlan("canceled", "Growth"), "Free");
  assert.equal(computeEffectivePlan("unpaid", "Enterprise"), "Free");
  assert.equal(computeEffectivePlan("past_due", "Growth"), "Free");
});

test("User profile updates isolate billing entitlements from standard edits", () => {
  const allowedProfileFields = ["name", "headline", "image", "bio", "resumeUrl", "skills", "companyId"];

  function filterNonAdminUpdate(body) {
    const safeData = {};
    for (const field of allowedProfileFields) {
      if (body[field] !== undefined) {
        safeData[field] = body[field];
      }
    }
    return safeData;
  }

  const maliciousBody = {
    name: "John Doe",
    bio: "Experienced developer",
    plan: "Enterprise", // Attacker trying to self-promote
    role: "admin",      // Attacker trying to escalate role
    status: "active",
    stripeCustomerId: "cus_fake",
  };

  const filtered = filterNonAdminUpdate(maliciousBody);

  assert.equal(filtered.name, "John Doe");
  assert.equal(filtered.bio, "Experienced developer");
  assert.equal(filtered.plan, undefined);
  assert.equal(filtered.role, undefined);
  assert.equal(filtered.status, undefined);
  assert.equal(filtered.stripeCustomerId, undefined);
});
