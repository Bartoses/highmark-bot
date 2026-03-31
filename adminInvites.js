// ─────────────────────────────────────────────────────────────────────────────
// ADMIN INVITES — Portal invite lifecycle management (Chunk 11)
//
// Controlled invite-based access: admins create invite links, clients click
// them to set a password and get scoped portal access. No open self-serve signup.
//
// Admin routes (requireUiAccess):
//   POST  /admin/portal-invites              — create invite, returns invite_url
//   GET   /admin/portal-invites              — list invites
//   POST  /admin/portal-invites/:id/resend   — new token, 72h expiry
//   POST  /admin/portal-invites/:id/revoke   — mark revoked
//   PATCH /admin/portal-users/:id            — deactivate / reactivate portal user
//
// Portal routes (requirePortalAuth, internal_admin only):
//   GET   /portal/api/users                  — list portal users
//   GET   /portal/api/invites                — list invites
//   POST  /portal/api/invites                — create invite
//   POST  /portal/api/invites/:id/resend     — resend
//   POST  /portal/api/invites/:id/revoke     — revoke
//   PATCH /portal/api/users/:id              — deactivate / reactivate
//
// Public routes (no auth):
//   GET   /portal/invite                     — serve portal-accept.html
//   GET   /portal/api/invite-info?token=     — safe metadata for accept page
//   POST  /portal/api/accept-invite          — validate token, create user
//
// DB migration required: db1_portal_invites.sql
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from "crypto";

const INVITE_EXPIRY_HOURS = 72;
const INVITE_EXPIRY_MS    = INVITE_EXPIRY_HOURS * 60 * 60 * 1000;
const VALID_ROLES         = ["internal_admin", "client_user"];
const VALID_STATUSES      = ["pending", "accepted", "expired", "revoked"];

function generateToken() {
  return randomBytes(32).toString("hex"); // 64-char hex, cryptographically secure
}

function appBaseUrl() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return process.env.APP_URL ?? "https://highmark-bot-production.up.railway.app";
}

function makeInviteUrl(token) {
  return `${appBaseUrl()}/portal/invite?token=${token}`;
}

// ── Shared invite creation logic ──────────────────────────────────────────────
async function createInvite(supabase, { email, role, client_id, invited_by }) {
  const normalizedEmail = email.toLowerCase().trim();

  // Block duplicate pending invites for the same email
  const { data: existing } = await supabase
    .from("portal_invites")
    .select("id, status")
    .eq("email", normalizedEmail)
    .eq("status", "pending")
    .maybeSingle();

  if (existing) {
    const err = new Error("A pending invite already exists for this email. Resend or revoke it first.");
    err.status = 409;
    err.existing_id = existing.id;
    throw err;
  }

  const token     = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS).toISOString();

  const { data, error } = await supabase
    .from("portal_invites")
    .insert({
      email:        normalizedEmail,
      role,
      client_id:    client_id ?? null,
      invited_by:   invited_by ?? "admin",
      status:       "pending",
      invite_token: token,
      expires_at:   expiresAt,
    })
    .select("id, email, role, client_id, invited_by, status, expires_at, created_at")
    .single();

  if (error) throw new Error(error.message);

  console.log(`[INVITES] Created invite id=${data.id} for ${normalizedEmail} (role=${role}, client=${client_id ?? "admin"})`);
  return { invite: data, invite_url: makeInviteUrl(token), expires_at: expiresAt };
}

// ── Shared resend logic ───────────────────────────────────────────────────────
async function resendInvite(supabase, id) {
  const { data: invite, error: fetchErr } = await supabase
    .from("portal_invites")
    .select("id, email, status")
    .eq("id", id)
    .single();

  if (fetchErr || !invite) { const e = new Error("Invite not found"); e.status = 404; throw e; }
  if (invite.status === "accepted") { const e = new Error("Invite already accepted — cannot be resent"); e.status = 409; throw e; }
  if (invite.status === "revoked")  { const e = new Error("Invite is revoked — create a new invite instead"); e.status = 409; throw e; }

  const token     = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS).toISOString();

  const { data, error } = await supabase
    .from("portal_invites")
    .update({ invite_token: token, expires_at: expiresAt, status: "pending", updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, email, role, client_id, status, expires_at")
    .single();

  if (error) throw new Error(error.message);

  console.log(`[INVITES] Resent invite id=${id} for ${invite.email}`);
  return { invite: data, invite_url: makeInviteUrl(token), expires_at: expiresAt };
}

// ── Shared revoke logic ───────────────────────────────────────────────────────
async function revokeInvite(supabase, id) {
  const { data: invite, error: fetchErr } = await supabase
    .from("portal_invites")
    .select("id, email, status")
    .eq("id", id)
    .single();

  if (fetchErr || !invite) { const e = new Error("Invite not found"); e.status = 404; throw e; }
  if (invite.status === "accepted") { const e = new Error("Invite already accepted — deactivate the portal user instead"); e.status = 409; throw e; }
  if (invite.status === "revoked")  { const e = new Error("Invite is already revoked"); e.status = 409; throw e; }

  const { error } = await supabase
    .from("portal_invites")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);

  console.log(`[INVITES] Revoked invite id=${id} for ${invite.email}`);
  return { ok: true, id, status: "revoked" };
}

// ── Shared portal user update logic ──────────────────────────────────────────
async function updatePortalUser(supabase, id, { active }) {
  if (typeof active !== "boolean") {
    const e = new Error("active (boolean) is required"); e.status = 400; throw e;
  }

  const { data: existing, error: fetchErr } = await supabase
    .from("portal_users")
    .select("id, email, role, active")
    .eq("id", id)
    .single();

  if (fetchErr || !existing) { const e = new Error("Portal user not found"); e.status = 404; throw e; }

  const { data, error } = await supabase
    .from("portal_users")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, email, role, client_id, active")
    .single();

  if (error) throw new Error(error.message);

  console.log(`[PORTAL ADMIN] ${active ? "Reactivated" : "Deactivated"} portal user: ${existing.email}`);
  return { portalUser: data };
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES (requireUiAccess — protected by UI_SECRET)
// ─────────────────────────────────────────────────────────────────────────────

// POST /admin/portal-invites
export async function handleCreateInvite(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { email, client_id = null, role = "client_user", invited_by = "admin" } = req.body;

  if (!email) return res.status(400).json({ error: "email is required" });
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: "role must be internal_admin or client_user" });
  }
  if (role === "client_user" && !client_id) {
    return res.status(400).json({ error: "client_id is required for client_user role" });
  }

  try {
    const result = await createInvite(supabase, { email, role, client_id, invited_by });
    return res.status(201).json(result);
  } catch (err) {
    const status = err.status ?? 500;
    const body   = { error: err.message };
    if (err.existing_id) body.existing_id = err.existing_id;
    return res.status(status).json(body);
  }
}

// GET /admin/portal-invites
export async function handleListInvites(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { client_id, status, limit = 50, offset = 0 } = req.query;

  let query = supabase
    .from("portal_invites")
    .select("id, email, role, client_id, invited_by, status, expires_at, accepted_at, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (client_id) query = query.eq("client_id", client_id);
  if (status)    query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ invites: data ?? [], total: count ?? 0 });
}

// POST /admin/portal-invites/:id/resend
export async function handleResendInvite(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  try {
    return res.json(await resendInvite(supabase, req.params.id));
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

// POST /admin/portal-invites/:id/revoke
export async function handleRevokeInvite(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  try {
    return res.json(await revokeInvite(supabase, req.params.id));
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

// PATCH /admin/portal-users/:id
export async function handleUpdatePortalUser(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  try {
    return res.json(await updatePortalUser(supabase, req.params.id, req.body));
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES (no auth — used during invite acceptance)
// ─────────────────────────────────────────────────────────────────────────────

// GET /portal/api/invite-info?token=
// Returns safe metadata for the accept page — never echoes the token.
export async function handleInviteInfo(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { token } = req.query;
  if (!token) return res.status(400).json({ error: "token is required" });

  const { data: invite, error } = await supabase
    .from("portal_invites")
    .select("id, email, role, client_id, status, expires_at")
    .eq("invite_token", token)
    .maybeSingle();

  if (error || !invite) {
    return res.status(404).json({ error: "Invite not found. It may have expired or been revoked." });
  }
  if (invite.status === "revoked") {
    return res.status(410).json({ error: "This invite has been revoked. Contact your admin for a new one." });
  }
  if (invite.status === "accepted") {
    return res.status(410).json({ error: "This invite has already been used. Try logging in instead." });
  }
  if (invite.status === "expired" || new Date(invite.expires_at) < new Date()) {
    await supabase.from("portal_invites")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", invite.id);
    return res.status(410).json({ error: "This invite has expired. Ask your admin to send a new one." });
  }

  return res.json({ email: invite.email, role: invite.role, clientId: invite.client_id });
}

// POST /portal/api/accept-invite
// Body: { token, password }
// Creates Supabase Auth user + portal_users row. Marks invite accepted.
// Client-side then calls signInWithPassword to get a session.
export async function handleAcceptInvite(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { token, password } = req.body;
  if (!token)    return res.status(400).json({ error: "token is required" });
  if (!password) return res.status(400).json({ error: "password is required" });
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const { data: invite, error: fetchErr } = await supabase
    .from("portal_invites")
    .select("id, email, role, client_id, status, expires_at")
    .eq("invite_token", token)
    .maybeSingle();

  if (fetchErr || !invite) {
    return res.status(404).json({ error: "Invite not found. It may have expired or been revoked." });
  }
  if (invite.status === "revoked") {
    return res.status(410).json({ error: "This invite has been revoked." });
  }
  if (invite.status === "accepted") {
    return res.status(410).json({ error: "This invite has already been used. Try logging in instead." });
  }
  if (invite.status === "expired" || new Date(invite.expires_at) < new Date()) {
    await supabase.from("portal_invites")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", invite.id);
    return res.status(410).json({ error: "This invite has expired. Ask your admin to send a new one." });
  }

  // Create Supabase Auth user (auto-confirm email)
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email:         invite.email,
    password,
    email_confirm: true,
  });

  if (authErr) {
    const msg = authErr.message.toLowerCase();
    if (msg.includes("already") || msg.includes("exists")) {
      return res.status(409).json({ error: "An account with this email already exists. Try logging in instead." });
    }
    console.error("[INVITES] Auth user creation failed:", authErr.message);
    return res.status(500).json({ error: "Account creation failed: " + authErr.message });
  }

  // Create portal_users row
  const { error: puErr } = await supabase
    .from("portal_users")
    .insert({
      auth_user_id: authData.user.id,
      email:        invite.email,
      role:         invite.role,
      client_id:    invite.client_id ?? null,
      active:       true,
    });

  if (puErr) {
    console.error("[INVITES] portal_users insert failed:", puErr.message);
    // Cleanup orphan auth user to keep state consistent
    await supabase.auth.admin.deleteUser(authData.user.id).catch(() => {});
    return res.status(500).json({ error: "Portal user setup failed" });
  }

  // Mark invite accepted — single-use
  await supabase
    .from("portal_invites")
    .update({
      status:      "accepted",
      accepted_at: new Date().toISOString(),
      updated_at:  new Date().toISOString(),
    })
    .eq("id", invite.id);

  console.log(`[INVITES] Accepted invite for ${invite.email} (role=${invite.role}, client=${invite.client_id})`);

  // Return email so the client page can call signInWithPassword directly
  return res.json({ ok: true, email: invite.email });
}

// ─────────────────────────────────────────────────────────────────────────────
// PORTAL ROUTES (requirePortalAuth — internal_admin only)
// ─────────────────────────────────────────────────────────────────────────────

function assertAdmin(req, res) {
  if (req.portalUser?.role !== "internal_admin") {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}

// GET /portal/api/users
export async function handlePortalUsers(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!assertAdmin(req, res)) return;

  const { client_id } = req.query;
  let query = supabase
    .from("portal_users")
    .select("id, email, role, client_id, active, created_at")
    .order("created_at", { ascending: false });

  if (client_id) query = query.eq("client_id", client_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ users: data ?? [] });
}

// GET /portal/api/invites
export async function handlePortalInvites(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!assertAdmin(req, res)) return;

  const { client_id, status } = req.query;
  let query = supabase
    .from("portal_invites")
    .select("id, email, role, client_id, invited_by, status, expires_at, accepted_at, created_at")
    .order("created_at", { ascending: false });

  if (client_id) query = query.eq("client_id", client_id);
  if (status)    query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ invites: data ?? [] });
}

// POST /portal/api/invites
export async function handlePortalCreateInvite(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!assertAdmin(req, res)) return;

  const { email, client_id = null, role = "client_user" } = req.body;
  const invited_by = req.portalUser?.email ?? "admin";

  if (!email) return res.status(400).json({ error: "email is required" });
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: "role must be internal_admin or client_user" });
  }
  if (role === "client_user" && !client_id) {
    return res.status(400).json({ error: "client_id is required for client_user role" });
  }

  try {
    const result = await createInvite(supabase, { email, role, client_id, invited_by });
    return res.status(201).json(result);
  } catch (err) {
    const body = { error: err.message };
    if (err.existing_id) body.existing_id = err.existing_id;
    return res.status(err.status ?? 500).json(body);
  }
}

// POST /portal/api/invites/:id/resend
export async function handlePortalResendInvite(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!assertAdmin(req, res)) return;
  try {
    return res.json(await resendInvite(supabase, req.params.id));
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

// POST /portal/api/invites/:id/revoke
export async function handlePortalRevokeInvite(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!assertAdmin(req, res)) return;
  try {
    return res.json(await revokeInvite(supabase, req.params.id));
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}

// PATCH /portal/api/users/:id
export async function handlePortalUpdateUser(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });
  if (!assertAdmin(req, res)) return;
  try {
    return res.json(await updatePortalUser(supabase, req.params.id, req.body));
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
}
