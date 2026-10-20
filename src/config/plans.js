/**
 * Authoritative Plan Definitions and Entitlements for HireLoop.
 * Corresponds to pricing and quota models defined in both seeker and recruiter dashboards.
 */

export const PLANS = {
  seeker: {
    Free: {
      name: "Free",
      role: "seeker",
      amountCents: 0,
      priceFormatted: "$0",
      interval: "month",
      applicationLimit: 3,
      savedJobsLimit: 10,
      features: [
        "Browse and save up to 10 jobs",
        "Apply to 3 jobs per month",
        "Basic profile",
        "Email alerts",
      ],
    },
    Pro: {
      name: "Pro",
      role: "seeker",
      amountCents: 1900,
      priceFormatted: "$19",
      interval: "month",
      applicationLimit: 30,
      savedJobsLimit: Infinity,
      priceIdEnvVar: "STRIPE_PRICE_SEEKER_PRO",
      features: [
        "Apply to 30 jobs per month",
        "Unlimited saved jobs",
        "Application tracking",
        "Salary insights",
      ],
    },
    Premium: {
      name: "Premium",
      role: "seeker",
      amountCents: 3900,
      priceFormatted: "$39",
      interval: "month",
      applicationLimit: Infinity,
      savedJobsLimit: Infinity,
      priceIdEnvVar: "STRIPE_PRICE_SEEKER_PREMIUM",
      features: [
        "Unlimited applications",
        "Profile boost to recruiters",
        "Early job access",
        "Priority support",
      ],
    },
  },
  recruiter: {
    Free: {
      name: "Free",
      role: "recruiter",
      amountCents: 0,
      priceFormatted: "$0",
      interval: "month",
      activeJobLimit: 3,
      features: [
        "3 active job posts",
        "Basic applicant management",
        "Standard listing visibility",
        "Company profile",
      ],
    },
    Growth: {
      name: "Growth",
      role: "recruiter",
      amountCents: 4900,
      priceFormatted: "$49",
      interval: "month",
      activeJobLimit: 10,
      priceIdEnvVar: "STRIPE_PRICE_RECRUITER_GROWTH",
      features: [
        "10 active job posts",
        "Applicant tracking system",
        "Basic analytics",
        "Email support",
      ],
    },
    Enterprise: {
      name: "Enterprise",
      role: "recruiter",
      amountCents: 14900,
      priceFormatted: "$149",
      interval: "month",
      activeJobLimit: 50,
      priceIdEnvVar: "STRIPE_PRICE_RECRUITER_ENTERPRISE",
      features: [
        "50 active job posts",
        "Advanced analytics dashboard",
        "Featured listings",
        "Team collaboration",
        "Priority support",
      ],
    },
  },
};

/**
 * Retrieves plan configuration by user role and plan name.
 * Normalizes case sensitivity.
 */
export function getPlanConfig(role = "seeker", planName = "Free") {
  const normalizedRole = (role || "").toLowerCase() === "recruiter" ? "recruiter" : "seeker";
  const rolePlans = PLANS[normalizedRole];

  // Look for match
  const matchKey = Object.keys(rolePlans).find(
    (k) => k.toLowerCase() === (planName || "").toLowerCase()
  );

  return matchKey ? rolePlans[matchKey] : null;
}

/**
 * Returns the effective active job limit for a recruiter based on their plan.
 */
export function getRecruiterJobLimit(planName = "Free") {
  const plan = getPlanConfig("recruiter", planName);
  return plan?.activeJobLimit || PLANS.recruiter.Free.activeJobLimit;
}

/**
 * Returns the effective monthly application limit for a job seeker.
 */
export function getSeekerApplicationLimit(planName = "Free") {
  const plan = getPlanConfig("seeker", planName);
  return plan?.applicationLimit !== undefined ? plan.applicationLimit : PLANS.seeker.Free.applicationLimit;
}
