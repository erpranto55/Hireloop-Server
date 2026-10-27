import test from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  SUPPORTED_ADMIN_ROLES,
  resolveAdminRole,
  getEffectivePermissions,
  hasPermission,
  requirePermission,
} from "../src/services/permissionService.js";
import { sanitizeUser } from "../src/middleware/auth.js";

test("SUPPORTED_ADMIN_ROLES contains all 4 enterprise administrative roles", () => {
  assert.equal(SUPPORTED_ADMIN_ROLES.length, 4);
  assert.ok(SUPPORTED_ADMIN_ROLES.includes(ADMIN_ROLES.SUPER_ADMIN));
  assert.ok(SUPPORTED_ADMIN_ROLES.includes(ADMIN_ROLES.SUPPORT_MODERATOR));
  assert.ok(SUPPORTED_ADMIN_ROLES.includes(ADMIN_ROLES.COMPLIANCE_OFFICER));
  assert.ok(SUPPORTED_ADMIN_ROLES.includes(ADMIN_ROLES.BILLING_ADMIN));
});

test("resolveAdminRole determines canonical role with legacy fallback", () => {
  // Non-admins
  assert.equal(resolveAdminRole(null), null);
  assert.equal(resolveAdminRole({ role: "seeker" }), null);
  assert.equal(resolveAdminRole({ role: "recruiter" }), null);

  // Explicit admin roles
  assert.equal(
    resolveAdminRole({ role: "admin", adminRole: "support_moderator" }),
    ADMIN_ROLES.SUPPORT_MODERATOR
  );
  assert.equal(
    resolveAdminRole({ role: "admin", adminRole: "compliance_officer" }),
    ADMIN_ROLES.COMPLIANCE_OFFICER
  );
  assert.equal(
    resolveAdminRole({ role: "admin", adminRole: "billing_admin" }),
    ADMIN_ROLES.BILLING_ADMIN
  );
  assert.equal(
    resolveAdminRole({ role: "admin", adminRole: "super_admin" }),
    ADMIN_ROLES.SUPER_ADMIN
  );

  // Backward compatibility & Least Privilege: legacy admin without explicit adminRole maps safely to support_moderator
  assert.equal(resolveAdminRole({ role: "admin" }), ADMIN_ROLES.SUPPORT_MODERATOR);
  assert.equal(resolveAdminRole({ role: "admin", adminRole: "" }), ADMIN_ROLES.SUPPORT_MODERATOR);
  assert.equal(resolveAdminRole({ role: "admin", adminRole: "unknown_role" }), ADMIN_ROLES.SUPPORT_MODERATOR);
});

test("getEffectivePermissions enforces least-privilege matrix boundaries", () => {
  const superAdmin = { role: "admin", adminRole: ADMIN_ROLES.SUPER_ADMIN };
  const moderator = { role: "admin", adminRole: ADMIN_ROLES.SUPPORT_MODERATOR };
  const compliance = { role: "admin", adminRole: ADMIN_ROLES.COMPLIANCE_OFFICER };
  const billing = { role: "admin", adminRole: ADMIN_ROLES.BILLING_ADMIN };
  const suspendedAdmin = { role: "admin", adminRole: ADMIN_ROLES.SUPER_ADMIN, status: "suspended" };

  // Suspended account loses all permissions immediately
  assert.deepEqual(getEffectivePermissions(suspendedAdmin), []);

  // Super admin has full permissions
  const superPerms = getEffectivePermissions(superAdmin);
  assert.ok(superPerms.includes(PERMISSIONS.ADMIN_MANAGE_ROLES));
  assert.ok(superPerms.includes(PERMISSIONS.ANNOUNCEMENTS_CREATE));
  assert.ok(superPerms.includes(PERMISSIONS.AUDIT_EXPORT));
  assert.ok(superPerms.includes(PERMISSIONS.BILLING_ENTITLEMENTS));

  // Support moderator has reports and moderation, but NOT audit export or billing or announcements
  const modPerms = getEffectivePermissions(moderator);
  assert.ok(modPerms.includes(PERMISSIONS.REPORTS_READ));
  assert.ok(modPerms.includes(PERMISSIONS.REPORTS_WRITE));
  assert.ok(modPerms.includes(PERMISSIONS.MODERATION_JOBS));
  assert.ok(!modPerms.includes(PERMISSIONS.AUDIT_EXPORT));
  assert.ok(!modPerms.includes(PERMISSIONS.BILLING_READ));
  assert.ok(!modPerms.includes(PERMISSIONS.BILLING_ENTITLEMENTS));
  assert.ok(!modPerms.includes(PERMISSIONS.ANNOUNCEMENTS_CREATE));
  assert.ok(!modPerms.includes(PERMISSIONS.ADMIN_MANAGE_ROLES));

  // Compliance officer has audit read/export, but NOT moderation write or role management
  const compPerms = getEffectivePermissions(compliance);
  assert.ok(compPerms.includes(PERMISSIONS.AUDIT_READ));
  assert.ok(compPerms.includes(PERMISSIONS.AUDIT_EXPORT));
  assert.ok(compPerms.includes(PERMISSIONS.REPORTS_READ));
  assert.ok(!compPerms.includes(PERMISSIONS.REPORTS_WRITE));
  assert.ok(!compPerms.includes(PERMISSIONS.MODERATION_JOBS));
  assert.ok(!compPerms.includes(PERMISSIONS.BILLING_ENTITLEMENTS));
  assert.ok(!compPerms.includes(PERMISSIONS.ADMIN_MANAGE_ROLES));

  // Billing admin has billing and billing audit, but NOT reports or announcements or general audit export
  const billPerms = getEffectivePermissions(billing);
  assert.ok(billPerms.includes(PERMISSIONS.BILLING_READ));
  assert.ok(billPerms.includes(PERMISSIONS.BILLING_WRITE));
  assert.ok(billPerms.includes(PERMISSIONS.BILLING_ENTITLEMENTS));
  assert.ok(billPerms.includes(PERMISSIONS.AUDIT_READ_BILLING));
  assert.ok(!billPerms.includes(PERMISSIONS.AUDIT_EXPORT));
  assert.ok(!billPerms.includes(PERMISSIONS.REPORTS_READ));
  assert.ok(!billPerms.includes(PERMISSIONS.MODERATION_JOBS));
  assert.ok(!billPerms.includes(PERMISSIONS.ADMIN_MANAGE_ROLES));
  assert.ok(!billPerms.includes(PERMISSIONS.ANNOUNCEMENTS_CREATE));
});

test("hasPermission returns true only for authorized capabilities", () => {
  const moderator = { role: "admin", adminRole: ADMIN_ROLES.SUPPORT_MODERATOR };
  const billingAdmin = { role: "admin", adminRole: ADMIN_ROLES.BILLING_ADMIN };

  assert.equal(hasPermission(moderator, PERMISSIONS.REPORTS_READ), true);
  assert.equal(hasPermission(moderator, PERMISSIONS.BILLING_READ), false);
  assert.equal(hasPermission(billingAdmin, PERMISSIONS.BILLING_READ), true);
  assert.equal(hasPermission(billingAdmin, PERMISSIONS.REPORTS_READ), false);
  assert.equal(hasPermission(null, PERMISSIONS.REPORTS_READ), false);
});

test("requirePermission middleware rejects unauthorized requests with 401 and 403", () => {
  const middleware = requirePermission(PERMISSIONS.ADMIN_MANAGE_ROLES);

  // Unauthenticated -> 401
  const reqUnauth = {};
  let statusUnauth = 0;
  let jsonUnauth = null;
  const resUnauth = {
    status: (code) => {
      statusUnauth = code;
      return { json: (data) => { jsonUnauth = data; } };
    },
  };
  middleware(reqUnauth, resUnauth, () => assert.fail("Should not call next"));
  assert.equal(statusUnauth, 401);

  // Suspended admin -> 403
  const reqSuspended = { user: { role: "admin", adminRole: "super_admin", status: "suspended" } };
  let statusSuspended = 0;
  const resSuspended = {
    status: (code) => {
      statusSuspended = code;
      return { json: () => {} };
    },
  };
  middleware(reqSuspended, resSuspended, () => assert.fail("Should not call next"));
  assert.equal(statusSuspended, 403);

  // Support moderator attempting role management -> 403
  const reqMod = { user: { role: "admin", adminRole: "support_moderator", status: "active" } };
  let statusMod = 0;
  const resMod = {
    status: (code) => {
      statusMod = code;
      return { json: () => {} };
    },
  };
  middleware(reqMod, resMod, () => assert.fail("Should not call next"));
  assert.equal(statusMod, 403);

  // Super admin -> calls next()
  const reqSuper = { user: { role: "admin", adminRole: "super_admin", status: "active" } };
  let nextCalled = false;
  middleware(reqSuper, {}, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test("sanitizeUser enriches admin profile with adminRole and permissions", () => {
  const adminDoc = {
    _id: "123",
    name: "Admin User",
    email: "admin@example.com",
    role: "admin",
    adminRole: ADMIN_ROLES.COMPLIANCE_OFFICER,
    password: "secret_hash_value",
  };

  const sanitized = sanitizeUser(adminDoc);
  assert.equal(sanitized.password, undefined);
  assert.equal(sanitized.adminRole, ADMIN_ROLES.COMPLIANCE_OFFICER);
  assert.ok(Array.isArray(sanitized.permissions));
  assert.ok(sanitized.permissions.includes(PERMISSIONS.AUDIT_READ));
  assert.ok(!sanitized.permissions.includes(PERMISSIONS.ADMIN_MANAGE_ROLES));
});

test("Negative Tests: Role-specific restrictions are strictly enforced", () => {
  const moderator = { role: "admin", adminRole: ADMIN_ROLES.SUPPORT_MODERATOR, status: "active" };
  const billingAdmin = { role: "admin", adminRole: ADMIN_ROLES.BILLING_ADMIN, status: "active" };
  const complianceOfficer = { role: "admin", adminRole: ADMIN_ROLES.COMPLIANCE_OFFICER, status: "active" };
  const seeker = { role: "seeker", status: "active" };
  const recruiter = { role: "recruiter", status: "active" };

  // 1. Support moderator attempting billing operations
  assert.equal(hasPermission(moderator, PERMISSIONS.BILLING_READ), false);
  assert.equal(hasPermission(moderator, PERMISSIONS.BILLING_WRITE), false);
  assert.equal(hasPermission(moderator, PERMISSIONS.BILLING_ENTITLEMENTS), false);

  // 2. Billing administrator attempting user suspension or content moderation
  assert.equal(hasPermission(billingAdmin, PERMISSIONS.MODERATION_USERS), false);
  assert.equal(hasPermission(billingAdmin, PERMISSIONS.MODERATION_JOBS), false);
  assert.equal(hasPermission(billingAdmin, PERMISSIONS.REPORTS_READ), false);

  // 3. Compliance officer attempting role assignment or content modification
  assert.equal(hasPermission(complianceOfficer, PERMISSIONS.ADMIN_MANAGE_ROLES), false);
  assert.equal(hasPermission(complianceOfficer, PERMISSIONS.MODERATION_JOBS), false);
  assert.equal(hasPermission(complianceOfficer, PERMISSIONS.REPORTS_WRITE), false);

  // 4. Restricted administrators attempting announcement broadcasts
  assert.equal(hasPermission(moderator, PERMISSIONS.ANNOUNCEMENTS_CREATE), false);
  assert.equal(hasPermission(complianceOfficer, PERMISSIONS.ANNOUNCEMENTS_CREATE), false);
  assert.equal(hasPermission(billingAdmin, PERMISSIONS.ANNOUNCEMENTS_CREATE), false);

  // 5. Ordinary seeker/recruiter attempting administrative permissions
  assert.equal(hasPermission(seeker, PERMISSIONS.REPORTS_READ), false);
  assert.equal(hasPermission(seeker, PERMISSIONS.AUDIT_READ), false);
  assert.equal(hasPermission(recruiter, PERMISSIONS.ADMIN_MANAGE_ROLES), false);
  assert.equal(hasPermission(recruiter, PERMISSIONS.ANNOUNCEMENTS_CREATE), false);
});

