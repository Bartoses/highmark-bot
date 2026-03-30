// adminSiteContent.js — Admin endpoints for website content management
//
// Routes (all require requireUiAccess):
//   GET  /admin/site-content              — all sections (DB merged with defaults)
//   GET  /admin/site-content/:section     — single section
//   PATCH /admin/site-content/:section    — update a section (partial or full)
//
// The PATCH body is a JSON object that will be merged with the section's defaults.
// To update a single field: PATCH /admin/site-content/hero { "headline": "New copy" }
// To replace pricing tiers:  PATCH /admin/site-content/pricing { "tiers": [...] }
// To clear a section back to defaults: PATCH with {} (empty object)

import {
  DEFAULTS,
  SECTION_KEYS,
  loadSiteContent,
  getSiteSection,
  updateSiteSection,
} from "./siteContent.js";

export async function handleListSiteContent(req, res, supabase) {
  try {
    const content = await loadSiteContent(supabase);
    res.json({ sections: SECTION_KEYS, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function handleGetSiteSection(req, res, supabase) {
  const { section } = req.params;
  if (!SECTION_KEYS.includes(section)) {
    return res.status(404).json({
      error: `Unknown section: "${section}". Valid sections: ${SECTION_KEYS.join(", ")}`,
    });
  }
  try {
    const content = await getSiteSection(supabase, section);
    res.json({ section, content, default: DEFAULTS[section] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function handleUpdateSiteSection(req, res, supabase) {
  const { section } = req.params;
  if (!SECTION_KEYS.includes(section)) {
    return res.status(404).json({
      error: `Unknown section: "${section}". Valid sections: ${SECTION_KEYS.join(", ")}`,
    });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Request body must be a JSON object" });
  }

  // Validate pricing tiers if present
  if (section === "pricing" && body.tiers !== undefined) {
    if (!Array.isArray(body.tiers)) {
      return res.status(400).json({ error: "pricing.tiers must be an array" });
    }
    for (const tier of body.tiers) {
      if (!tier.id || !tier.name) {
        return res.status(400).json({ error: "Each pricing tier must have id and name" });
      }
    }
  }

  // Validate FAQ items if present
  if (section === "faq" && body.items !== undefined) {
    if (!Array.isArray(body.items)) {
      return res.status(400).json({ error: "faq.items must be an array" });
    }
    for (const item of body.items) {
      if (!item.q || !item.a) {
        return res.status(400).json({ error: "Each FAQ item must have q and a" });
      }
    }
  }

  try {
    await updateSiteSection(supabase, section, body);
    const merged = await getSiteSection(supabase, section);
    res.json({ section, content: merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
