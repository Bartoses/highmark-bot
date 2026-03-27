// ─────────────────────────────────────────────────────────────────────────────
// ADMIN LEADS — Internal lead management routes
//
// Mounted in index.js under requireUiAccess middleware.
// All routes read/write the leads table in Supabase DB1.
//
// Routes:
//   GET  /admin/leads            — list + filter leads
//   PATCH /admin/leads/:id       — update status / notes
//   GET  /admin/leads/summary    — aggregate counts by status + lead_type
// ─────────────────────────────────────────────────────────────────────────────

const VALID_STATUSES = ["new", "contacted", "scheduled", "closed", "ignored"];

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/leads
// Query params: client_id, status, lead_type, limit (default 50), offset (default 0)
// Returns: { leads: [...], total: N }
// ─────────────────────────────────────────────────────────────────────────────
export async function handleListLeads(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { client_id, status, lead_type, limit = 50, offset = 0 } = req.query;

  let query = supabase
    .from("leads")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (client_id) query = query.eq("client_id", client_id);
  if (status)    query = query.eq("status", status);
  if (lead_type) query = query.eq("lead_type", lead_type);

  const { data, error, count } = await query;

  if (error) {
    console.error("[ADMIN LEADS] list error:", error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.json({ leads: data ?? [], total: count ?? 0 });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /admin/leads/:id
// Body: { status?, notes?, updated_by? }
// Returns: { lead: {...} }
// ─────────────────────────────────────────────────────────────────────────────
export async function handleUpdateLead(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { id } = req.params;
  const { status, notes, updated_by } = req.body ?? {};

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
    });
  }

  const updates = { updated_at: new Date().toISOString() };
  if (status     !== undefined) updates.status     = status;
  if (notes      !== undefined) updates.notes      = notes;
  if (updated_by !== undefined) updates.updated_by = updated_by;

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: "No updatable fields provided (status, notes, updated_by)" });
  }

  const { data, error } = await supabase
    .from("leads")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[ADMIN LEADS] update error:", error.message);
    return res.status(500).json({ error: error.message });
  }
  if (!data) return res.status(404).json({ error: "Lead not found" });

  console.log(`[ADMIN LEADS] ${id} → status=${data.status} by=${updated_by ?? "unknown"}`);
  return res.json({ lead: data });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/leads/summary
// Query params: client_id (optional)
// Returns: { by_status: {...}, by_type: {...}, total: N }
// ─────────────────────────────────────────────────────────────────────────────
export async function handleLeadsSummary(req, res, supabase) {
  if (!supabase) return res.status(503).json({ error: "DB unavailable" });

  const { client_id } = req.query;

  let query = supabase.from("leads").select("status, lead_type");
  if (client_id) query = query.eq("client_id", client_id);

  const { data, error } = await query;

  if (error) {
    console.error("[ADMIN LEADS] summary error:", error.message);
    return res.status(500).json({ error: error.message });
  }

  const leads = data ?? [];
  const by_status = {};
  const by_type   = {};

  // Seed all known statuses at 0 so the response is always a complete set
  for (const s of VALID_STATUSES) by_status[s] = 0;

  for (const row of leads) {
    by_status[row.status]               = (by_status[row.status]   ?? 0) + 1;
    by_type[row.lead_type ?? "booking"] = (by_type[row.lead_type ?? "booking"] ?? 0) + 1;
  }

  return res.json({ by_status, by_type, total: leads.length });
}
