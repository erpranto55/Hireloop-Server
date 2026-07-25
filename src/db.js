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
  ]);

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