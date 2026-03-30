// ─────────────────────────────────────────────────────────────────────────────
// ADMIN SCHEDULED MESSAGES — Internal visibility into the follow-up queue
//
// Mounted in index.js under requireUiAccess middleware.
//
// Routes:
//   GET /admin/scheduled-messages — list messages with optional filters
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/scheduled-messages
// Query params: status, lead_id, client_id, since, limit (max 200, default 50)
// Returns: { messages: [...], count: N }
// ─────────────────────────────────────────────────────────────────────────────
export async function handleListScheduledMessages(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const limit     = Math.min(parseInt(req.query.limit) || 50, 200);
  const { status, lead_id, client_id, since } = req.query;

  let query = supabase
    .from("scheduled_messages")
    .select("*")
    .order("send_at", { ascending: false })
    .limit(limit);

  if (status)    query = query.eq("status", status);
  if (lead_id)   query = query.eq("lead_id", lead_id);
  if (client_id) query = query.eq("client_id", client_id);
  if (since)     query = query.gte("created_at", since);

  const { data, error } = await query;

  if (error) {
    console.error("[ADMIN SCHED] list error:", error.message);
    return res.status(500).json({ error: error.message });
  }

  const messages = data ?? [];
  return res.json({ messages, count: messages.length });
}
