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

  const system = extraInstruction
    ? `${buildSystemPrompt(client, season, knowledgeCtx)}\n\nCURRENT CONTEXT: ${extraInstruction}`
    : buildSystemPrompt(client, season, knowledgeCtx);

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system,
    messages,
  });

  const text = response.content[0].text;

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
// opts.pageHint   — explicit label from data-page attribute ("rzr", "tours", …)
// opts.pageType   — auto-detected type from detectPageType(pageUrl); used when pageHint is null
// opts.resolvedLink — { url } from resolveBookingLink(), or null
// opts.plan         — response plan from buildResponsePlan(), or null
// ─────────────────────────────────────────────────────────────────────────────
export function buildChannelInstruction(channel, { resolvedLink = null, plan = null, pageHint = null, pageType = null } = {}) {
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

  return parts.filter(Boolean).join("\n");
}
