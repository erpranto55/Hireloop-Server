import { Router } from "express";
import Stripe from "stripe";
import { config } from "../config.js";
import { getPlanConfig, getRecruiterJobLimit, getSeekerApplicationLimit } from "../config/plans.js";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, created, notFound } from "../utils/http.js";
import { createNotification } from "../services/notificationService.js";

const router = Router();

// Lazy Stripe client initialization
function getStripeClient() {
  if (!config.stripeSecretKey) {
    return null;
  }
  return new Stripe(config.stripeSecretKey);
}

/**
 * Reconciles and updates a user's subscription record and user.plan in MongoDB.
 */
async function syncUserSubscription({
  userEmail,
  planName,
  role,
  stripeCustomerId,
  stripeSubscriptionId,
  subscriptionStatus = "active",
  currentPeriodStart = null,
  currentPeriodEnd = null,
  cancelAtPeriodEnd = false,
}) {
  const db = getDb();
  const normalizedEmail = userEmail.toLowerCase();

  // Find user to ensure correct role and existence
  const user = await db.collection("user").findOne({ email: new RegExp(`^${normalizedEmail}$`, "i") });
  const effectiveRole = role || user?.role || "seeker";

  // Check if plan is valid for role
  const planConfig = getPlanConfig(effectiveRole, planName);
  const validatedPlan = planConfig ? planConfig.name : (planName || "Free");

  // Determine user-level plan field: if subscription is canceled/unpaid, revert to Free
  const activeStatuses = ["active", "trialing"];
  const isGoodStanding = activeStatuses.includes(subscriptionStatus);
  const effectivePlanName = isGoodStanding ? validatedPlan : "Free";

  const userUpdate = {
    plan: effectivePlanName,
    updatedAt: new Date(),
  };
  if (stripeCustomerId) userUpdate.stripeCustomerId = stripeCustomerId;
  if (stripeSubscriptionId) userUpdate.stripeSubscriptionId = stripeSubscriptionId;

  await db.collection("user").updateOne(
    { email: new RegExp(`^${normalizedEmail}$`, "i") },
    { $set: userUpdate }
  );

  // Persist into subscriptions collection
  const subscriptionDoc = {
    userEmail: normalizedEmail,
    role: effectiveRole,
    plan: validatedPlan,
    effectivePlan: effectivePlanName,
    stripeCustomerId: stripeCustomerId || null,
    stripeSubscriptionId: stripeSubscriptionId || null,
    status: subscriptionStatus,
    currentPeriodStart: currentPeriodStart ? new Date(currentPeriodStart * 1000) : null,
    currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
    cancelAtPeriodEnd: Boolean(cancelAtPeriodEnd),
    updatedAt: new Date(),
  };

  await db.collection("subscriptions").updateOne(
    { userEmail: normalizedEmail },
    {
      $set: subscriptionDoc,
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  return { effectivePlan: effectivePlanName, status: subscriptionStatus };
}

// GET /api/payments/subscription - Authoritative subscription and quota details
router.get("/subscription", requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const user = await db.collection("user").findOne({ email: new RegExp(`^${req.user.email}$`, "i") });
  if (!user) return notFound(res, "User not found");

  const role = (user.role || "seeker").toLowerCase();
  const currentPlan = user.plan || "Free";

  // Fetch persisted subscription
  const sub = await db.collection("subscriptions").findOne({ userEmail: new RegExp(`^${user.email}$`, "i") });

  // Compute current usage
  let usage = {};
  if (role === "recruiter") {
    const activeJobs = await db.collection("jobs").countDocuments({
      recruiterEmail: new RegExp(`^${user.email}$`, "i"),
      status: "active",
    });
    const limit = getRecruiterJobLimit(currentPlan);
    usage = {
      activeJobs,
      jobLimit: limit,
      remainingJobs: Math.max(0, limit - activeJobs),
    };
  } else {
    // Current calendar month applications
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const monthlyApps = await db.collection("applications").countDocuments({
      seekerEmail: new RegExp(`^${user.email}$`, "i"),
      appliedAt: { $gte: startOfMonth },
    });
    const limit = getSeekerApplicationLimit(currentPlan);
    usage = {
      monthlyApplications: monthlyApps,
      applicationLimit: limit,
      remainingApplications: limit === Infinity ? "Unlimited" : Math.max(0, limit - monthlyApps),
    };
  }

  res.json({
    role,
    plan: currentPlan,
    stripeCustomerId: user.stripeCustomerId || null,
    stripeSubscriptionId: user.stripeSubscriptionId || null,
    subscription: sub || null,
    usage,
  });
}));

// POST /api/payments/create-checkout-session - Secure Checkout Session creation
router.post("/create-checkout-session", requireAuth, asyncHandler(async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    return res.status(503).json({
      message: "Stripe billing is not configured. Please add STRIPE_SECRET_KEY to server environment.",
    });
  }

  const { plan: planName } = req.body;
  if (!planName) return badRequest(res, "Plan name is required");

  const db = getDb();
  const user = await db.collection("user").findOne({ email: new RegExp(`^${req.user.email}$`, "i") });
  if (!user) return notFound(res, "User account not found");

  if (user.status === "suspended") {
    return res.status(403).json({ message: "Suspended accounts are not eligible for billing operations." });
  }

  const role = (user.role || "seeker").toLowerCase();
  const plan = getPlanConfig(role, planName);

  if (!plan) {
    return badRequest(res, `Invalid plan '${planName}' for account role '${role}'.`);
  }

  if (plan.amountCents === 0) {
    return badRequest(res, "Free plan does not require checkout.");
  }

  // Prevent duplicate subscription if already on this exact paid plan
  if (user.plan?.toLowerCase() === plan.name.toLowerCase() && user.stripeSubscriptionId) {
    return res.status(400).json({
      message: `You are already subscribed to the ${plan.name} plan. Use the subscription management portal to update your plan.`,
    });
  }

  // Resolve or create Stripe Customer
  let customerId = user.stripeCustomerId;
  if (customerId) {
    try {
      const existingCustomer = await stripe.customers.retrieve(customerId);
      if (existingCustomer.deleted) customerId = null;
    } catch {
      customerId = null;
    }
  }

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: {
        userId: user._id.toString(),
        email: user.email,
        role,
      },
    });
    customerId = customer.id;
    await db.collection("user").updateOne(
      { _id: user._id },
      { $set: { stripeCustomerId: customerId, updatedAt: new Date() } }
    );
  }

  // Determine line_items: prefer environment-configured Stripe Price ID; fallback to secure inline price_data
  let lineItem;
  const envPriceId = plan.priceIdEnvVar ? process.env[plan.priceIdEnvVar] : null;

  if (envPriceId && envPriceId.startsWith("price_")) {
    lineItem = { price: envPriceId, quantity: 1 };
  } else {
    lineItem = {
      price_data: {
        currency: "usd",
        product_data: {
          name: `HireLoop ${plan.name} Plan (${role === "recruiter" ? "Recruiter" : "Job Seeker"})`,
          description: plan.features.join(", "),
        },
        unit_amount: plan.amountCents,
        recurring: { interval: plan.interval },
      },
      quantity: 1,
    };
  }

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "subscription",
    customer: customerId,
    client_reference_id: user._id.toString(),
    line_items: [lineItem],
    success_url: `${config.clientOrigin}/dashboard/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.clientOrigin}/dashboard/${role === "recruiter" ? "recruiter" : "seeker"}/billing?canceled=true`,
    metadata: {
      userId: user._id.toString(),
      userEmail: user.email,
      role,
      planName: plan.name,
    },
    subscription_data: {
      metadata: {
        userId: user._id.toString(),
        userEmail: user.email,
        role,
        planName: plan.name,
      },
    },
  });

  res.json({ url: session.url, sessionId: session.id });
}));

// GET /api/payments/verify-session - Verify Stripe Checkout Session and reconcile local entitlement
router.get("/verify-session", requireAuth, asyncHandler(async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    return res.status(503).json({ message: "Stripe is not configured." });
  }

  const { session_id } = req.query;
  if (!session_id) return badRequest(res, "session_id query parameter is required");

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["subscription", "customer"],
    });
  } catch (error) {
    return badRequest(res, `Failed to retrieve session from Stripe: ${error.message}`);
  }

  // Ensure session belongs to current user
  const sessionEmail = session.customer_details?.email || session.metadata?.userEmail;
  if (!sessionEmail || sessionEmail.toLowerCase() !== req.user.email.toLowerCase()) {
    return res.status(403).json({ message: "Forbidden: Session belongs to a different account." });
  }

  const planName = session.metadata?.planName;
  const role = session.metadata?.role || req.user.role;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  const subscriptionStatus = session.subscription?.status || "active";

  if (session.payment_status === "paid" || subscriptionStatus === "active" || subscriptionStatus === "trialing") {
    // Reconcile user and subscription record
    await syncUserSubscription({
      userEmail: req.user.email,
      planName,
      role,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus,
      currentPeriodStart: session.subscription?.current_period_start,
      currentPeriodEnd: session.subscription?.current_period_end,
      cancelAtPeriodEnd: session.subscription?.cancel_at_period_end,
    });

    // Also record payment record if not yet recorded
    const db = getDb();
    const existingPayment = await db.collection("payments").findOne({ transactionId: session.id });
    if (!existingPayment) {
      await db.collection("payments").insertOne({
        userEmail: req.user.email.toLowerCase(),
        role,
        plan: planName,
        amount: session.amount_total ? `$${(session.amount_total / 100).toFixed(0)}` : "$0",
        amountCents: session.amount_total || 0,
        currency: session.currency || "usd",
        transactionId: session.id,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        status: "paid",
        createdAt: new Date(),
      });
    }

    createNotification({
      recipientEmail: req.user.email,
      role: role || req.user.role || "seeker",
      type: "subscription_activated",
      title: "Subscription Activated",
      message: `Your HireLoop subscription to the ${planName} plan is now active.`,
      link: `/dashboard/${role === "recruiter" ? "recruiter" : "seeker"}/billing`,
      referenceId: session.id,
      referenceType: "checkout_session",
      idempotencyKey: `sub_act_${session.id}`,
      sendEmail: true,
      emailTemplate: "subscriptionActivated",
      emailData: {
        planName,
        role: role || req.user.role || "seeker",
        billingUrl: `/dashboard/${role === "recruiter" ? "recruiter" : "seeker"}/billing`,
      },
    }).catch((err) => console.error("[Payments] Verify-session notification error:", err.message));
  }

  res.json({
    status: session.status,
    paymentStatus: session.payment_status,
    plan: planName,
    role,
    subscriptionId,
  });
}));

// POST /api/payments/create-portal-session - Customer Billing Portal
router.post("/create-portal-session", requireAuth, asyncHandler(async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    return res.status(503).json({ message: "Stripe billing is not configured." });
  }

  const db = getDb();
  const user = await db.collection("user").findOne({ email: new RegExp(`^${req.user.email}$`, "i") });
  if (!user || !user.stripeCustomerId) {
    return badRequest(res, "No active Stripe customer found for this account.");
  }

  const role = (user.role || "seeker").toLowerCase();
  const returnUrl = `${config.clientOrigin}/dashboard/${role === "recruiter" ? "recruiter" : "seeker"}/billing`;

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: returnUrl,
  });

  res.json({ url: portalSession.url });
}));

// POST /api/payments/cancel-subscription - Cancel subscription at period end
router.post("/cancel-subscription", requireAuth, asyncHandler(async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    return res.status(503).json({ message: "Stripe billing is not configured." });
  }

  const db = getDb();
  const user = await db.collection("user").findOne({ email: new RegExp(`^${req.user.email}$`, "i") });
  if (!user || !user.stripeSubscriptionId) {
    return badRequest(res, "No active subscription found to cancel.");
  }

  const updatedSub = await stripe.subscriptions.update(user.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });

  await db.collection("subscriptions").updateOne(
    { userEmail: new RegExp(`^${user.email}$`, "i") },
    { $set: { cancelAtPeriodEnd: true, updatedAt: new Date() } }
  );

  const expirationDate = updatedSub.current_period_end
    ? new Date(updatedSub.current_period_end * 1000).toLocaleDateString()
    : "end of current billing period";

  createNotification({
    recipientEmail: user.email,
    role: user.role || "seeker",
    type: "subscription_cancellation_scheduled",
    title: "Subscription Cancellation Scheduled",
    message: `Your subscription will remain active until ${expirationDate}, after which your account will return to the Free tier.`,
    link: `/dashboard/${user.role === "recruiter" ? "recruiter" : "seeker"}/billing`,
    referenceId: user.stripeSubscriptionId,
    referenceType: "subscription",
    idempotencyKey: `sub_cancel_${user.stripeSubscriptionId}_${updatedSub.current_period_end}`,
    sendEmail: true,
    emailTemplate: "subscriptionCanceled",
    emailData: {
      planName: user.plan || "Current Plan",
      expirationDate,
      billingUrl: `/dashboard/${user.role === "recruiter" ? "recruiter" : "seeker"}/billing`,
    },
  }).catch((err) => {
    console.error("[Payments] Cancel notification error:", err.message);
  });

  res.json({
    message: "Subscription scheduled to cancel at end of current billing period.",
    cancelAtPeriodEnd: updatedSub.cancel_at_period_end,
    currentPeriodEnd: new Date(updatedSub.current_period_end * 1000),
  });
}));

// POST /api/payments/webhook - Verified Stripe Webhook Receiver
router.post("/webhook", asyncHandler(async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    return res.status(503).json({ message: "Stripe is not configured." });
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).json({ message: "Missing stripe-signature header" });
  }

  // Use unparsed raw body
  const rawBody = Buffer.isBuffer(req.body) ? req.body : req.rawBody;
  if (!rawBody) {
    return res.status(400).json({ message: "Missing raw request body for webhook verification" });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, config.stripeWebhookSecret);
  } catch (err) {
    return res.status(400).json({ message: `Webhook signature verification failed: ${err.message}` });
  }

  const db = getDb();

  // Idempotency check: Reject duplicate event delivery safely
  try {
    await db.collection("webhook_events").insertOne({
      eventId: event.id,
      type: event.type,
      processedAt: new Date(),
    });
  } catch (err) {
    if (err.code === 11000) {
      // Event already recorded and processed
      return res.status(200).json({ received: true, duplicate: true });
    }
    throw err;
  }

  // Handle supported billing lifecycle events
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userEmail = session.metadata?.userEmail || session.customer_details?.email;
      const planName = session.metadata?.planName;
      const role = session.metadata?.role;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      if (userEmail && planName) {
        await syncUserSubscription({
          userEmail,
          planName,
          role,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: "active",
        });

        // Insert payment history item if not already recorded
        const existing = await db.collection("payments").findOne({ transactionId: session.id });
        if (!existing) {
          await db.collection("payments").insertOne({
            userEmail: userEmail.toLowerCase(),
            role: role || "seeker",
            plan: planName,
            amount: session.amount_total ? `$${(session.amount_total / 100).toFixed(0)}` : "$0",
            amountCents: session.amount_total || 0,
            currency: session.currency || "usd",
            transactionId: session.id,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            status: "paid",
            createdAt: new Date(),
          });
        }

        createNotification({
          recipientEmail: userEmail,
          role: role || "seeker",
          type: "subscription_activated",
          title: "Subscription Activated",
          message: `Your HireLoop subscription to the ${planName} plan is now active.`,
          link: `/dashboard/${role === "recruiter" ? "recruiter" : "seeker"}/billing`,
          referenceId: session.id,
          referenceType: "checkout_session",
          idempotencyKey: `sub_act_${session.id}`,
          sendEmail: true,
          emailTemplate: "subscriptionActivated",
          emailData: {
            planName,
            role: role || "seeker",
            billingUrl: `/dashboard/${role === "recruiter" ? "recruiter" : "seeker"}/billing`,
          },
        }).catch((err) => console.error("[Payments] Checkout notification error:", err.message));
      }
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const planName = subscription.metadata?.planName;
      const userEmail = subscription.metadata?.userEmail;

      // Find user by metadata or stripeCustomerId
      const user = userEmail
        ? await db.collection("user").findOne({ email: new RegExp(`^${userEmail}$`, "i") })
        : await db.collection("user").findOne({ stripeCustomerId: customerId });

      if (user) {
        await syncUserSubscription({
          userEmail: user.email,
          planName: planName || user.plan,
          role: user.role,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          currentPeriodStart: subscription.current_period_start,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        });
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const user = await db.collection("user").findOne({ stripeCustomerId: customerId });

      if (user) {
        await syncUserSubscription({
          userEmail: user.email,
          planName: "Free",
          role: user.role,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: "canceled",
        });

        createNotification({
          recipientEmail: user.email,
          role: user.role || "seeker",
          type: "subscription_canceled",
          title: "Subscription Ended",
          message: `Your subscription has ended. Your account has returned to the Free tier.`,
          link: `/dashboard/${user.role === "recruiter" ? "recruiter" : "seeker"}/billing`,
          referenceId: subscription.id,
          referenceType: "subscription",
          idempotencyKey: `sub_del_${subscription.id}`,
          sendEmail: true,
          emailTemplate: "subscriptionCanceled",
          emailData: {
            planName: "Previous Plan",
            expirationDate: "Immediately",
            billingUrl: `/dashboard/${user.role === "recruiter" ? "recruiter" : "seeker"}/billing`,
          },
        }).catch((err) => console.error("[Payments] Cancel notification error:", err.message));
      }
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const user = await db.collection("user").findOne({ stripeCustomerId: customerId });

      if (user && invoice.subscription) {
        // Record renewal payment record
        const paymentRecord = {
          userEmail: user.email.toLowerCase(),
          role: user.role,
          plan: user.plan || "Pro",
          amount: invoice.amount_paid ? `$${(invoice.amount_paid / 100).toFixed(0)}` : "$0",
          amountCents: invoice.amount_paid || 0,
          currency: invoice.currency || "usd",
          transactionId: invoice.id,
          stripeInvoiceId: invoice.id,
          stripeSubscriptionId: invoice.subscription,
          status: "paid",
          createdAt: new Date(),
        };
        await db.collection("payments").updateOne(
          { transactionId: invoice.id },
          { $setOnInsert: paymentRecord },
          { upsert: true }
        );

        createNotification({
          recipientEmail: user.email,
          role: user.role || "seeker",
          type: "payment_succeeded",
          title: "Payment Confirmed",
          message: `Your renewal payment of ${paymentRecord.amount} for your ${paymentRecord.plan} plan has been processed successfully.`,
          link: `/dashboard/${user.role === "recruiter" ? "recruiter" : "seeker"}/billing`,
          referenceId: invoice.id,
          referenceType: "invoice",
          idempotencyKey: `pay_succ_${invoice.id}`,
          sendEmail: true,
          emailTemplate: "paymentSucceeded",
          emailData: {
            planName: paymentRecord.plan,
            amount: paymentRecord.amount,
            billingUrl: `/dashboard/${user.role === "recruiter" ? "recruiter" : "seeker"}/billing`,
          },
        }).catch((err) => console.error("[Payments] Invoice notification error:", err.message));
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const user = await db.collection("user").findOne({ stripeCustomerId: customerId });

      if (user) {
        await db.collection("subscriptions").updateOne(
          { userEmail: new RegExp(`^${user.email}$`, "i") },
          { $set: { status: "past_due", updatedAt: new Date() } }
        );

        createNotification({
          recipientEmail: user.email,
          role: user.role || "seeker",
          type: "payment_failed",
          title: "Payment Failed",
          message: `Your scheduled renewal payment could not be processed. Please update your payment card to avoid account downgrading.`,
          link: `/dashboard/${user.role === "recruiter" ? "recruiter" : "seeker"}/billing`,
          referenceId: invoice.id,
          referenceType: "invoice",
          idempotencyKey: `pay_fail_${invoice.id}`,
          sendEmail: true,
          emailTemplate: "paymentFailed",
          emailData: {
            planName: user.plan || "Current Plan",
            billingUrl: `/dashboard/${user.role === "recruiter" ? "recruiter" : "seeker"}/billing`,
          },
        }).catch((err) => console.error("[Payments] Payment failed notification error:", err.message));
      }
      break;
    }

    default:
      // Ignore unhandled event types cleanly
      break;
  }

  res.status(200).json({ received: true });
}));

// GET /api/payments - Payment history (Owner or Admin only)
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const { role, status } = req.query;
  const filter = {};
  const isAdmin = (req.user.role || "").toLowerCase() === "admin";

  if (isAdmin) {
    if (req.query.userEmail) filter.userEmail = new RegExp(`^${req.query.userEmail}$`, "i");
  } else {
    // Non-admins can only see their own payment history
    filter.userEmail = new RegExp(`^${req.user.email}$`, "i");
  }

  if (role) filter.role = role;
  if (status) filter.status = status;

  const payments = await getDb().collection("payments").find(filter).sort({ createdAt: -1 }).toArray();
  res.json(payments);
}));

// POST /api/payments - Record payment (Admin only or backwards-compatible test recordings)
router.post("/", requireAuth, asyncHandler(async (req, res) => {
  const required = ["plan", "amount", "transactionId"];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return badRequest(res, `Missing required fields: ${missing.join(", ")}`);

  const isAdmin = (req.user.role || "").toLowerCase() === "admin";
  const userEmail = isAdmin && req.body.userEmail ? req.body.userEmail.toLowerCase() : req.user.email.toLowerCase();

  const payment = {
    ...req.body,
    userEmail,
    role: req.user.role,
    status: req.body.status || "paid",
    createdAt: new Date(),
  };

  const result = await getDb().collection("payments").insertOne(payment);
  created(res, { ...payment, _id: result.insertedId });
}));

export default router;