import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_TARGET_TYPES,
  SUPPORTED_CATEGORIES,
  REPORT_STATUSES,
  MODERATION_ACTIONS,
} from "../src/services/reportService.js";
import { sanitizeCsvCell } from "../src/services/auditService.js";
import { SUPPORTED_AUDIENCES } from "../src/services/announcementService.js";

// -------------------------------------------------------------
// 1. Report Models and Validation
// -------------------------------------------------------------
test("SUPPORTED_TARGET_TYPES contains standard platform entities", () => {
  assert.equal(SUPPORTED_TARGET_TYPES.includes("job"), true);
  assert.equal(SUPPORTED_TARGET_TYPES.includes("company"), true);
  assert.equal(SUPPORTED_TARGET_TYPES.includes("user"), true);
  assert.equal(SUPPORTED_TARGET_TYPES.includes("message"), true);
});

test("SUPPORTED_CATEGORIES covers abusive, fraudulent, and impersonation cases", () => {
  assert.equal(SUPPORTED_CATEGORIES.includes("fraudulent_job"), true);
  assert.equal(SUPPORTED_CATEGORIES.includes("company_impersonation"), true);
  assert.equal(SUPPORTED_CATEGORIES.includes("abusive_behavior"), true);
  assert.equal(SUPPORTED_CATEGORIES.includes("inappropriate_message"), true);
  assert.equal(SUPPORTED_CATEGORIES.includes("policy_violation"), true);
});

test("REPORT_STATUSES follows standard moderation lifecycle", () => {
  assert.deepEqual(REPORT_STATUSES, ["pending", "in_review", "resolved", "dismissed"]);
});

test("MODERATION_ACTIONS contains all supported actions", () => {
  assert.equal(MODERATION_ACTIONS.includes("suspend_user"), true);
  assert.equal(MODERATION_ACTIONS.includes("close_job"), true);
  assert.equal(MODERATION_ACTIONS.includes("reject_company"), true);
  assert.equal(MODERATION_ACTIONS.includes("warn_user"), true);
  assert.equal(MODERATION_ACTIONS.includes("dismiss_report"), true);
});

// -------------------------------------------------------------
// 2. Audit Export & CSV Formula Injection Protection
// -------------------------------------------------------------
test("sanitizeCsvCell neutralizes spreadsheet formula injection risks", () => {
  // Cells starting with dangerous formula characters must be prefixed with a single quote
  assert.equal(sanitizeCsvCell("=SUM(A1:A10)").startsWith("'=SUM"), true);
  assert.equal(sanitizeCsvCell("+cmd|' /C calc'!A0").startsWith("'+cmd"), true);
  assert.equal(sanitizeCsvCell("-5+5").startsWith("'-5+5"), true);
  assert.equal(sanitizeCsvCell("@malicious.com").startsWith("'@malicious"), true);
  assert.equal(sanitizeCsvCell("\tTAB_INJECT").startsWith("'\tTAB"), true);
  assert.equal(sanitizeCsvCell("\rRETURN_INJECT").includes("'\rRETURN"), true);
});

test("sanitizeCsvCell handles commas, quotes, and standard text safely", () => {
  assert.equal(sanitizeCsvCell("Standard Text"), "Standard Text");
  // Commas require double quote wrapping
  assert.equal(sanitizeCsvCell("Item, with comma"), '"Item, with comma"');
  // Internal double quotes must be doubled
  assert.equal(sanitizeCsvCell('Text with "quotes"'), '"Text with ""quotes"""');
  // Null or undefined returns empty string
  assert.equal(sanitizeCsvCell(null), "");
  assert.equal(sanitizeCsvCell(undefined), "");
});

// -------------------------------------------------------------
// 3. Platform Announcement Audiences
// -------------------------------------------------------------
test("SUPPORTED_AUDIENCES restricts broadcast recipients to safe scopes", () => {
  assert.equal(SUPPORTED_AUDIENCES.includes("all"), true);
  assert.equal(SUPPORTED_AUDIENCES.includes("seekers"), true);
  assert.equal(SUPPORTED_AUDIENCES.includes("recruiters"), true);
  assert.equal(SUPPORTED_AUDIENCES.includes("selected_users"), true);
});
