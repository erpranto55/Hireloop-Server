/**
 * Offline Message Digest Service for HireLoop
 * Periodically aggregates unread candidate-recruiter messages for users who have been
 * inactive and offline for >2 hours, sending a deduplicated digest email and in-app notification.
 */

import { getDb, toObjectId } from "../db.js";
import { isUserOfflineForDuration } from "./presenceService.js";
import { createNotification } from "./notificationService.js";

const DIGEST_COOLDOWN_MS = 4 * 60 * 60 * 1000; // Minimum 4 hours between digests for the same user
const OFFLINE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours offline threshold

/**
 * Finds all offline users with unread messages and generates a consolidated digest.
 * Returns the count of digests sent.
 */
export async function processOfflineDigests() {
  let db;
  try {
    db = getDb();
  } catch {
    return 0;
  }

  // 1. Find all distinct unread messages: readAt is null
  const unreadMessages = await db.collection("messages").find({
    readAt: null,
  }).toArray();

  if (!unreadMessages.length) {
    return 0;
  }

  // 2. Map conversation details to know who the recipient is
  const conversationIds = [...new Set(unreadMessages.map((m) => m.conversationId))];
  const convObjectIds = conversationIds.map((id) => toObjectId(id)).filter(Boolean);

  const conversations = await db.collection("conversations").find({
    _id: { $in: convObjectIds },
  }).toArray();

  const convMap = new Map();
  conversations.forEach((c) => {
    convMap.set(c._id.toString(), c);
  });

  // 3. Group unread messages by recipient email
  // A message's recipient is the other participant in the conversation
  const unreadByRecipient = new Map(); // Map<recipientEmail, { messages: [], convs: Set, senders: Set, jobTitles: Set, role: string }>

  for (const msg of unreadMessages) {
    const conv = convMap.get(msg.conversationId);
    if (!conv) continue;

    const senderEmail = (msg.senderEmail || "").toLowerCase().trim();
    const recruiterEmail = (conv.recruiterEmail || "").toLowerCase().trim();
    const seekerEmail = (conv.seekerEmail || "").toLowerCase().trim();

    // Determine intended recipient
    let recipientEmail = "";
    let recipientRole = "seeker";

    if (senderEmail === recruiterEmail) {
      recipientEmail = seekerEmail;
      recipientRole = "seeker";
    } else if (senderEmail === seekerEmail) {
      recipientEmail = recruiterEmail;
      recipientRole = "recruiter";
    } else {
      // Message sender not in conversation, ignore
      continue;
    }

    if (!unreadByRecipient.has(recipientEmail)) {
      unreadByRecipient.set(recipientEmail, {
        messages: [],
        convIds: new Set(),
        senders: new Set(),
        jobTitles: new Set(),
        role: recipientRole,
      });
    }

    const group = unreadByRecipient.get(recipientEmail);
    group.messages.push(msg);
    group.convIds.add(msg.conversationId);
    if (msg.senderName) group.senders.add(msg.senderName);
    if (conv.jobTitle) group.jobTitles.add(conv.jobTitle);
  }

  let digestsSent = 0;
  const now = new Date();

  // 4. Process each recipient with pending unread messages
  for (const [recipientEmail, group] of unreadByRecipient.entries()) {
    // Check if user is inactive and offline for at least 2 hours
    const isOffline = await isUserOfflineForDuration(recipientEmail, OFFLINE_THRESHOLD_MS);
    if (!isOffline) {
      // User is currently online or active recently; real-time notifications/SSE handle this
      continue;
    }

    // Check user account status and digest cooldown in MongoDB
    const user = await db.collection("user").findOne(
      { email: recipientEmail },
      { projection: { status: 1, lastMessageDigestAt: 1, name: 1 } }
    );

    if (!user || user.status === "suspended") {
      continue;
    }

    // Check cooldown: do not send another digest if one was sent recently
    if (user.lastMessageDigestAt) {
      const elapsedSinceDigest = now.getTime() - new Date(user.lastMessageDigestAt).getTime();
      if (elapsedSinceDigest < DIGEST_COOLDOWN_MS) {
        continue;
      }

      // Check if all unread messages arrived BEFORE the last digest was sent
      const newestUnreadDate = group.messages.reduce((max, m) => {
        const d = new Date(m.createdAt).getTime();
        return d > max ? d : max;
      }, 0);

      if (newestUnreadDate <= new Date(user.lastMessageDigestAt).getTime()) {
        // No new unread messages arrived since the last digest
        continue;
      }
    }

    // Atomically update user's lastMessageDigestAt to claim this digest batch and prevent concurrent duplicate sends
    const claimUpdate = await db.collection("user").findOneAndUpdate(
      {
        email: recipientEmail,
        $or: [
          { lastMessageDigestAt: null },
          { lastMessageDigestAt: { $lte: new Date(now.getTime() - DIGEST_COOLDOWN_MS) } },
        ],
      },
      {
        $set: {
          lastMessageDigestAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: "after" }
    );

    if (!claimUpdate) {
      // Another worker or process already claimed/sent a digest for this user
      continue;
    }

    // Generate and send digest
    const unreadCount = group.messages.length;
    const sendersList = [...group.senders];
    const jobsList = [...group.jobTitles];
    const inboxUrl = `/dashboard/${group.role === "recruiter" ? "recruiter" : "seeker"}/messages`;

    const digestBatchId = `digest_${recipientEmail}_${now.getTime()}`;

    try {
      // 1. In-App Notification
      await createNotification({
        recipientEmail,
        role: group.role,
        type: "unread_messages_digest",
        title: `Unread Messages: ${unreadCount} new message${unreadCount > 1 ? "s" : ""}`,
        message: `You have ${unreadCount} unread message${unreadCount > 1 ? "s" : ""} from ${sendersList.slice(0, 2).join(", ") || "the hiring team"} while you were away.`,
        link: inboxUrl,
        referenceId: [...group.convIds][0] || "",
        referenceType: "conversation",
        idempotencyKey: `notif_${digestBatchId}`,
        sendEmail: true,
        emailTemplate: "offlineMessageDigest",
        emailData: {
          recipientName: user.name || (group.role === "recruiter" ? "Recruiter" : "Candidate"),
          unreadCount,
          senders: sendersList,
          jobTitles: jobsList,
          inboxUrl,
        },
      });

      // 2. Record digest delivery log
      await db.collection("digest_deliveries").insertOne({
        recipientEmail,
        recipientRole: group.role,
        unreadCount,
        senders: sendersList,
        jobTitles: jobsList,
        deliveredAt: now,
        batchId: digestBatchId,
      });

      digestsSent++;
    } catch (err) {
      console.error(`[DigestService] Failed to send digest to ${recipientEmail}:`, err.message);
    }
  }

  return digestsSent;
}
