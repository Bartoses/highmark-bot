// ─────────────────────────────────────────────────────────────────────────────
// PORTAL AUTH — JWT-based authentication middleware for the client portal
//
// Uses Supabase Auth JWT validation (service-role client, server-side only).
// The portal_users table maps auth users to role + client_id.
//
// Usage:
//   const requirePortalAuth = makePortalAuth(supabase);
//   app.get("/portal/api/me", requirePortalAuth, handler);
//
// After middleware runs, req.portalUser is always set:
//   { authUserId, role: "internal_admin"|"client_user", clientId: string|null }
//
// Use resolvePortalClientId(req) to get the scoped client_id for DB queries:
//   - client_user: always their own clientId (ignores any query params)
//   - internal_admin: uses ?client_id= query param (null if not provided)
// ─────────────────────────────────────────────────────────────────────────────

// Roles:
//   internal_admin — Highmark staff, can access any client
//   client_admin   — Business admin, scoped to own client, can manage own users
//   client_user    — Read-only business user, scoped to own client

// ── makePortalAuth ────────────────────────────────────────────────────────────
// Returns an Express middleware that validates a Bearer JWT and populates
// req.portalUser. Closes over the supabase service-role client.

export function makePortalAuth(supabase) {
  return async function requirePortalAuth(req, res, next) {
    const authHeader = req.headers["authorization"] ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

    if (!token) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    // Validate JWT with Supabase (service-role key allows server-side verification)
    let user;
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
      user = data.user;
    } catch {
      return res.status(401).json({ error: "Token validation failed" });
    }

    // Look up portal_users row
    let portalUser;
    try {
      const { data, error } = await supabase
        .from("portal_users")
        .select("role, client_id, active")
        .eq("auth_user_id", user.id)
        .maybeSingle();

      if (error || !data) {
        return res.status(403).json({ error: "No portal access provisioned for this account" });
      }
      if (!data.active) {
        return res.status(403).json({ error: "Portal access has been deactivated" });
      }
      if ((data.role === "client_user" || data.role === "client_admin") && !data.client_id) {
        return res.status(403).json({ error: "Account is not linked to a client — contact support" });
      }
      portalUser = data;
    } catch {
      return res.status(500).json({ error: "Authentication error" });
    }

    req.portalUser = {
      authUserId:    user.id,
      email:         user.email,
      role:          portalUser.role,
      clientId:      portalUser.client_id ?? null,
      isAdmin:       portalUser.role === "internal_admin",
      isClientAdmin: portalUser.role === "client_admin" || portalUser.role === "internal_admin",
    };

    next();
  };
}

// ── resolvePortalClientId ─────────────────────────────────────────────────────
// Returns the effective client_id for the current request.
//   client_user → always their own clientId (scoped, not overridable)
//   internal_admin → req.query.client_id (null if not provided)
//
// Handlers should return 400 if the result is null and client_id is required.

export function resolvePortalClientId(req) {
  const { portalUser } = req;
  if (!portalUser) return null;
  // internal_admin: can scope to any client via ?client_id= or body.client_id
  if (portalUser.role === "internal_admin") {
    return req.query.client_id ?? req.body?.client_id ?? null;
  }
  // client_admin + client_user: always scoped to their own client
  return portalUser.clientId;
}
