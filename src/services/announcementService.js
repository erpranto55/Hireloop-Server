/**
 * Announcement Broadcast Service for HireLoop
 * Manages controlled platform-wide announcements, server-side audience resolution,
 * preference-aware channel dispatch, and campaign tracking.
 */

import { getDb } from "../db.js";
import { createNotification } from "./notificationService.js";
import { shouldDeliverEmail } from "./preferenceService.js";
import { recordAuditLog } from "./auditService.js";

export const SUPPORTED_AUDIENCES = ["all", "seekers", "recruiters", "selected_users"];

/**
 * Returns estimated recipient count for audience preview before broadcast dispatch.
 */
export async function getAudienceCount(audience, selectedEmails = []) {
  const db = getDb();
  const filter = { status: { $ne: "suspended" } };

  if (audience === "seekers") {
    filter.role = "seeker";
  } else if (audience === "recruiters") {
    filter.role = "recruiter";
  } else if (audience === "selected_users") {
    const normalized = (selectedEmails || []).map((e) => e.toLowerCase().trim());
    filter.email = { $in: normalized };
  }

  const count = await db.collection("user").countDocuments(filter);
  return { audience, count };
}

/**
 * Resolves list of eligible active recipient accounts strictly on the server.
 */
export async function resolveEligibleRecipients(audience, selectedEmails = []) {
  const db = getDb();
  const filter = { status: { $ne: "suspended" } };

  if (audience === "seekers") {
    filter.role = "seeker";
  } else if (audience === "recruiters") {
    filter.role = "recruiter";
  } else if (audience === "selected_users") {
    const normalized = (selectedEmails || []).map((e) => e.toLowerCase().trim());
    filter.email = { $in: normalized };
  }

  const users = await db.collection("user").find(
    filter,
    { projection: { email: 1, role: 1, name: 1, status: 1 } }
  ).toArray();

  return users;
}

/**
 * Creates and dispatches an announcement campaign in bounded batches.
 */
export async function dispatchAnnouncementCampaign(adminUser, {
  title,
  message,
  audience = "all",
  selectedEmails = [],
  channels = ["in_app"],
  campaignId = null,
  idempotencyKey = null,
}) {
  if (!adminUser || (adminUser.role || "").toLowerCase() !== "admin") {
    throw new Error("Forbidden: Administrator privileges required to dispatch announcements.");
  }

  if (!title || typeof title !== "string" || title.trim().length === 0) {
    throw new Error("Announcement title is required.");
  }

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    throw new Error("Announcement message is required.");
  }

  if (!SUPPORTED_AUDIENCES.includes(audience)) {
    throw new Error(`Invalid audience. Allowed: ${SUPPORTED_AUDIENCES.join(", ")}`);
  }

  const db = getDb();

  // Idempotency check
  if (idempotencyKey) {
    const existing = await db.collection("announcement_campaigns").findOne({ idempotencyKey });
    if (existing) {
      return existing;
    }
  }

  // Server-side audience resolution (excluding suspended users)
  const recipients = await resolveEligibleRecipients(audience, selectedEmails);
  const recipientCount = recipients.length;

  const resolvedCampaignId = campaignId || `announcement_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const campaignDoc = {
    campaignId: resolvedCampaignId,
    idempotencyKey: idempotencyKey || null,
    title: title.trim(),
    message: message.trim(),
    audience,
    channels: Array.isArray(channels) ? channels : ["in_app"],
    recipientCount,
    deliveryStats: {
      queued: recipientCount,
      sentInApp: 0,
      sentEmail: 0,
      suppressedEmail: 0,
      failed: 0,
    },
    status: "processing", // "processing" | "completed" | "failed"
    createdBy: adminUser.email,
    createdAt: new Date(),
    completedAt: null,
  };

  const insertResult = await db.collection("announcement_campaigns").insertOne(campaignDoc);
  campaignDoc._id = insertResult.insertedId;

  // Process in bounded batches of 50 to avoid unbounded memory or event loop blocking
  const BATCH_SIZE = 50;
  const dispatchEmail = channels.includes("email");

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);

    await Promise.allSettled(
      batch.map(async (user) => {
        const userEmail = (user.email || "").toLowerCase().trim();
        const userRole = (user.role || "seeker").toLowerCase();

        try {
          // 1. In-App Notification (Always sent if in_app channel enabled)
          if (channels.includes("in_app")) {
            await createNotification({
              recipientEmail: userEmail,
              role: userRole,
              type: "platform_announcement",
              title: title.trim(),
              message: message.trim(),
              link: "/dashboard",
              referenceId: resolvedCampaignId,
              referenceType: "announcement",
              idempotencyKey: `notif_${resolvedCampaignId}_${userEmail}`,
              sendEmail: false, // Email handled explicitly below to respect preferences
            });
            campaignDoc.deliveryStats.sentInApp++;
          }

          // 2. Email Delivery (if requested, strictly respecting user preferences)
          if (dispatchEmail) {
            const prefCheck = await shouldDeliverEmail(userEmail, "applicationReceived"); // Uses general optional check
            if (prefCheck.deliver) {
              await createNotification({
                recipientEmail: userEmail,
                role: userRole,
                type: "platform_announcement_email",
                title: title.trim(),
                message: message.trim(),
                link: "/dashboard",
                idempotencyKey: `notif_email_${resolvedCampaignId}_${userEmail}`,
                sendEmail: true,
                emailTemplate: "applicationStatusChanged", // Reuses standard styled layout
                emailData: {
                  jobTitle: "Platform Announcement",
                  companyName: "HireLoop Team",
                  newStatus: title.trim(),
                  viewUrl: "/dashboard",
                },
              });
              campaignDoc.deliveryStats.sentEmail++;
            } else {
              campaignDoc.deliveryStats.suppressedEmail++;
            }
          }
        } catch (err) {
          console.error(`[AnnouncementService] Delivery error for ${userEmail}:`, err.message);
          campaignDoc.deliveryStats.failed++;
        }
      })
    );
  }

  campaignDoc.status = "completed";
  campaignDoc.completedAt = new Date();

  await db.collection("announcement_campaigns").updateOne(
    { _id: campaignDoc._id },
    {
      $set: {
        status: "completed",
        deliveryStats: campaignDoc.deliveryStats,
        completedAt: campaignDoc.completedAt,
        updatedAt: new Date(),
      },
    }
  );

  // Record audit log for broadcast action
  await recordAuditLog({
    actor: adminUser,
    action: "announcement_broadcast",
    targetType: "campaign",
    targetId: campaignDoc._id.toString(),
    targetIdentifier: title.trim(),
    outcome: "success",
    metadata: {
      campaignId: resolvedCampaignId,
      audience,
      recipientCount,
      deliveryStats: campaignDoc.deliveryStats,
    },
  });

  return campaignDoc;
}

/**
 * Lists past announcement campaigns.
 */
export async function listAnnouncementCampaigns({ page = 1, limit = 20 } = {}) {
  const db = getDb();
  const pageNum = Math.max(1, Number(page) || 1);
  const pageLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * pageLimit;

  const [campaigns, total] = await Promise.all([
    db.collection("announcement_campaigns")
      .find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageLimit)
      .toArray(),
    db.collection("announcement_campaigns").countDocuments({}),
  ]);

  return {
    campaigns,
    total,
    page: pageNum,
    limit: pageLimit,
    totalPages: Math.ceil(total / pageLimit) || 1,
  };
}
