// twilioSignature.js — P0-1: authenticate inbound Twilio webhooks
//
// Twilio signs every webhook with HMAC-SHA1 over (URL + sorted POST params),
// delivered in the `X-Twilio-Signature` header. Without verifying it, anyone who
// knows the /sms URL can forge inbound texts: burn Claude/Twilio spend, opt real
// numbers out via "STOP", or inject prompt content. This module verifies the
// signature and lets legitimate non-Twilio callers (the test harness and the
// in-app UI/console) through unchanged.
//
// Design: the decision is a pure function (evaluateTwilioRequest) so every branch
// is unit-testable without a live server or network. The Express middleware is a
// thin wrapper that reads env + request and applies the decision.

import twilio from "twilio";

// Pure allow/deny decision for an inbound webhook request.
// Returns { allow, validated, reason }. `validator` is injectable for tests;
// in production it defaults to Twilio's own validateRequest (HMAC check).
//
// Bypass order (each short-circuits):
//   1. testMode          — local test suite posts without signatures
//   2. isUi              — in-app console / web chat posts (authenticated by UI key)
//   3. validateDisabled  — ops escape hatch (TWILIO_VALIDATE=false) if a deploy
//                          mismatches the signed URL; lets you disable without code
//   4. no authToken      — dev box without Twilio creds; warn + allow
// Then: require a signature and verify it.
export function evaluateTwilioRequest({
  testMode = false,
  isUi = false,
  validateDisabled = false,
  authToken = null,
  signature = null,
  url = "",
  params = {},
  validator = twilio.validateRequest,
} = {}) {
  if (testMode)         return { allow: true,  validated: false, reason: "test_mode" };
  if (isUi)             return { allow: true,  validated: false, reason: "ui_request" };
  if (validateDisabled) return { allow: true,  validated: false, reason: "validation_disabled" };
  if (!authToken)       return { allow: true,  validated: false, reason: "no_auth_token" };
  if (!signature)       return { allow: false, validated: false, reason: "missing_signature" };

  let ok = false;
  try {
    ok = !!validator(authToken, signature, url, params ?? {});
  } catch {
    ok = false;
  }
  return { allow: ok, validated: true, reason: ok ? "valid_signature" : "invalid_signature" };
}

// Reconstruct the absolute URL Twilio signed. Prefer PUBLIC_BASE_URL to avoid
// proxy/host ambiguity behind Railway; otherwise use the proxy-aware protocol +
// host + original path (requires app.set("trust proxy", 1), which index.js sets).
export function buildWebhookUrl(req, baseUrl = process.env.PUBLIC_BASE_URL) {
  if (baseUrl) return `${String(baseUrl).replace(/\/$/, "")}${req.originalUrl}`;
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

// Express middleware factory. `isUiReq` is injected (lives in index.js) so this
// module has no circular dependency on the server.
export function makeTwilioSignatureMiddleware({ isUiReq }) {
  return function validateTwilioSignature(req, res, next) {
    const decision = evaluateTwilioRequest({
      testMode:         process.env.TEST_MODE === "true",
      isUi:             typeof isUiReq === "function" ? isUiReq(req) : false,
      validateDisabled: process.env.TWILIO_VALIDATE === "false",
      authToken:        process.env.TWILIO_AUTH_TOKEN,
      signature:        req.header("X-Twilio-Signature"),
      url:              buildWebhookUrl(req),
      params:           req.body,
    });

    if (decision.allow) {
      if (decision.reason === "no_auth_token") {
        console.warn("[SECURITY] TWILIO_AUTH_TOKEN unset — /sms signature validation skipped");
      }
      return next();
    }

    console.warn(`[SECURITY] Rejected inbound webhook (${decision.reason}) ip=${req.ip} path=${req.originalUrl}`);
    res.set("Content-Type", "text/xml");
    return res.status(403).send("<Response></Response>");
  };
}
