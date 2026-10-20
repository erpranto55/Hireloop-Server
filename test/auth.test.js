import test from "node:test";
import assert from "node:assert/strict";
import { extractSessionToken, sanitizeUser, requireRole } from "../src/middleware/auth.js";
import { rateLimiter } from "../src/middleware/rateLimiter.js";

test("extractSessionToken parses Bearer header", () => {
  const req = {
    headers: {
      authorization: "Bearer test-token-12345",
    },
  };
  assert.equal(extractSessionToken(req), "test-token-12345");
});

test("extractSessionToken parses standard cookie", () => {
  const req = {
    headers: {
      cookie: "other_cookie=value; better-auth.session_token=cookie-token-abc; foo=bar",
    },
  };
  assert.equal(extractSessionToken(req), "cookie-token-abc");
});

test("extractSessionToken parses signed cookie and strips signature", () => {
  const req = {
    headers: {
      cookie: "better-auth.session_token=signed-token-xyz.b29ydGFsX3NpZ25hdHVyZQ; path=/",
    },
  };
  assert.equal(extractSessionToken(req), "signed-token-xyz");
});

test("extractSessionToken parses __Secure- cookie prefix", () => {
  const req = {
    headers: {
      cookie: "__Secure-better-auth.session_token=secure-token-999.sig; path=/",
    },
  };
  assert.equal(extractSessionToken(req), "secure-token-999");
});

test("extractSessionToken returns null if header or cookie missing", () => {
  assert.equal(extractSessionToken({ headers: {} }), null);
  assert.equal(extractSessionToken({ headers: { cookie: "other=123" } }), null);
});

test("sanitizeUser strips password and preserves safe fields", () => {
  const user = {
    _id: "u123",
    email: "user@test.com",
    name: "Test User",
    role: "seeker",
    password: "argon2-or-scrypt-hash",
  };
  const sanitized = sanitizeUser(user);
  assert.equal(sanitized.email, "user@test.com");
  assert.equal(sanitized.password, undefined);
  assert.equal("password" in sanitized, false);
});

test("requireRole enforces role boundaries", () => {
  const adminMiddleware = requireRole("admin");
  const seekerReq = { user: { role: "seeker", email: "seeker@test.com" } };
  const adminReq = { user: { role: "admin", email: "admin@test.com" } };

  let nextCalled = false;
  let status = null;
  let responseData = null;

  const mockRes = {
    status: (code) => {
      status = code;
      return {
        json: (data) => {
          responseData = data;
        },
      };
    },
  };

  // Seeker attempting admin operation -> 403
  adminMiddleware(seekerReq, mockRes, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(status, 403);
  assert.match(responseData.message, /Forbidden/i);

  // Admin performing admin operation -> next() called
  nextCalled = false;
  status = null;
  adminMiddleware(adminReq, mockRes, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(status, null);
});

test("rateLimiter rejects excessive requests with 429", () => {
  const limiter = rateLimiter({ windowMs: 1000, max: 2 });
  const req = { ip: "127.0.0.1", headers: {}, socket: {} };
  let status = null;
  const mockRes = {
    setHeader: () => {},
    status: (code) => {
      status = code;
      return { json: () => {} };
    },
  };

  let allowed = 0;
  const next = () => { allowed++; };

  limiter(req, mockRes, next);
  limiter(req, mockRes, next);
  limiter(req, mockRes, next);

  assert.equal(allowed, 2);
  assert.equal(status, 429);
});
