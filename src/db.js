import { MongoClient, ObjectId } from "mongodb";
import { config } from "./config.js";
import { seedCompanies, seedJobs } from "./utils/seedData.js";

let client;
let db;

export async function connectToDatabase() {
  if (db) return db;

  client = new MongoClient(config.mongoUri);
  await client.connect();
  db = client.db(config.dbName);

  await Promise.all([
    db.collection("jobs").createIndex({ title: "text", companyName: "text", category: "text" }),
    db.collection("jobs").createIndex({ recruiterEmail: 1, status: 1 }),
    db.collection("companies").createIndex({ recruiterEmail: 1 }, { unique: true }),
    db.collection("companies").createIndex({ status: 1, industry: 1 }),
    db.collection("applications").createIndex({ seekerEmail: 1, jobId: 1 }, { unique: true }),
    db.collection("savedJobs").createIndex({ seekerEmail: 1, jobId: 1 }, { unique: true }),
    db.collection("payments").createIndex({ userEmail: 1, createdAt: -1 }),
    db.collection("subscriptions").createIndex({ userEmail: 1 }),
    db.collection("subscriptions").createIndex({ stripeSubscriptionId: 1 }, { sparse: true }),
    db.collection("webhook_events").createIndex({ eventId: 1 }, { unique: true }),
    db.collection("notifications").createIndex({ recipientEmail: 1, createdAt: -1 }),
    db.collection("notifications").createIndex({ recipientEmail: 1, read: 1 }),
    db.collection("notifications").createIndex({ recipientEmail: 1, idempotencyKey: 1 }, { unique: true, sparse: true }),
    db.collection("email_outbox").createIndex({ status: 1, nextAttemptAt: 1 }),
    db.collection("email_outbox").createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true }),
    db.collection("job_views").createIndex({ jobId: 1, viewedAt: -1 }),
    db.collection("job_views").createIndex({ recruiterEmail: 1, viewedAt: -1 }),
    db.collection("job_views").createIndex({ jobId: 1, viewerKey: 1, viewedAt: -1 }),
    db.collection("audit_logs").createIndex({ timestamp: -1 }),
    db.collection("audit_logs").createIndex({ action: 1, timestamp: -1 }),
    db.collection("audit_logs").createIndex({ targetType: 1, targetId: 1 }),
    db.collection("audit_logs").createIndex({ actorEmail: 1, timestamp: -1 }),
    db.collection("parsed_resumes").createIndex({ fileId: 1 }, { unique: true }),
    db.collection("parsed_resumes").createIndex({ seekerEmail: 1 }),
    db.collection("parsed_resumes").createIndex({ status: 1 }),
    db.collection("interviews").createIndex({ applicationId: 1, createdAt: -1 }),
    db.collection("interviews").createIndex({ recruiterEmail: 1, scheduledAt: 1 }),
    db.collection("interviews").createIndex({ seekerEmail: 1, scheduledAt: 1 }),
    db.collection("interviews").createIndex({ status: 1 }),
    db.collection("applications").createIndex({ recruiterEmail: 1, appliedAt: -1 }),
    db.collection("conversations").createIndex({ applicationId: 1 }, { unique: true }),
    db.collection("conversations").createIndex({ recruiterEmail: 1, updatedAt: -1 }),
    db.collection("conversations").createIndex({ seekerEmail: 1, updatedAt: -1 }),
    db.collection("messages").createIndex({ conversationId: 1, createdAt: 1 }),
    db.collection("messages").createIndex({ conversationId: 1, readAt: 1 }),
    db.collection("messages").createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true }),
    db.collection("scheduled_reminders").createIndex({ status: 1, dueAt: 1 }),
    db.collection("scheduled_reminders").createIndex({ interviewId: 1, status: 1 }),
    db.collection("scheduled_reminders").createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true }),
    db.collection("user").createIndex({ email: 1 }),
    db.collection("user").createIndex({ lastActiveAt: 1 }),
    db.collection("push_subscriptions").createIndex({ userEmail: 1 }),
    db.collection("push_subscriptions").createIndex({ endpoint: 1 }, { unique: true }),
    db.collection("unsubscribe_tokens").createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection("unsubscribe_tokens").createIndex({ userEmail: 1 }),
    db.collection("unsubscribe_tokens").createIndex({ expiresAt: 1 }),
    db.collection("reports").createIndex({ status: 1, createdAt: -1 }),
    db.collection("reports").createIndex({ targetType: 1, targetId: 1 }),
    db.collection("reports").createIndex({ reporterEmail: 1, targetId: 1 }),
    db.collection("reports").createIndex({ createdAt: -1 }),
    db.collection("user").createIndex({ role: 1, adminRole: 1 }),
    db.collection("announcement_campaigns").createIndex({ createdAt: -1 }),
    db.collection("announcement_campaigns").createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true }),
    db.collection("company_memberships").createIndex({ companyId: 1, userEmail: 1 }, { unique: true }),
    db.collection("company_memberships").createIndex({ userEmail: 1, status: 1 }),
    db.collection("company_memberships").createIndex({ companyId: 1, status: 1 }),
    db.collection("company_invitations").createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection("company_invitations").createIndex({ companyId: 1, status: 1 }),
    db.collection("company_invitations").createIndex({ inviteeEmail: 1 }),
    db.collection("company_invitations").createIndex({ expiresAt: 1 }),
    db.collection("jobs").createIndex({ companyId: 1, status: 1 }),
    db.collection("jobs").createIndex({ assignedMemberEmails: 1 }),
    db.collection("audit_logs").createIndex({ companyId: 1, timestamp: -1 }),
    db.collection("scorecard_templates").createIndex({ companyId: 1, isActive: 1 }),
    db.collection("scorecard_templates").createIndex({ companyId: 1, jobId: 1, isActive: 1 }),
    db.collection("evaluations").createIndex({ applicationId: 1, evaluatorEmail: 1 }),
    db.collection("evaluations").createIndex({ applicationId: 1, status: 1 }),
    db.collection("evaluations").createIndex({ jobId: 1 }),
    db.collection("evaluations").createIndex({ companyId: 1 }),
    db.collection("pipeline_automation_rules").createIndex({ companyId: 1, isEnabled: 1 }),
    db.collection("pipeline_automation_rules").createIndex({ companyId: 1, trigger: 1, isEnabled: 1 }),
    db.collection("automation_execution_logs").createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true }),
    db.collection("automation_execution_logs").createIndex({ companyId: 1, claimedAt: -1 }),
    db.collection("automation_execution_logs").createIndex({ applicationId: 1 }),
  ]);

  // Ensure legacy admins have canonical adminRole
  try {
    const { migrateLegacyAdmins } = await import("./services/permissionService.js");
    await migrateLegacyAdmins();
  } catch (err) {
    console.error("Admin role migration warning:", err.message);
  }

  // Idempotently ensure companies have active company_owner membership records
  try {
    const { migrateCompanyMemberships } = await import("./services/companyWorkspaceService.js");
    await migrateCompanyMemberships();
  } catch (err) {
    console.error("Company membership migration warning:", err.message);
  }

  // Seed companies
  const companiesCount = await db.collection("companies").countDocuments();
  if (companiesCount === 0) {
    console.log("Seeding companies database...");
    await db.collection("companies").insertMany(seedCompanies);
  }

  // Seed jobs
  const jobsCount = await db.collection("jobs").countDocuments();
  if (jobsCount === 0) {
    console.log("Seeding jobs database...");
    const dbCompanies = await db.collection("companies").find().toArray();
    const companyMap = {};
    dbCompanies.forEach((c) => {
      companyMap[c.name.toLowerCase()] = c._id.toString();
    });

    const jobsWithCompanyIds = seedJobs.map((job) => ({
      ...job,
      companyId: companyMap[job.companyName.toLowerCase()] || "unknown",
    }));

    await db.collection("jobs").insertMany(jobsWithCompanyIds);
  }

  return db;
}

export function getDb() {
  if (!db) {
    throw new Error("Database is not connected yet");
  }

  return db;
}

export function toObjectId(id) {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

export async function closeDatabase() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}