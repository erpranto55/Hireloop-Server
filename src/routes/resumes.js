import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getDb } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { badRequest, notFound } from "../utils/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, "../../uploads/resumes");

// Ensure upload directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// PDF magic bytes: %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
const PDF_MAGIC_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

export function isPdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.subarray(0, 5).equals(PDF_MAGIC_BYTES);
}

// Multer in-memory storage to validate magic bytes before touching disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB maximum
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".pdf") {
      return cb(new Error("Invalid file extension. Only .pdf files are accepted."));
    }
    cb(null, true);
  },
});

// POST /api/resumes/upload - Securely upload resume
router.post(
  "/upload",
  requireAuth,
  requireRole("seeker", "admin"),
  (req, res, next) => {
    upload.single("resume")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ message: "File exceeds the 5MB size limit." });
        }
        return res.status(400).json({ message: `Upload error: ${err.message}` });
      } else if (err) {
        return res.status(400).json({ message: err.message });
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return badRequest(res, "No resume file provided.");
    }

    // Inspect actual file content for PDF magic signature
    if (!isPdfBuffer(req.file.buffer)) {
      return badRequest(res, "Invalid file signature. File is not a valid PDF document.");
    }

    // Generate collision-resistant and traversal-safe filename
    const safeFileId = `${crypto.randomUUID()}.pdf`;
    const destinationPath = path.join(UPLOADS_DIR, safeFileId);

    // Save to disk
    await fs.promises.writeFile(destinationPath, req.file.buffer);

    // Save metadata in database
    const db = getDb();
    const resumeDoc = {
      fileId: safeFileId,
      originalName: path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_"),
      size: req.file.size,
      mimeType: "application/pdf",
      uploadedBy: req.user.email.toLowerCase(),
      createdAt: new Date(),
    };

    await db.collection("resumes").insertOne(resumeDoc);

    res.status(201).json({
      message: "Resume uploaded successfully",
      fileId: safeFileId,
      originalName: resumeDoc.originalName,
      url: `/api/resumes/${safeFileId}`,
    });
  })
);

// Shared authorization check for resume streaming and parsed data
async function isUserAuthorizedForResume(db, fileId, userEmail, userRole) {
  if (userRole === "admin") return true;

  // 1. Check direct uploader
  const resumeRecord = await db.collection("resumes").findOne({ fileId });
  if (resumeRecord && resumeRecord.uploadedBy === userEmail) {
    return true;
  }

  // 2. Check seeker applications
  const seekerApp = await db.collection("applications").findOne({
    seekerEmail: new RegExp(`^${userEmail}$`, "i"),
    $or: [
      { resumeUrl: { $regex: fileId, $options: "i" } },
      { resumeFileId: fileId },
    ],
  });
  if (seekerApp) return true;

  // 3. Check recruiter applications
  if (userRole === "recruiter") {
    const recruiterApp = await db.collection("applications").findOne({
      recruiterEmail: new RegExp(`^${userEmail}$`, "i"),
      $or: [
        { resumeUrl: { $regex: fileId, $options: "i" } },
        { resumeFileId: fileId },
      ],
    });
    if (recruiterApp) return true;
  }

  return false;
}

// GET /api/resumes/:fileId - Authorize and stream resume
router.get("/:fileId", requireAuth, asyncHandler(async (req, res) => {
  const { fileId } = req.params;

  // Strict filename validation to eliminate path traversal attacks
  if (!fileId || !/^[a-zA-Z0-9-]+\.pdf$/.test(fileId)) {
    return badRequest(res, "Invalid resume identifier");
  }

  const filePath = path.join(UPLOADS_DIR, fileId);
  if (!fs.existsSync(filePath)) {
    return notFound(res, "Resume file not found");
  }

  const userEmail = req.user.email.toLowerCase();
  const userRole = (req.user.role || "").toLowerCase();
  const db = getDb();

  const isAuthorized = await isUserAuthorizedForResume(db, fileId, userEmail, userRole);
  if (!isAuthorized) {
    return res.status(403).json({
      message: "Forbidden: You are not authorized to view this candidate resume.",
    });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fileId}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");

  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);
}));

// POST /api/resumes/:fileId/parse - Parse and extract structured data
router.post("/:fileId/parse", requireAuth, asyncHandler(async (req, res) => {
  const { fileId } = req.params;

  if (!fileId || !/^[a-zA-Z0-9-]+\.pdf$/.test(fileId)) {
    return badRequest(res, "Invalid resume identifier");
  }

  const userEmail = req.user.email.toLowerCase();
  const userRole = (req.user.role || "").toLowerCase();
  const db = getDb();

  const isAuthorized = await isUserAuthorizedForResume(db, fileId, userEmail, userRole);
  if (!isAuthorized) {
    return res.status(403).json({
      message: "Forbidden: You are not authorized to parse this resume.",
    });
  }

  const { parseAndSaveResume } = await import("../services/resumeParserService.js");
  const parsedDoc = await parseAndSaveResume(fileId, req.user);

  res.json({
    message: "Resume parsing completed",
    parsedResume: parsedDoc,
  });
}));

// GET /api/resumes/:fileId/parsed - Retrieve structured parsing results
router.get("/:fileId/parsed", requireAuth, asyncHandler(async (req, res) => {
  const { fileId } = req.params;

  if (!fileId || !/^[a-zA-Z0-9-]+\.pdf$/.test(fileId)) {
    return badRequest(res, "Invalid resume identifier");
  }

  const userEmail = req.user.email.toLowerCase();
  const userRole = (req.user.role || "").toLowerCase();
  const db = getDb();

  const isAuthorized = await isUserAuthorizedForResume(db, fileId, userEmail, userRole);
  if (!isAuthorized) {
    return res.status(403).json({
      message: "Forbidden: You are not authorized to access parsed data for this resume.",
    });
  }

  let parsedDoc = await db.collection("parsed_resumes").findOne({ fileId });

  // If not yet parsed, trigger parsing on-demand
  if (!parsedDoc) {
    const { parseAndSaveResume } = await import("../services/resumeParserService.js");
    parsedDoc = await parseAndSaveResume(fileId, req.user);
  }

  res.json(parsedDoc);
}));

export default router;
