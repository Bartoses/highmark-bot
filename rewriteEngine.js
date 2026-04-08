// ─────────────────────────────────────────────────────────────────────────────
// PHASE 8 — AI Message Rewrite Engine
//
// Identifies weak bot responses from real conversations, generates improved
// versions using Claude Haiku, stores as suggestions for user review.
// Accepted rewrites are injected into the system prompt at runtime.
//
// Exports:
//   identifyRewriteCandidates(supabase, clientId)
//     → finds drop-off conversations, extracts last bot message per convo
//   generateRewrite(anthropic, candidate, client)
//     → single Haiku call → { rewritten_message, rewrite_reason, rewrite_pattern }
//   runRewriteGeneration(supabase, anthropic, client)
//     → full pipeline: candidates → generate → persist → auto-apply if enabled
//   getRewriteSuggestions(supabase, clientId)
//     → fetch all non-rejected rewrites for portal display
//   updateRewriteStatus(supabase, id, clientId, status, editedMessage, reviewerEmail)
//     → accept | reject | edit (versioned)
//   getAcceptedRewriteInstruction(supabase, clientId)
//     → cached system-prompt fragment for runtime injection
//   invalidateRewriteCache(clientId)
//     → call after accept/reject to flush the runtime cache
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_WINDOW_DAYS  = 30;
const MAX_CANDIDATES      = 8;    // max rewrites generated per run
const REWRITE_CACHE_TTL   = 5 * 60 * 1000;   // 5 min
const MAX_INJECTED_PATTERNS = 5;  // cap system-prompt examples to keep prompt tight

// ── Candidate identification ──────────────────────────────────────────────────

export async function identifyRewriteCandidates(supabase, clientId) {
  const since = new Date(Date.now() - SAMPLE_WINDOW_DAYS * 86400_000).toISOString();

  const { data: convos } = await supabase
    .from("conversations")
    .select("from_number, to_number, messages, booking_step, booking_data, handoff, updated_at")
    .eq("client_id", clientId)
    .neq("session_type", "test")
    .gte("created_at", since)
    .order("updated_at", { ascending: false })
    .limit(200);

  if (!convos?.length) return [];

  const candidates = [];

  for (const convo of convos) {
    const messages  = convo.messages ?? [];
    const userMsgs  = messages.filter(m => m.role === "user");
    const botMsgs   = messages.filter(m => m.role === "assistant");

    // Need at least 2 user turns + 1 bot reply
    if (userMsgs.length < 2 || !botMsgs.length) continue;

    // Skip conversations that ended positively
    if ((convo.booking_step ?? 0) > 0) continue;
    if (convo.handoff) continue;
    const stage = (convo.booking_data ?? {})._stage ?? "new";
    if (["lead_captured", "closed"].includes(stage)) continue;

    // Must have been inactive for at least 1 day (dropped off)
    const daysSince = (Date.now() - new Date(convo.updated_at).getTime()) / 86400_000;
    if (daysSince < 1) continue;

    const lastBotMsg  = botMsgs.at(-1);
    const lastUserMsg = userMsgs.at(-1);
    if (!lastBotMsg?.content) continue;

    // Don't sample extremely short bot messages (they're usually nav/menu items)
    if (lastBotMsg.content.length < 40) continue;

    const intents    = messages.map(m => m.intent).filter(Boolean);
    const sentiments = messages.map(m => m.sentiment).filter(Boolean);
    const lastUser   = lastUserMsg?.content ?? "";

    // Map to a Phase 7 insight type
    let insightType = "early_dropoff";
    if (intents.includes("booking") || intents.includes("availability")) insightType = "booking_gap";
    if (/price|pric|cost|how much|fee|rate/i.test(lastUser))             insightType = "pricing_no_action";
    if (sentiments.includes("frustrated"))                                insightType = "frustrated";
    if (intents.includes("recommendation"))                               insightType = "missed_lead";

    candidates.push({
      conversation_id:  null,
      original_message: lastBotMsg.content.slice(0, 600),
      context_summary:  lastUser.slice(0, 200),
      insight_type:     insightType,
      stage,
      intents,
    });

    if (candidates.length >= MAX_CANDIDATES) break;
  }

  return candidates;
}

// ── Rewrite generation ────────────────────────────────────────────────────────

const PATTERN_HINTS = {
  booking_gap:       "add a clear, specific CTA to book or check availability",
  pricing_no_action: "answer the pricing question and immediately offer a next step",
  early_dropoff:     "be more engaging, more specific, and end with a direct question",
  frustrated:        "be concise, empathetic, and resolve the issue in one message",
  missed_lead:       "gently offer to capture their info or connect them to the team",
};

const VALID_PATTERNS = new Set(["add_cta", "increase_specificity", "reduce_friction", "add_urgency", "shorten"]);

export async function generateRewrite(anthropic, candidate, client) {
  const hint = PATTERN_HINTS[candidate.insight_type] ?? "improve clarity and drive a clear next step";

  const prompt = `You are improving a real SMS chatbot response for ${client.name}.

Bot personality: ${client.tone ?? "warm, helpful, and knowledgeable"}
Issue: ${candidate.insight_type} — user dropped off after this exchange

Customer said:
"${candidate.context_summary}"

Bot replied:
"${candidate.original_message}"

The user then went silent. Rewrite the bot response to ${hint}.

Hard rules:
- Under 320 characters total
- Do NOT invent services, pricing, or policies not implied by context
- Do NOT ask for a phone number (this is SMS — you already have it)
- Do NOT add emojis unless the original had them
- End with one specific question or offer

Respond with valid JSON only — no markdown, no explanation outside the JSON:
{
  "rewritten_message": "the improved response",
  "rewrite_reason": "one sentence: what specifically makes this better",
  "rewrite_pattern": "add_cta|increase_specificity|reduce_friction|add_urgency|shorten"
}`;

  try {
    const resp = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages:   [{ role: "user", content: prompt }],
    });

    const raw   = resp.content[0].text.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    if (!parsed.rewritten_message || !parsed.rewrite_reason) return null;

    const pattern = VALID_PATTERNS.has(parsed.rewrite_pattern) ? parsed.rewrite_pattern : "add_cta";

    return {
      rewritten_message: parsed.rewritten_message.slice(0, 400),
      rewrite_reason:    parsed.rewrite_reason.slice(0, 500),
      rewrite_pattern:   pattern,
    };
  } catch {
    return null;
  }
}

// ── Persist ───────────────────────────────────────────────────────────────────

export async function storeRewrite(supabase, clientId, candidate, rewrite) {
  const autoEligible = ["add_cta", "shorten"].includes(rewrite.rewrite_pattern);
  const { data, error } = await supabase.from("message_rewrites").insert({
    client_id:          clientId,
    conversation_id:    candidate.conversation_id ?? null,
    original_message:   candidate.original_message,
    context_summary:    candidate.context_summary,
    insight_type:       candidate.insight_type,
    rewritten_message:  rewrite.rewritten_message,
    rewrite_reason:     rewrite.rewrite_reason,
    rewrite_pattern:    rewrite.rewrite_pattern,
    auto_apply_eligible:autoEligible,
    version_history:    JSON.stringify([{
      version:    1,
      message:    rewrite.rewritten_message,
      source:     "ai",
      created_at: new Date().toISOString(),
    }]),
  }).select("id").single();

  return { id: data?.id ?? null, error: error?.message ?? null };
}

// ── Retrieve ──────────────────────────────────────────────────────────────────

export async function getRewriteSuggestions(supabase, clientId) {
  const { data, error } = await supabase
    .from("message_rewrites")
    .select("id, insight_type, original_message, context_summary, rewritten_message, rewrite_reason, rewrite_pattern, status, auto_apply_eligible, version, version_history, created_at, reviewed_at")
    .eq("client_id", clientId)
    .neq("status", "rejected")
    .order("created_at", { ascending: false })
    .limit(20);

  return { suggestions: data ?? [], error: error?.message ?? null };
}

// ── Update status ─────────────────────────────────────────────────────────────

export async function updateRewriteStatus(supabase, id, clientId, status, editedMessage, reviewerEmail) {
  const valid = ["accepted", "rejected", "auto_applied", "pending"];
  if (!valid.includes(status)) return { error: `Invalid status: ${status}` };

  const updates = {
    status,
    reviewed_at: new Date().toISOString(),
    reviewed_by: reviewerEmail ?? null,
  };

  // If accepting with an edit, version the message
  if (status === "accepted" && editedMessage) {
    const { data: existing } = await supabase
      .from("message_rewrites")
      .select("version, version_history")
      .eq("id", id)
      .eq("client_id", clientId)
      .single();

    if (existing) {
      const newVersion = (existing.version ?? 1) + 1;
      const history    = JSON.parse(existing.version_history ?? "[]");
      history.push({
        version:    newVersion,
        message:    editedMessage.slice(0, 400),
        source:     "manual",
        created_at: new Date().toISOString(),
      });
      updates.rewritten_message = editedMessage.slice(0, 400);
      updates.version           = newVersion;
      updates.version_history   = JSON.stringify(history);
    }
  }

  const { error } = await supabase
    .from("message_rewrites")
    .update(updates)
    .eq("id", id)
    .eq("client_id", clientId);

  if (!error) invalidateRewriteCache(clientId);
  return { error: error?.message ?? null };
}

// ── Runtime injection ─────────────────────────────────────────────────────────
// Returns a compact system-prompt fragment listing accepted response patterns.
// Cached per client to avoid a DB round-trip on every SMS.

const _rewriteCache = new Map();  // clientId → { instruction, ts }

export async function getAcceptedRewriteInstruction(supabase, clientId) {
  if (!supabase || !clientId) return "";

  const cached = _rewriteCache.get(clientId);
  if (cached && Date.now() - cached.ts < REWRITE_CACHE_TTL) return cached.instruction;

  try {
    const { data } = await supabase
      .from("message_rewrites")
      .select("original_message, rewritten_message, rewrite_reason, rewrite_pattern")
      .eq("client_id", clientId)
      .in("status", ["accepted", "auto_applied"])
      .order("reviewed_at", { ascending: false })
      .limit(MAX_INJECTED_PATTERNS);

    if (!data?.length) {
      _rewriteCache.set(clientId, { instruction: "", ts: Date.now() });
      return "";
    }

    const lines = data.map((r, i) =>
      `Pattern ${i + 1} [${r.rewrite_pattern}]:\n` +
      `Avoid: "${r.original_message.slice(0, 120)}"\n` +
      `Prefer: "${r.rewritten_message.slice(0, 200)}"\n` +
      `Why: ${r.rewrite_reason}`
    ).join("\n\n");

    const instruction =
      `━━━ APPROVED RESPONSE PATTERNS ━━━\n` +
      `These response styles have been approved for this client. Follow them:\n\n${lines}`;

    _rewriteCache.set(clientId, { instruction, ts: Date.now() });
    return instruction;
  } catch {
    return "";
  }
}

export function invalidateRewriteCache(clientId) {
  _rewriteCache.delete(clientId);
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

export async function runRewriteGeneration(supabase, anthropic, client) {
  if (!supabase || !anthropic || !client?.id) {
    return { ok: false, error: "Missing required params" };
  }

  try {
    // Clear stale pending suggestions — fresh run replaces them
    await supabase
      .from("message_rewrites")
      .delete()
      .eq("client_id", client.id)
      .eq("status", "pending");

    const candidates = await identifyRewriteCandidates(supabase, client.id);
    if (!candidates.length) {
      return { ok: true, skipped: true, reason: "no_candidates", generated: 0 };
    }

    // Check if auto-apply is enabled for this client
    let autoApply = false;
    try {
      const { data: bc } = await supabase
        .from("bot_config")
        .select("rewrite_auto_apply")
        .eq("client_id", client.id)
        .maybeSingle();
      autoApply = !!bc?.rewrite_auto_apply;
    } catch { /* table may not exist yet */ }

    let generated = 0;
    let autoApplied = 0;
    let errors = 0;

    for (const candidate of candidates) {
      const rewrite = await generateRewrite(anthropic, candidate, client);
      if (!rewrite) { errors++; continue; }

      const { id, error } = await storeRewrite(supabase, client.id, candidate, rewrite);
      if (error || !id) { errors++; continue; }

      generated++;

      // Auto-apply if enabled and pattern is safe
      if (autoApply && rewrite.auto_apply_eligible !== false) {
        const eligible = ["add_cta", "shorten"].includes(rewrite.rewrite_pattern);
        if (eligible) {
          await supabase
            .from("message_rewrites")
            .update({ status: "auto_applied", reviewed_at: new Date().toISOString() })
            .eq("id", id);
          autoApplied++;
        }
      }
    }

    if (generated > 0) invalidateRewriteCache(client.id);

    console.log(`[REWRITE] ${client.id}: ${generated} generated, ${autoApplied} auto-applied, ${errors} errors`);
    return { ok: true, generated, autoApplied, candidates: candidates.length, errors };
  } catch (err) {
    console.error(`[REWRITE] Failed for ${client.id}:`, err.message);
    return { ok: false, error: err.message };
  }
}
