// ─────────────────────────────────────────────────────────────────────────────
// adminConversations.js — Portal conversations API
// Phase 2A: unified SMS + web chat conversation viewer with pause/resume/send
//
// Routes (all require portal auth, wired in index.js):
//   GET    /portal/api/conversations                  — paginated list
//   GET    /portal/api/conversations/badge-count      — unresolved handoff count
//   GET    /portal/api/conversations/:id              — full thread
//   POST   /portal/api/conversations/:id/pause        — pause bot
//   POST   /portal/api/conversations/:id/resume       — resume bot + resolve handoff
//   POST   /portal/api/conversations/:id/send         — agent send message
//   POST   /portal/api/conversations/:id/suggest      — AI-suggested reply
// ─────────────────────────────────────────────────────────────────────────────

import { resolvePortalClientId } from "./portalAuth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared utilities (also exported for test.js)
// ─────────────────────────────────────────────────────────────────────────────

export function detectChannel(fromNumber) {
  return fromNumber?.startsWith("web:") ? "web" : "sms";
}

export function maskPhone(fromNumber) {
  if (!fromNumber) return "Unknown";
  if (fromNumber.startsWith("web:")) {
    const uuid = fromNumber.replace("web:", "");
    return `Web visitor · ****${uuid.slice(-4)}`;
  }
  const digits = fromNumber.replace(/\D/g, "");
  if (digits.length < 4) return fromNumber;
  return `+1 ••• ••• ${digits.slice(-4)}`;
}

function stageColor(stage) {
  const map = {
    new:           "#6b7280",
    discovery:     "#3b82f6",
    engaged:       "#14b8a6",
    considering:   "#f59e0b",
    high_intent:   "#f97316",
    lead_captured: "#22c55e",
    handoff:       "#ef4444",
    closed:        "#4b5563",
  };
  return map[stage] ?? "#6b7280";
}

function lastMessageSnippet(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const last = messages[messages.length - 1];
  const text = last?.content ?? "";
  return text.length > 80 ? text.slice(0, 80) + "…" : text;
}

function getStage(row) {
  // Stage is persisted inside booking_data._stage
  return row.booking_data?._stage ?? "new";
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/conversations
// Query: page (1), limit (30), filter (all|sms|web|handoff)
// ─────────────────────────────────────────────────────────────────────────────
export async function handleListConversations(req, res, supabase) {
  try {
    const clientId = resolvePortalClientId(req);
    if (!clientId) return res.status(400).json({ error: "client_id required" });

    const page   = Math.max(1, parseInt(req.query.page  ?? "1",  10));
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit ?? "30", 10)));
    const filter = req.query.filter ?? "all";
    const offset = (page - 1) * limit;

    let query = supabase
      .from("conversations")
      .select("id, from_number, to_number, messages, booking_data, handoff, handoff_resolved, bot_paused, channel, updated_at, session_type", { count: "exact" })
      .eq("client_id", clientId)
      .neq("session_type", "test")           // hide automated test sessions
      .order("updated_at", { ascending: false });

    if (filter === "sms")     query = query.not("from_number", "like", "web:%");
    if (filter === "web")     query = query.like("from_number", "web:%");
    if (filter === "handoff") query = query.eq("handoff", true).eq("handoff_resolved", false);

    const { data, error, count } = await query.range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: error.message });

    const conversations = (data ?? []).map(row => {
      const channel = row.channel ?? detectChannel(row.from_number);
      const stage   = getStage(row);
      const msgs    = row.messages ?? [];
      const lastMsg = msgs[msgs.length - 1];
      return {
        id:                  row.id,
        from_number:         row.from_number,
        masked_label:        maskPhone(row.from_number),
        channel,
        last_message_snippet: lastMessageSnippet(msgs),
        last_message_at:     lastMsg?.timestamp ?? row.updated_at,
        stage,
        stage_color:         stageColor(stage),
        handoff:             row.handoff ?? false,
        handoff_resolved:    row.handoff_resolved ?? false,
        bot_paused:          row.bot_paused ?? false,
        message_count:       msgs.length,
      };
    });

    return res.json({
      conversations,
      total: count ?? conversations.length,
      page,
      pages: Math.ceil((count ?? conversations.length) / limit),
    });
  } catch (err) {
    console.error("[CONV] list error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/conversations/badge-count
// Returns count of unresolved handoffs for this client (sidebar badge)
// ─────────────────────────────────────────────────────────────────────────────
export async function handleConversationBadgeCount(req, res, supabase) {
  try {
    const clientId = resolvePortalClientId(req);
    if (!clientId) return res.status(400).json({ error: "client_id required" });

    const { count, error } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId)
      .eq("handoff", true)
      .eq("handoff_resolved", false)
      .neq("session_type", "test");

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ count: count ?? 0 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /portal/api/conversations/:id
// Returns full thread with metadata
// ─────────────────────────────────────────────────────────────────────────────
export async function handleGetConversation(req, res, supabase) {
  try {
    const clientId = resolvePortalClientId(req);
    if (!clientId) return res.status(400).json({ error: "client_id required" });

    const { data, error } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", req.params.id)
      .eq("client_id", clientId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: "Conversation not found" });

    const channel = data.channel ?? detectChannel(data.from_number);
    const stage   = getStage(data);
    const msgs    = (data.messages ?? []).map((m, i) => ({
      ...m,
      _idx: i,
      // Ensure timestamps exist
      timestamp: m.timestamp ?? data.updated_at,
    }));

    return res.json({
      conversation: {
        id:               data.id,
        from_number:      data.from_number,
        masked_label:     maskPhone(data.from_number),
        channel,
        stage,
        stage_color:      stageColor(stage),
        handoff:          data.handoff          ?? false,
        handoff_resolved: data.handoff_resolved ?? false,
        bot_paused:       data.bot_paused       ?? false,
        bot_paused_by:    data.bot_paused_by    ?? null,
        bot_paused_at:    data.bot_paused_at    ?? null,
        updated_at:       data.updated_at,
      },
      messages: msgs,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /portal/api/conversations/:id/pause
// ─────────────────────────────────────────────────────────────────────────────
export async function handlePauseConversation(req, res, supabase) {
  try {
    const clientId = resolvePortalClientId(req);
    if (!clientId) return res.status(400).json({ error: "client_id required" });

    const pausedBy = req.portalUser?.userId ?? req.portalUser?.email ?? "agent";

    const { error } = await supabase
      .from("conversations")
      .update({
        bot_paused:    true,
        bot_paused_by: pausedBy,
        bot_paused_at: new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .eq("client_id", clientId);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /portal/api/conversations/:id/resume
// ─────────────────────────────────────────────────────────────────────────────
export async function handleResumeConversation(req, res, supabase) {
  try {
    const clientId = resolvePortalClientId(req);
    if (!clientId) return res.status(400).json({ error: "client_id required" });

    const { error } = await supabase
      .from("conversations")
      .update({
        bot_paused:       false,
        bot_paused_by:    null,
        bot_paused_at:    null,
        handoff_resolved: true,
        updated_at:       new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .eq("client_id", clientId);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /portal/api/conversations/:id/send
// Body: { message: "text" }
// SMS: sends via Twilio (skipped in TEST_MODE but saved to DB)
// Web: stores in messages array, no Twilio
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSendAgentMessage(req, res, supabase, twilioClient) {
  try {
    const clientId = resolvePortalClientId(req);
    if (!clientId) return res.status(400).json({ error: "client_id required" });

    const message = (req.body.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });

    // Load conversation (need from_number, to_number, messages)
    const { data, error: fetchErr } = await supabase
      .from("conversations")
      .select("from_number, to_number, messages, channel")
      .eq("id", req.params.id)
      .eq("client_id", clientId)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!data)    return res.status(404).json({ error: "Conversation not found" });

    const channel  = data.channel ?? detectChannel(data.from_number);
    const agentMsg = {
      role:        "agent",
      content:     message,
      timestamp:   new Date().toISOString(),
      sender_type: "agent",
    };

    const updatedMessages = [...(data.messages ?? []), agentMsg];

    // Persist to DB first (always)
    const { error: saveErr } = await supabase
      .from("conversations")
      .update({ messages: updatedMessages, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("client_id", clientId);

    if (saveErr) return res.status(500).json({ error: saveErr.message });

    // For SMS: send via Twilio (skip in TEST_MODE)
    if (channel === "sms") {
      if (process.env.TEST_MODE === "true") {
        console.log(`[AGENT_SEND] TEST_MODE — skipped Twilio send to ${data.from_number}: "${message}"`);
      } else if (twilioClient) {
        try {
          await twilioClient.messages.create({
            body: message,
            from: data.to_number,
            to:   data.from_number,
          });
          console.log(`[AGENT_SEND] SMS sent to ${data.from_number} via ${data.to_number}`);
        } catch (twilioErr) {
          console.error("[AGENT_SEND] Twilio error:", twilioErr.message);
          // Message is saved to DB; Twilio failure is non-fatal from the portal's perspective
          return res.json({ success: true, twilio_error: twilioErr.message });
        }
      }
    }
    // Web sessions: DB-only, no Twilio needed

    return res.json({ success: true });
  } catch (err) {
    console.error("[AGENT_SEND] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /portal/api/conversations/:id/suggest
// AI-suggested reply based on last 6 messages + client tone
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSuggestReply(req, res, supabase, anthropic) {
  try {
    const clientId = resolvePortalClientId(req);
    if (!clientId) return res.status(400).json({ error: "client_id required" });

    const { data, error: fetchErr } = await supabase
      .from("conversations")
      .select("messages, booking_data")
      .eq("id", req.params.id)
      .eq("client_id", clientId)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!data)    return res.status(404).json({ error: "Conversation not found" });

    const messages = data.messages ?? [];
    if (messages.length === 0) return res.json({ suggestion: "" });

    // Get client name for tone
    const { data: clientRow } = await supabase
      .from("clients")
      .select("name, tone")
      .eq("id", clientId)
      .maybeSingle();

    const businessName = clientRow?.name ?? clientId;
    const tone         = clientRow?.tone ?? "warm and helpful";

    // Build last 6 messages context (exclude agent messages from context)
    const contextMsgs = messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .slice(-6)
      .map(m => ({
        role:    m.role === "user" ? "user" : "assistant",
        content: m.content ?? "",
      }));

    if (!anthropic) return res.status(503).json({ error: "AI not available" });

    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `You are helping a human agent at ${businessName} respond to a customer message.
Tone: ${tone}.
Suggest a single helpful reply the agent could send. Match the established bot tone.
One short paragraph max. Reply with ONLY the suggested message text — no quotes, no preamble.`,
      messages: contextMsgs,
    });

    const suggestion = response.content?.[0]?.text?.trim() ?? "";
    return res.json({ suggestion });
  } catch (err) {
    console.error("[SUGGEST] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
