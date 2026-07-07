import { MongoClient, ObjectId } from "mongodb";
import { config } from "./config.js";

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