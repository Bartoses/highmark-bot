// ─────────────────────────────────────────────────────────────────────────────
// CROSS-CHANNEL CONTINUITY — Phase 11.8
//
// Links web sessions to phone numbers so conversations flow seamlessly between
// the website widget and SMS.
//
// Web → SMS: visitor provides phone on web → context bridge SMS sent
// SMS → Web: returning SMS user visits site → web context injected into prompt
//
// All functions are non-blocking / graceful — failures fall back to normal flow.
//
// DB: user_identity table (db1_user_identity.sql) — one row per (client, phone)
// ─────────────────────────────────────────────────────────────────────────────

import { normalizePhone, isValidPhone } from "./phoneUtils.js";

// ─────────────────────────────────────────────────────────────────────────────
// linkPhoneToSession — upsert user_identity row, append sessionId to array.
// Returns the identity row, or null on failure (always non-fatal).
// ─────────────────────────────────────────────────────────────────────────────
export async function linkPhoneToSession(supabase, clientId, phone, sessionId) {
  if (!supabase || !phone || !sessionId || !clientId) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  try {
    const { data: existing } = await supabase
      .from("user_identity")
      .select("id, session_ids")
      .eq("client_id", clientId)
      .eq("phone", normalized)
      .maybeSingle();

    if (existing) {
      const prev = existing.session_ids ?? [];
      if (prev.includes(sessionId)) return existing; // already linked
      const { data } = await supabase
        .from("user_identity")
        .update({ session_ids: [...prev, sessionId], updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select()
        .single();
      return data;
    }

    // New identity
    const { data } = await supabase
      .from("user_identity")
      .insert({ client_id: clientId, phone: normalized, session_ids: [sessionId] })
      .select()
      .single();
    console.log(`[CROSS_CHANNEL] Identity created: client=${clientId} phone=${normalized}`);
    return data;
  } catch (err) {
    console.error("[CROSS_CHANNEL] linkPhoneToSession failed:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getIdentityByPhone — look up identity by normalized phone for a client.
// Returns identity row or null.
// ─────────────────────────────────────────────────────────────────────────────
export async function getIdentityByPhone(supabase, clientId, phone) {
  if (!supabase || !phone || !clientId) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  try {
    const { data } = await supabase
      .from("user_identity")
      .select("*")
      .eq("client_id", clientId)
      .eq("phone", normalized)
      .maybeSingle();
    return data ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getIdentityBySession — look up identity by session_id (array contains query).
// Returns identity row or null.
// ─────────────────────────────────────────────────────────────────────────────
export async function getIdentityBySession(supabase, clientId, sessionId) {
  if (!supabase || !sessionId || !clientId) return null;

  try {
    const { data } = await supabase
      .from("user_identity")
      .select("*")
      .eq("client_id", clientId)
      .contains("session_ids", [sessionId])
      .maybeSingle();
    return data ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildCrossChannelSummary — format recent messages as a short context string.
// Used to inject web context into SMS prompt and vice versa.
// ─────────────────────────────────────────────────────────────────────────────
export function buildCrossChannelSummary(messages, maxMessages = 6) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const recent = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-maxMessages);

  if (recent.length === 0) return null;

  return recent
    .map((m) => {
      const label   = m.role === "user" ? "Guest" : "Bot";
      const content = (m.content ?? "").replace(/\n+/g, " ").slice(0, 120);
      return `${label}: ${content}`;
    })
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// loadCrossChannelContext — fetch the most recent web conversation for any of
// the given sessionIds, return the messages array.
// Returns null if nothing found or on error.
// ─────────────────────────────────────────────────────────────────────────────
export async function loadCrossChannelContext(supabase, clientId, sessionIds) {
  if (!supabase || !sessionIds?.length || !clientId) return null;

  try {
    const fromNumbers = sessionIds.map((s) => `web:${s}`);
    const { data } = await supabase
      .from("conversations")
      .select("messages, updated_at")
      .in("from_number", fromNumbers)
      .eq("client_id", clientId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return data?.messages?.length ? data.messages : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// extractPhoneFromMessage — pull the first plausible US phone number from text.
// Returns normalized E.164 string or null.
// ─────────────────────────────────────────────────────────────────────────────
export function extractPhoneFromMessage(text) {
  if (!text) return null;
  // Match US phone numbers in various formats: (555) 123-4567, 555-123-4567, 5551234567, +15551234567
  const match = text.match(
    /(?:\+?1[\s\-.]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s\-.]?[2-9]\d{2}[\s\-.]?\d{4}/,
  );
  if (!match) return null;
  const raw = match[0];
  return isValidPhone(raw) ? normalizePhone(raw) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSmsBridgeMessage — compose the text sent when bridging web → SMS.
// Keeps it short, friendly, and conversation-aware.
// ─────────────────────────────────────────────────────────────────────────────
export function buildSmsBridgeMessage(lastBotMessage, bookingUrl) {
  const parts = ["Hey! Continuing from our chat on the site:"];

  if (lastBotMessage) {
    // Trim and strip URLs (they'll be added cleanly below)
    const snippet = lastBotMessage
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 140);
    if (snippet) parts.push(snippet);
  }

  if (bookingUrl) {
    parts.push(`\n${bookingUrl}`);
  }

  parts.push("\nReply here if you have any questions!");
  return parts.join("\n");
}
