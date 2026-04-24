// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE ENGINE — Phase 11.4: Multi-Channel Unified Core
//
// Shared utilities used by all channels (SMS, web, future channels).
// Eliminates duplicate Claude call logic between index.js and webChat.js.
//
// Exports:
//   callClaudeForChannel(...)   — single Claude call for any channel
//   buildChannelInstruction(...)— channel-aware Claude instruction block
//
// Circular-import note: this file imports from index.js (buildSystemPrompt,
// enforceLength). Node ESM resolves these lazily — safe because the functions
// are only called at request time, never at module load time.
// ─────────────────────────────────────────────────────────────────────────────

import { buildSystemPrompt, enforceLength } from "./index.js";

// Installed Anthropic SDK (0.20.9) silently drops `cache_control` from request
// bodies. We call the API directly here so we can opt the stable system block
// into prompt caching (5-min ephemeral TTL) — cuts input-token cost by ~90%
// on cache hits and shaves a few hundred ms off every LLM turn after the first.
// If the raw call fails, we fall back to the SDK path to preserve availability.
async function callAnthropicCached({ apiKey, model, maxTokens, systemBlocks, messages }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "content-type":     "application/json",
      "x-api-key":        apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemBlocks, messages }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// callClaudeForChannel — the ONE Claude call for all channels
//
// Replaces:
//   - getClaudeReply()  in index.js   (SMS, 450 tok, 320 chars default)
//   - callClaude()      in webChat.js  (web, 550 tok, 480 chars default)
//
// channel:         "sms" | "web" | "test"
// maxLengthOverride: when provided, overrides the channel default length cap.
//                    Pass null to skip length enforcement (e.g. when a URL is expected).
// ─────────────────────────────────────────────────────────────────────────────
export async function callClaudeForChannel(
  anthropic,
  convo,
  client,
  season,
  knowledgeCtx,
  extraInstruction,
  channel,
  maxLengthOverride = undefined,
) {
  const isWeb     = channel === "web";
  const maxTokens = isWeb ? 550 : 450;
  const maxLength = maxLengthOverride !== undefined
    ? maxLengthOverride          // explicit override (null = no limit)
    : (isWeb ? 480 : 320);       // channel default

  const messages = convo.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map(({ role, content }) => ({ role, content }));

  // Split stable (cacheable) vs volatile (per-turn) system content.
  // Stable = persona + rules + booking info. Reused across every turn in a session.
  // Volatile = LIVE DATA (weather/availability, rotates hourly) + turn-specific plan.
  const stableSystem   = buildSystemPrompt(client, season, "");
  const volatileParts  = [];
  if (knowledgeCtx)    volatileParts.push(`━━━ LIVE DATA ━━━\n${knowledgeCtx}`);
  if (extraInstruction) volatileParts.push(`CURRENT CONTEXT: ${extraInstruction}`);
  const volatile = volatileParts.join("\n\n");

  const systemBlocks = [
    { type: "text", text: stableSystem, cache_control: { type: "ephemeral" } },
  ];
  if (volatile) systemBlocks.push({ type: "text", text: volatile });

  const model = "claude-sonnet-4-6";
  let text;
  try {
    const response = await callAnthropicCached({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model, maxTokens, systemBlocks, messages,
    });
    text = response.content[0].text;
  } catch (err) {
    // Fallback to SDK with flat string system — preserves availability if the
    // direct call fails (network, auth, schema). Cache is lost for this turn.
    console.warn("[callClaudeForChannel] cached-path failed, falling back to SDK:", err.message);
    const flatSystem = volatile ? `${stableSystem}\n\n${volatile}` : stableSystem;
    const response = await anthropic.messages.create({
      model, max_tokens: maxTokens, system: flatSystem, messages,
    });
    text = response.content[0].text;
  }

  // Never truncate replies that contain URLs — the link must arrive intact
  if (maxLength === null || /https?:\/\//.test(text)) return text;
  return enforceLength(text, maxLength);
}

// ─────────────────────────────────────────────────────────────────────────────
// buildChannelInstruction — channel-aware instruction block for the system prompt
//
// Returns a string that gets appended to CURRENT CONTEXT before the Claude call.
// Handles: channel identity, phone-number rules, booking link injection, plan cues.
//
// opts.resolvedLink   — { url } from resolveBookingLink(), or null
// opts.plan           — response plan from buildResponsePlan(), or null
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// detectPageType — infer page context from the URL path when data-page isn't set.
//
// Returns one of: "rzr" | "snowmobile" | "tours" | "bike" | "homepage" | null
// Returns null for generic/unrecognized pages (no injection — avoids noise).
//
// Called by sendMessageWeb when pageHint is null but pageUrl is available.
// ─────────────────────────────────────────────────────────────────────────────
export function detectPageType(pageUrl) {
  if (!pageUrl) return null;
  try {
    const path = new URL(pageUrl).pathname.toLowerCase();
    if (/rzr|utv|off.?road|polaris/i.test(path))   return "rzr";
    if (/snowmobile|sled|snow/i.test(path))          return "snowmobile";
    if (/tour|guided|adventure/i.test(path))         return "tours";
    if (/bike|mtb|mountain.?bike/i.test(path))       return "bike";
    if (path === "/" || path === "")                  return "homepage";
  } catch { /* invalid URL — fall through */ }
  return null; // unrecognized path — skip injection to avoid noise
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11.7: CTA framing phrases — keyed by effective page type.
// Used to persuasively frame booking links when intent === "booking" (web only).
// ─────────────────────────────────────────────────────────────────────────────
const STRONG_CTA_PHRASES = {
  rzr:        "Frame it naturally, e.g. 'Best move is to grab a RZR spot here — takes 2 minutes:'",
  snowmobile: "Frame it naturally, e.g. 'You can lock in a snowmobile tour here:'",
  tours:      "Frame it naturally, e.g. 'Easiest way is to lock it in here:'",
  bike:       "Frame it naturally, e.g. 'You can grab a bike spot here:'",
  homepage:   "Frame it naturally, e.g. 'Best move is to lock it in here:'",
  default:    "Frame it naturally, e.g. 'Best move is to lock it in here:' or 'You can grab a spot here:'",
};

// Subtle, general urgency hints. Rotated by message count. Never invent specific slot counts.
const URGENCY_HINTS = [
  "Weekends fill up fast this time of year.",
  "Spots can go quick — earlier bookings tend to get the best time slots.",
  "Morning departures fill up first, especially on weekends.",
];

// Page type → concise Claude guidance (what to lead with on ambiguous first messages)
const PAGE_TYPE_GUIDANCE = {
  rzr:         "The visitor is on the RZR / off-road page. Lead with RZR rental options, terrain suggestions, or availability. Assume off-road interest unless they indicate otherwise.",
  snowmobile:  "The visitor is on the snowmobile page. Lead with snowmobile tours or rentals, trail conditions, or guided vs. self-guided options. Assume snowmobile interest.",
  tours:       "The visitor is on the tours page. Lead with guided tour options — highlight the experience, beginner friendliness, and ease of booking.",
  bike:        "The visitor is on the bike / MTB page. Lead with bike-related services or tours relevant to this client.",
  homepage:    "The visitor is on the homepage. They may be exploring — lead with the most popular option for the season, or ask a single light clarifying question.",
};

// ─────────────────────────────────────────────────────────────────────────────
// buildChannelInstruction — channel-aware instruction block for the system prompt
//
// opts.pageHint       — explicit label from data-page attribute ("rzr", "tours", …)
// opts.pageType       — auto-detected type from detectPageType(pageUrl); used when pageHint is null
// opts.resolvedLink   — { url } from resolveBookingLink(), or null
// opts.plan           — response plan from buildResponsePlan(), or null
// opts.intent         — classified intent for this turn ("booking", "question", …) [Phase 11.7]
// opts.conversionState— { last_intent, last_cta_type, urgency_used } from booking_data [Phase 11.7]
// opts.messageCount   — number of user messages so far (for urgency gating) [Phase 11.7]
// ─────────────────────────────────────────────────────────────────────────────
export function buildChannelInstruction(channel, { resolvedLink = null, plan = null, pageHint = null, pageType = null, intent = null, conversionState = null, messageCount = 0 } = {}) {
  const parts = [];

  if (channel === "web") {
    parts.push(
      "CHANNEL: This is a web chat widget (not SMS). The visitor has NOT provided a phone number.",
      "Do NOT ask for a phone number. If you need contact info, ask for their name and email instead.",
    );
  } else if (channel === "sms") {
    parts.push(
      "CHANNEL: SMS. You already have the guest's phone number — NEVER ask for it.",
    );
  }

  // Page context: explicit label (data-page) takes precedence over auto-detected type
  if (pageHint) {
    // Sanitize: only pass through simple alphanumeric + space values
    const safe = String(pageHint).replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 60).trim();
    if (safe) {
      const guidance = PAGE_TYPE_GUIDANCE[safe.toLowerCase()] ?? null;
      parts.push(guidance
        ? `PAGE CONTEXT: ${guidance}`
        : `PAGE CONTEXT: The visitor is browsing the "${safe}" section of the website. Lead with that topic if their message is ambiguous — don't ask them to clarify what they're interested in.`
      );
    }
  } else if (pageType && PAGE_TYPE_GUIDANCE[pageType]) {
    // Auto-detected from URL — same guidance, no need to expose the detection mechanism to Claude
    parts.push(`PAGE CONTEXT: ${PAGE_TYPE_GUIDANCE[pageType]}`);
  }

  if (resolvedLink?.url) {
    parts.push(
      `BOOKING LINK: Include this exact URL in your response (do not modify it): ${resolvedLink.url}`,
    );
  }

  if (plan?.mustRecommend) {
    parts.push("Answer their question FIRST before any lead capture.");
  }

  if (plan?.shouldSoftClose && plan?.microClose) {
    parts.push(`Soft close opportunity: ${plan.microClose}`);
  }

  // ── Phase 11.7: Dynamic CTA + urgency (web channel only) ─────────────────
  // SMS uses its own micro-close system (getMicroClose / buildResponsePlan).
  if (channel === "web" && intent) {
    const effectivePage = pageHint
      ? String(pageHint).toLowerCase().replace(/[^a-z0-9]/g, "")
      : (pageType ?? null);
    const hasMicroClose = plan?.shouldSoftClose && plan?.microClose;

    if (intent === "booking") {
      if (resolvedLink?.url) {
        // Strong CTA — link is already injected; add persuasive framing around it
        const phrase = STRONG_CTA_PHRASES[effectivePage] ?? STRONG_CTA_PHRASES.default;
        parts.push(`CTA: ${phrase}`);
      } else if (!hasMicroClose) {
        // Soft CTA — no link yet; invite the visitor to take the next step
        parts.push(
          `SOFT CTA: End with one natural offer, e.g. "Want me to check availability for you?" or "I can help you pick the best option." Keep it to one short line.`,
        );
      }
      // Urgency: only after a few exchanges and only once per session
      if (messageCount >= 3 && !conversionState?.urgency_used) {
        const hint = URGENCY_HINTS[messageCount % URGENCY_HINTS.length];
        parts.push(
          `URGENCY HINT: You may naturally weave in this one line if it fits the flow: "${hint}" — keep it general, never fabricate specific availability numbers.`,
        );
      }
    } else if ((intent === "question" || intent === "smalltalk") && !hasMicroClose && !conversionState?.last_cta_type) {
      // Early-stage soft CTA — only when page context is known and we haven't sent one yet
      if (effectivePage && effectivePage !== "homepage" && messageCount >= 2) {
        parts.push(
          `SOFT CTA: If it feels natural at the end, offer to help them take the next step (e.g. check availability, pick the best option). One short line only.`,
        );
      }
    }
  }

  return parts.filter(Boolean).join("\n");
}
