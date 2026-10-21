/**
 * Resume Parsing Service for HireLoop
 * Extracts structured candidate information from authorized PDF resumes.
 * Note: Extraction is treated as unverified document extraction, not ground truth.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { getDb } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, "../../uploads/resumes");

// Standard dictionary of tech and professional skills for deterministic extraction
const KNOWN_SKILLS = [
  "JavaScript", "TypeScript", "Python", "Java", "C++", "C#", "Go", "Golang", "Rust", "PHP", "Ruby", "Swift", "Kotlin",
  "React", "Next.js", "Vue.js", "Angular", "Node.js", "Express", "NestJS", "Django", "Flask", "FastAPI", "Spring Boot",
  "HTML5", "CSS3", "Tailwind CSS", "SASS", "Bootstrap", "Redux", "Zustand", "GraphQL", "REST API",
  "PostgreSQL", "MySQL", "MongoDB", "Redis", "SQLite", "DynamoDB", "Elasticsearch", "Prisma", "Mongoose",
  "Docker", "Kubernetes", "AWS", "Amazon Web Services", "Azure", "Google Cloud", "GCP", "Terraform", "CI/CD", "Git", "GitHub", "GitLab",
  "Linux", "Nginx", "Microservices", "Serverless", "Kafka", "RabbitMQ", "WebSockets", "Jest", "Cypress", "Playwright",
  "Figma", "UI/UX Design", "Agile", "Scrum", "Jira", "System Architecture", "Machine Learning", "TensorFlow", "PyTorch"
];

const JOB_TITLE_KEYWORDS = [
  "Software Engineer", "Full Stack Developer", "Frontend Developer", "Backend Developer",
  "DevOps Engineer", "Cloud Architect", "Product Manager", "Project Manager", "Data Scientist",
  "Data Engineer", "UI/UX Designer", "Product Designer", "QA Engineer", "Mobile Developer",
  "Engineering Manager", "Technical Lead", "Solutions Architect", "Systems Administrator"
];

const EDUCATION_KEYWORDS = [
  "Bachelor of Science", "Bachelor of Arts", "B.S.", "B.A.", "B.Tech", "Bachelor",
  "Master of Science", "Master of Arts", "M.S.", "M.A.", "M.Tech", "Master",
  "Doctor of Philosophy", "Ph.D.", "Associate Degree", "Diploma", "High School"
];

/**
 * Extracts plain text from a stored PDF resume safely.
 */
export async function extractTextFromPdf(fileId) {
  // Validate file identifier format to prevent directory traversal
  if (!fileId || !/^[a-zA-Z0-9-]+\.pdf$/.test(fileId)) {
    throw new Error("Invalid resume file identifier.");
  }

  const filePath = path.join(UPLOADS_DIR, fileId);
  if (!fs.existsSync(filePath)) {
    throw new Error("Resume file not found on disk.");
  }

  const fileBuffer = await fs.promises.readFile(filePath);

  // Validate PDF magic bytes: %PDF-
  if (fileBuffer.length < 5 || fileBuffer.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error("Invalid PDF header signature.");
  }

  try {
    const parser = new PDFParse({ data: fileBuffer });
    await parser.load();
    const result = await parser.getText();
    return typeof result?.text === "string" ? result.text : "";
  } catch (err) {
    // Graceful handling for encrypted, image-only, or corrupted PDFs
    throw new Error(`PDF extraction failed: ${err.message || "Unreadable or scanned document"}`);
  }
}

/**
 * Parses raw resume text into structured fields using deterministic heuristics.
 */
export function extractStructuredData(rawText = "") {
  if (!rawText || !rawText.trim()) {
    return {
      status: "failed",
      error: "Document appears to be an image scan or contains no extractable text.",
      data: null,
    };
  }

  const cleanText = rawText.replace(/\r\n/g, "\n").trim();
  const lines = cleanText.split("\n").map((l) => l.trim()).filter(Boolean);

  // 1. Contact Information
  const emailMatch = cleanText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i);
  const email = emailMatch ? emailMatch[0].toLowerCase() : null;

  const phoneMatch = cleanText.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  const phone = phoneMatch ? phoneMatch[0].trim() : null;

  // 2. Candidate Name (heuristic: inspect first 5 lines for capital words, excluding keywords)
  let candidateName = null;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i];
    if (
      line.length >= 3 &&
      line.length <= 40 &&
      !line.includes("@") &&
      !line.includes("http") &&
      !line.includes("Resume") &&
      !line.includes("Curriculum") &&
      /^[A-Z][a-zA-Z'.]+(?:\s+[A-Z][a-zA-Z'.]+)+$/.test(line)
    ) {
      candidateName = line;
      break;
    }
  }

  // 3. Skills Extraction (case-insensitive dictionary matching)
  const detectedSkills = [];
  const lowerText = cleanText.toLowerCase();

  for (const skill of KNOWN_SKILLS) {
    const regex = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (regex.test(cleanText)) {
      detectedSkills.push(skill);
    }
  }

  // 4. Job Titles / Experience Keywords
  const detectedRoles = [];
  for (const role of JOB_TITLE_KEYWORDS) {
    if (lowerText.includes(role.toLowerCase())) {
      detectedRoles.push(role);
    }
  }

  // Date range detection (e.g. "2020 - 2024", "2021 - Present", "Jan 2019 - Present")
  const dateRanges = cleanText.match(/(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+)?\b(19\d\d|20\d\d)\b\s*[-–—to]+\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+)?(\b(19\d\d|20\d\d)\b|Present|Current)/gi) || [];

  // 5. Education Keywords
  const detectedEducation = [];
  for (const edu of EDUCATION_KEYWORDS) {
    if (lowerText.includes(edu.toLowerCase())) {
      detectedEducation.push(edu);
    }
  }

  // 6. Summary Extraction
  let summary = null;
  const summaryIdx = lines.findIndex((l) => /^(summary|professional summary|about me|profile)$/i.test(l));
  if (summaryIdx !== -1 && lines[summaryIdx + 1]) {
    summary = lines.slice(summaryIdx + 1, summaryIdx + 4).join(" ").slice(0, 300);
  } else if (lines.length > 2) {
    // Fallback: take a descriptive line that isn't a header or contact line
    const descriptiveLine = lines.find((l) => l.length > 50 && !l.includes("@") && !l.includes("http"));
    if (descriptiveLine) {
      summary = descriptiveLine.slice(0, 300);
    }
  }

  const isPartial = detectedSkills.length === 0 && detectedRoles.length === 0 && !email;
  const status = isPartial ? "partial" : "parsed";

  return {
    status,
    data: {
      candidateName,
      email,
      phone,
      skills: detectedSkills,
      roles: detectedRoles,
      dateRanges: dateRanges.slice(0, 5),
      education: detectedEducation,
      summary,
      rawTextSnippet: cleanText.slice(0, 500),
    },
    disclaimer: "Extracted via automated document parsing. Information may be incomplete and has not been independently verified.",
  };
}

/**
 * Parses and persists structured resume data for a specific resume file.
 */
export async function parseAndSaveResume(fileId, user) {
  const db = getDb();

  // Check if already parsed
  const existing = await db.collection("parsed_resumes").findOne({ fileId });
  if (existing && existing.status === "parsed") {
    return existing;
  }

  let rawText = "";
  let extractionResult;

  try {
    rawText = await extractTextFromPdf(fileId);
    extractionResult = extractStructuredData(rawText);
  } catch (err) {
    extractionResult = {
      status: "failed",
      error: err.message,
      data: null,
      disclaimer: "Automated text extraction was unable to parse this document.",
    };
  }

  const parsedDoc = {
    fileId,
    seekerEmail: user?.email ? user.email.toLowerCase() : "unknown",
    status: extractionResult.status,
    parsedAt: new Date(),
    rawTextLength: rawText.length,
    data: extractionResult.data,
    error: extractionResult.error || null,
    disclaimer: extractionResult.disclaimer,
    isAutomatedExtraction: true,
  };

  await db.collection("parsed_resumes").updateOne(
    { fileId },
    { $set: parsedDoc },
    { upsert: true }
  );

  return parsedDoc;
}
