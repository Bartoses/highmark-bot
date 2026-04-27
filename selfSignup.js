// ─────────────────────────────────────────────────────────────────────────────
// SELF-SERVE SIGNUP — Sprint 7
//
// Public signup flow:
//   1. POST /api/signup            (no auth, rate-limited)
//        → validate input
//        → create Supabase Auth user
//        → insert portal_users row (role=client_admin, client_id=null)
//        → insert onboarding_drafts row (status=processing, owner_auth_user_id=...)
//        → fire setImmediate(runOnboardingCrawl)
//        → notify team via SMS
//        → return { ok, email } so /signup page can call signInWithPassword
//
// After login, the user lands on /portal/onboarding which polls:
//   2. GET /portal/api/onboarding/status   (auth)
//        → returns { status, draft, warnings, confidence }
//
//   3. POST /portal/api/onboarding/approve (auth)
//        → wraps commitDraftToDb
//        → updates the portal_user.client_id to the new client
//        → notifies team that a new client went live
//        → returns { clientId, clientName, demoLink }
// ─────────────────────────────────────────────────────────────────────────────

import { startAutoConfig, commitDraftToDb, getDraft, buildNextSteps } from "./onboardingConfig.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEAM_NOTIFY_PHONE = "+17202892483"; // Highmark owner

// ── Validation ────────────────────────────────────────────────────────────────

function validateSignupBody(body) {
  const businessName = (body?.businessName ?? body?.business_name ?? "").trim();
  const websiteUrl   = (body?.websiteUrl   ?? body?.website_url   ?? "").trim();
  const email        = (body?.email        ?? "").trim().toLowerCase();
  const password     = body?.password ?? "";

  if (!businessName)            return { error: "Business name is required" };
  if (businessName.length > 100) return { error: "Business name is too long (max 100 chars)" };

  if (!websiteUrl) return { error: "Website URL is required" };
  // Reject any non-http(s) scheme up front; only prepend https:// if the input
  // is clearly schemeless (so "ftp://..." doesn't get re-prefixed into a
  // valid-but-wrong URL).
  if (/^[a-z][a-z0-9+.-]*:/i.test(websiteUrl) && !/^https?:/i.test(websiteUrl)) {
    return { error: "Website URL must start with https://" };
  }
  let normalizedUrl;
  try {
    const u = new URL(/^https?:/i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { error: "Website URL must start with https://" };
    }
    normalizedUrl = u.href;
  } catch {
    return { error: "Website URL is invalid" };
  }

  if (!email || !EMAIL_RE.test(email))    return { error: "Valid email is required" };
  if (!password || password.length < 8)   return { error: "Password must be at least 8 characters" };

  return { businessName, websiteUrl: normalizedUrl, email, password };
}

// ── Team notification (best-effort, non-blocking) ─────────────────────────────

function notifyTeam(twilioClient, message) {
  if (process.env.TEST_MODE === "true") return;
  if (!twilioClient) return;
  const from = process.env.TWILIO_PHONE_NUMBER || "+18668906657";
  twilioClient.messages
    .create({ body: message.slice(0, 320), from, to: TEAM_NOTIFY_PHONE })
    .catch((err) => console.error("[SIGNUP] Team SMS failed:", err.message));
}

// ── Background pipeline ───────────────────────────────────────────────────────

async function runOnboardingCrawl({ draftId, websiteUrl, anthropic, supabase, email }) {
  try {
    const result = await startAutoConfig(websiteUrl, anthropic, supabase, email);

    // startAutoConfig inserts a NEW draft row; we already have one (status=processing)
    // owned by this user. Copy the result fields onto the existing row and discard
    // the new one so /portal/onboarding/status finds a single owned draft.
    if (result.draftId && result.draftId !== draftId) {
      await supabase.from("onboarding_drafts")
        .update({
          status:           "draft",
          draft_client:     result.draft.draftClient,
          draft_bot:        result.draft.draftBot,
          draft_booking:    result.draft.draftBooking,
          extracted_facts:  result.extractedFacts,
          confidence:       result.confidence,
          warnings:         result.warnings,
          pages_crawled:    result.pagesCrawled,
          updated_at:       new Date().toISOString(),
        })
        .eq("id", draftId);

      // Drop the duplicate row created by startAutoConfig
      await supabase.from("onboarding_drafts")
        .delete()
        .eq("id", result.draftId);
    } else {
      // Failsafe path: just promote the placeholder
      await supabase.from("onboarding_drafts")
        .update({ status: "draft", updated_at: new Date().toISOString() })
        .eq("id", draftId);
    }

    console.log(`[SIGNUP] Onboarding crawl complete for ${email} (draft ${draftId})`);
  } catch (err) {
    console.error("[SIGNUP] Onboarding crawl failed:", err.message);
    await supabase.from("onboarding_drafts")
      .update({
        status:        "failed",
        error_message: err.message?.slice(0, 500) ?? "Unknown error",
        updated_at:    new Date().toISOString(),
      })
      .eq("id", draftId)
      .catch(() => {});
  }
}

// ── POST /api/signup ──────────────────────────────────────────────────────────

export async function handleSignup(req, res, supabase, anthropic, twilioClient) {
  if (!supabase) return res.status(503).json({ error: "Service unavailable" });

  const v = validateSignupBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  const { businessName, websiteUrl, email, password } = v;

  // Create Supabase Auth user (auto-confirm so they can sign in immediately)
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authErr) {
    const msg = authErr.message?.toLowerCase() ?? "";
    if (msg.includes("already") || msg.includes("exists") || msg.includes("registered")) {
      return res.status(409).json({ error: "An account with this email already exists. Try logging in instead." });
    }
    console.error("[SIGNUP] Auth user creation failed:", authErr.message);
    return res.status(500).json({ error: "Account creation failed" });
  }

  const authUserId = authData.user.id;

  // Create portal_users row (client_id=null until approval)
  const { error: puErr } = await supabase.from("portal_users").insert({
    auth_user_id: authUserId,
    email,
    role:         "client_admin",
    client_id:    null,
    active:       true,
  });

  if (puErr) {
    console.error("[SIGNUP] portal_users insert failed:", puErr.message);
    await supabase.auth.admin.deleteUser(authUserId).catch(() => {});
    return res.status(500).json({ error: "Portal user setup failed" });
  }

  // Create onboarding_drafts placeholder (status=processing) so the polling
  // page has something to find immediately after login.
  const { data: draftRow, error: draftErr } = await supabase
    .from("onboarding_drafts")
    .insert({
      created_by:         email,
      source_url:         websiteUrl,
      status:             "processing",
      owner_auth_user_id: authUserId,
      draft_client:       { name: businessName, website_url: websiteUrl },
      draft_bot:          {},
      draft_booking:      {},
      extracted_facts:    {},
      confidence:         {},
      warnings:           [],
      pages_crawled:      0,
    })
    .select("id")
    .single();

  if (draftErr) {
    console.error("[SIGNUP] onboarding_drafts insert failed:", draftErr.message);
    // Don't roll back the auth user — they can retry analysis from the portal.
    return res.status(500).json({ error: "Onboarding setup failed" });
  }

  const draftId = draftRow.id;

  // Fire-and-forget background crawl
  setImmediate(() => {
    runOnboardingCrawl({ draftId, websiteUrl, anthropic, supabase, email });
  });

  // Notify team (non-blocking)
  notifyTeam(twilioClient, `New Highmark signup: ${businessName} (${email}) — ${websiteUrl}`);

  console.log(`[SIGNUP] Created account ${email} → draft ${draftId} (processing)`);

  return res.status(201).json({
    ok:      true,
    email,
    draftId,
    message: "Account created. Sign in to view your onboarding status.",
  });
}

// ── GET /portal/api/onboarding/status ─────────────────────────────────────────
//
// Returns the most recent draft owned by the current portal user.
// internal_admin users see nothing here — they use the existing admin onboarding
// routes for ad-hoc analysis.

export async function handleOnboardingStatus(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const authUserId = req.portalUser?.authUserId;
  if (!authUserId) return res.status(401).json({ error: "Not authenticated" });

  // If user is already linked to a client, surface that immediately
  if (req.portalUser?.clientId) {
    return res.json({
      status:   "approved",
      clientId: req.portalUser.clientId,
    });
  }

  const { data, error } = await supabase
    .from("onboarding_drafts")
    .select("id, status, source_url, draft_client, draft_bot, draft_booking, confidence, warnings, pages_crawled, error_message, committed_client_id, created_at, updated_at")
    .eq("owner_auth_user_id", authUserId)
    .in("status", ["processing", "draft", "saved", "failed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[ONBOARDING STATUS]", error.message);
    return res.status(500).json({ error: "Lookup failed" });
  }
  if (!data) return res.json({ status: "none" });

  return res.json({
    status:        data.status,
    draftId:       data.id,
    sourceUrl:     data.source_url,
    draft: {
      client:  data.draft_client  ?? {},
      bot:     data.draft_bot     ?? {},
      booking: data.draft_booking ?? {},
    },
    confidence:    data.confidence ?? {},
    warnings:      data.warnings   ?? [],
    pagesCrawled:  data.pages_crawled ?? 0,
    errorMessage:  data.error_message ?? null,
    clientId:      data.committed_client_id ?? null,
    createdAt:     data.created_at,
    updatedAt:     data.updated_at,
  });
}

// ── POST /portal/api/onboarding/approve ───────────────────────────────────────
//
// User reviewed the draft and is happy → commit to a real client + link
// portal_user to the new client. Body: { draftId? }
//
// If draftId omitted, picks the most recent owned draft in status=draft.

export async function handleOnboardingApprove(req, res, supabase, twilioClient) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  const authUserId = req.portalUser?.authUserId;
  if (!authUserId) return res.status(401).json({ error: "Not authenticated" });

  if (req.portalUser?.clientId) {
    return res.status(409).json({ error: "Account already linked to a client" });
  }

  let draftId = req.body?.draftId ?? null;
  if (!draftId) {
    const { data } = await supabase
      .from("onboarding_drafts")
      .select("id")
      .eq("owner_auth_user_id", authUserId)
      .eq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    draftId = data?.id ?? null;
  }

  if (!draftId) return res.status(404).json({ error: "No draft ready for approval" });

  // Verify ownership before committing
  const draft = await getDraft(draftId, supabase);
  if (!draft)                                      return res.status(404).json({ error: "Draft not found" });
  if (draft.owner_auth_user_id !== authUserId)     return res.status(403).json({ error: "Draft is not yours" });
  if (draft.status !== "draft")                    return res.status(400).json({ error: `Draft is ${draft.status}, not ready to approve` });

  // Commit draft → client (creates clients row, marks draft saved)
  let clientId, clientName;
  try {
    const result = await commitDraftToDb(draftId, supabase);
    clientId   = result.clientId;
    clientName = result.clientName;
  } catch (err) {
    console.error("[ONBOARDING APPROVE]", err.message);
    return res.status(500).json({ error: err.message });
  }

  // Link portal_user to the new client (so future requests are scoped)
  await supabase.from("portal_users")
    .update({ client_id: clientId, updated_at: new Date().toISOString() })
    .eq("auth_user_id", authUserId);

  // Notify team
  notifyTeam(
    twilioClient,
    `Highmark approval: ${clientName} (${req.portalUser.email}) — client_id=${clientId}. Assign Twilio number.`,
  );

  const nextSteps = buildNextSteps(draft.extracted_facts ?? {}, draft.warnings ?? []);

  return res.json({
    ok:        true,
    clientId,
    clientName,
    nextSteps,
    onboardingStatus: "created",
    botMode:          "test",
  });
}

// Exported for tests
export const _internal = { validateSignupBody, runOnboardingCrawl, TEAM_NOTIFY_PHONE };
