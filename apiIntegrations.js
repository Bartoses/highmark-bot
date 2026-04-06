// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — Custom API Integration Builder
//
// Provides CRUD, test, execute, and bot-context functions for client-defined
// API integrations stored in client_api_integrations (DB1).
//
// Exports:
//   createIntegration(supabase, clientId, config)
//   updateIntegration(supabase, id, clientId, updates)
//   deleteIntegration(supabase, id, clientId)
//   getClientIntegrations(supabase, clientId)
//   testEndpoint(integration, endpointIdx, overrideParams)
//   executeEndpoint(integration, endpointIdx, overrideParams)
//   inferSchema(data)
//   sanitizeForPortal(integration)        — strips auth secrets from GET responses
//   getCustomApiContext(supabase, clientId, userMessage)  — called before Claude
// ─────────────────────────────────────────────────────────────────────────────

const EXEC_TIMEOUT_MS  = 10_000; // 10 s per API call
const MAX_RESPONSE_KB  = 20;     // truncate stored sample at 20 KB
const TABLE            = "client_api_integrations";

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_AUTH_TYPES   = ["none", "bearer", "api_key_header", "api_key_query", "basic"];
const VALID_METHODS      = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function validateConfig(cfg) {
  const errors = [];
  if (!cfg.name?.trim())     errors.push("name is required");
  if (!cfg.base_url?.trim()) errors.push("base_url is required");
  try { new URL(cfg.base_url); } catch { errors.push("base_url must be a valid URL"); }
  if (cfg.auth_type && !VALID_AUTH_TYPES.includes(cfg.auth_type)) {
    errors.push(`auth_type must be one of: ${VALID_AUTH_TYPES.join(", ")}`);
  }
  if (cfg.endpoints !== undefined) {
    if (!Array.isArray(cfg.endpoints)) {
      errors.push("endpoints must be an array");
    } else {
      cfg.endpoints.forEach((ep, i) => {
        if (!ep.name?.trim())   errors.push(`endpoints[${i}].name is required`);
        if (!ep.path?.trim())   errors.push(`endpoints[${i}].path is required`);
        const method = (ep.method ?? "GET").toUpperCase();
        if (!VALID_METHODS.includes(method)) {
          errors.push(`endpoints[${i}].method must be one of: ${VALID_METHODS.join(", ")}`);
        }
      });
    }
  }
  return errors;
}

function normalizeConfig(cfg) {
  return {
    name:        (cfg.name ?? "").trim(),
    description: (cfg.description ?? "").trim() || null,
    base_url:    (cfg.base_url ?? "").replace(/\/+$/, ""), // strip trailing slash
    auth_type:   cfg.auth_type ?? "none",
    auth_config: cfg.auth_config ?? {},
    headers:     cfg.headers ?? {},
    endpoints:   (cfg.endpoints ?? []).map((ep) => ({
      name:          (ep.name ?? "").trim(),
      path:          ep.path?.trim().startsWith("/") ? ep.path.trim() : `/${ep.path?.trim() ?? ""}`,
      method:        (ep.method ?? "GET").toUpperCase(),
      params:        ep.params ?? {},
      context_label: (ep.context_label ?? ep.name ?? "API DATA").toUpperCase().trim(),
      inject_always: !!ep.inject_always,
    })),
    enabled: cfg.enabled !== false,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createIntegration(supabase, clientId, config) {
  const errors = validateConfig(config);
  if (errors.length) return { data: null, error: errors.join("; ") };

  const row = { client_id: clientId, ...normalizeConfig(config) };
  const { data, error } = await supabase.from(TABLE).insert(row).select().single();
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function updateIntegration(supabase, id, clientId, updates) {
  // Partial update — only validate fields that are present
  const partial = {};
  if (updates.name        !== undefined) partial.name        = updates.name;
  if (updates.description !== undefined) partial.description = updates.description;
  if (updates.base_url    !== undefined) partial.base_url    = updates.base_url;
  if (updates.auth_type   !== undefined) partial.auth_type   = updates.auth_type;
  if (updates.headers     !== undefined) partial.headers     = updates.headers;
  if (updates.endpoints   !== undefined) partial.endpoints   = updates.endpoints;
  if (updates.enabled     !== undefined) partial.enabled     = updates.enabled;

  // auth_config: merge new values into existing (never clear on empty)
  if (updates.auth_config !== undefined) {
    // Fetch existing first to merge
    const { data: existing } = await supabase.from(TABLE).select("auth_config").eq("id", id).eq("client_id", clientId).single();
    const prev = existing?.auth_config ?? {};
    const incoming = updates.auth_config ?? {};
    // Empty string values mean "keep existing"
    const merged = { ...prev };
    for (const [k, v] of Object.entries(incoming)) {
      if (v !== "" && v !== null && v !== undefined) merged[k] = v;
    }
    partial.auth_config = merged;
  }

  if (updates.endpoints !== undefined) {
    const errors = validateConfig({ name: "x", base_url: "https://x.com", endpoints: updates.endpoints });
    const epErrors = errors.filter(e => e.startsWith("endpoints"));
    if (epErrors.length) return { data: null, error: epErrors.join("; ") };
    partial.endpoints = normalizeConfig({ name: "x", base_url: "https://x.com", endpoints: updates.endpoints }).endpoints;
  }

  if (Object.keys(partial).length === 0) return { data: null, error: "No updatable fields provided" };

  partial.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from(TABLE)
    .update(partial)
    .eq("id", id)
    .eq("client_id", clientId)
    .select()
    .single();
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function deleteIntegration(supabase, id, clientId) {
  const { error } = await supabase.from(TABLE).delete().eq("id", id).eq("client_id", clientId);
  if (error) return { error: error.message };
  return { error: null };
}

export async function getClientIntegrations(supabase, clientId) {
  const { data, error } = await supabase.from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return data ?? [];
}

// ── Auth header builder ───────────────────────────────────────────────────────

function buildAuthHeaders(integration) {
  const { auth_type, auth_config } = integration;
  const out = {};
  switch (auth_type) {
    case "bearer":
      if (auth_config.token) out["Authorization"] = `Bearer ${auth_config.token}`;
      break;
    case "api_key_header":
      if (auth_config.key_name && auth_config.key_value) out[auth_config.key_name] = auth_config.key_value;
      break;
    case "basic":
      if (auth_config.username) {
        const encoded = Buffer.from(`${auth_config.username}:${auth_config.password ?? ""}`).toString("base64");
        out["Authorization"] = `Basic ${encoded}`;
      }
      break;
  }
  return out;
}

function buildRequestUrl(integration, endpoint, params) {
  const base   = integration.base_url.replace(/\/+$/, "");
  const path   = endpoint.path.startsWith("/") ? endpoint.path : `/${endpoint.path}`;
  const method = endpoint.method ?? "GET";

  let url = `${base}${path}`;

  // api_key_query: add key to query string
  const qParams = { ...(params ?? {}) };
  if (integration.auth_type === "api_key_query" && integration.auth_config.key_name) {
    qParams[integration.auth_config.key_name] = integration.auth_config.key_value ?? "";
  }

  const isGetLike = ["GET", "DELETE"].includes(method);
  if (isGetLike && Object.keys(qParams).length > 0) {
    url += `?${new URLSearchParams(qParams).toString()}`;
  }

  return { url, isGetLike, bodyParams: isGetLike ? null : qParams };
}

// ── Execute ───────────────────────────────────────────────────────────────────

export async function executeEndpoint(integration, endpointIdx, overrideParams = {}) {
  const endpoint = (integration.endpoints ?? [])[endpointIdx];
  if (!endpoint) return { ok: false, error: `Endpoint index ${endpointIdx} not found` };

  const params = { ...(endpoint.params ?? {}), ...overrideParams };
  const { url, isGetLike, bodyParams } = buildRequestUrl(integration, endpoint, params);

  const headers = {
    "Content-Type": "application/json",
    "User-Agent":   "Highmark-Bot/1.0",
    ...(integration.headers ?? {}),
    ...buildAuthHeaders(integration),
    ...(endpoint.headers_override ?? {}),
  };

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), EXEC_TIMEOUT_MS);

  try {
    const opts = { method: endpoint.method, headers, signal: controller.signal };
    if (!isGetLike && bodyParams) opts.body = JSON.stringify(bodyParams);

    const res  = await fetch(url, opts);
    const text = await res.text();
    clearTimeout(timer);

    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, rawText: text.slice(0, 500) };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === "AbortError" ? `Timeout after ${EXEC_TIMEOUT_MS / 1000}s` : err.message;
    return { ok: false, error: msg };
  }
}

// ── Test ──────────────────────────────────────────────────────────────────────

export async function testEndpoint(integration, endpointIdx, overrideParams = {}) {
  const result = await executeEndpoint(integration, endpointIdx, overrideParams);
  if (!result.ok) return result;

  const schema = inferSchema(result.data);
  const sample = truncateSample(result.data);
  return { ...result, schema, sample };
}

// ── Schema inference ──────────────────────────────────────────────────────────

export function inferSchema(data, depth = 0) {
  if (depth > 4) return "…";
  if (data === null) return "null";
  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    return [inferSchema(data[0], depth + 1)];
  }
  if (typeof data === "object") {
    const out = {};
    for (const [k, v] of Object.entries(data).slice(0, 20)) {
      out[k] = inferSchema(v, depth + 1);
    }
    return out;
  }
  return typeof data; // "string" | "number" | "boolean"
}

function truncateSample(data) {
  try {
    const str = JSON.stringify(data);
    if (str.length > MAX_RESPONSE_KB * 1024) {
      return JSON.parse(str.slice(0, MAX_RESPONSE_KB * 1024) + '"…"');
    }
    return data;
  } catch {
    return null;
  }
}

// ── Sanitize for portal (never expose secrets) ────────────────────────────────

export function sanitizeForPortal(integration) {
  const { auth_config, auth_type, ...rest } = integration;
  // Return which fields are set but never the values
  const sanitizedAuth = {};
  if (auth_type === "bearer")         sanitizedAuth.has_token = !!(auth_config?.token);
  if (auth_type === "api_key_header" || auth_type === "api_key_query") {
    sanitizedAuth.key_name  = auth_config?.key_name ?? null;
    sanitizedAuth.has_value = !!(auth_config?.key_value);
  }
  if (auth_type === "basic") {
    sanitizedAuth.username  = auth_config?.username ?? null;
    sanitizedAuth.has_password = !!(auth_config?.password);
  }
  return { ...rest, auth_type, auth_config: sanitizedAuth };
}

// ── Bot context builder ───────────────────────────────────────────────────────
// Called before every Claude response in the DEFAULT block.
// Fetches all inject_always endpoints + keyword-matched endpoints,
// returns a formatted string to append to knowledgeCtx.

export async function getCustomApiContext(supabase, clientId, userMessage = "") {
  if (!supabase || !clientId) return "";

  let integrations;
  try {
    integrations = await getClientIntegrations(supabase, clientId);
  } catch {
    return "";
  }

  const enabled = integrations.filter((i) => i.enabled);
  if (!enabled.length) return "";

  const parts   = [];
  const msgLower = userMessage.toLowerCase();

  for (const integration of enabled) {
    const endpoints = integration.endpoints ?? [];
    for (let idx = 0; idx < endpoints.length; idx++) {
      const ep = endpoints[idx];
      const shouldFetch = ep.inject_always; // trigger_keywords matching is a future enhancement
      if (!shouldFetch) continue;

      const result = await executeEndpoint(integration, idx);
      if (!result.ok) {
        console.warn(`[API] ${integration.name}/${ep.name} failed: ${result.error}`);
        continue;
      }

      const label   = ep.context_label || ep.name || "API DATA";
      const preview = formatForContext(result.data);
      if (preview) parts.push(`${label}:\n${preview}`);
    }
  }

  return parts.length ? parts.join("\n\n") : "";
}

function formatForContext(data) {
  if (!data) return "";
  try {
    const str = JSON.stringify(data, null, 2);
    // Cap at 1500 chars to keep context manageable
    return str.length > 1500 ? str.slice(0, 1497) + "…" : str;
  } catch {
    return String(data).slice(0, 1500);
  }
}
