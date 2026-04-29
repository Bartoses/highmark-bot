// ─────────────────────────────────────────────────────────────────────────────
// PROMPT PARTS — Shared building blocks for the system prompt builders
//
// buildSystemPromptInformational / Generic / CsrRea repeated the same
// SMS rules, contact failsafe, handoff message, business-info dump, FAQ
// section, and LIVE DATA footer in slightly different wording. This module
// owns one canonical version of each so the builders only have to compose,
// not duplicate.
//
// Each helper is a pure function returning the assembled string with no
// trailing newline — callers add their own spacing. Empty inputs collapse
// to "" so callers can interpolate unconditionally.
// ─────────────────────────────────────────────────────────────────────────────

// SMS hard limits — same 3 rules every channel obeys. CsrRea-style "conditions
// follow-up" lines are appended as `extras`.
export function smsRulesBlock(extras = []) {
  const base = [
    "- 480 char max per reply (3 texts). Use what you need — never cut off mid-thought.",
    "- Plain text only. No bullets, dashes, markdown. Max 1–2 emojis.",
    "- Never send two replies in a row without a guest message in between.",
  ];
  return ["━━━ SMS RULES (hard limits) ━━━", ...base, ...extras].join("\n");
}

// One canonical contact-info failsafe. All three builders previously said the
// same thing in slightly different words — this version reads cleanest and
// keeps the model behavior identical (ask only for a name, never the phone,
// soft offer before dropping contact details).
export function contactFailsafeBlock() {
  return [
    "━━━ CONTACT INFO FAILSAFE ━━━",
    "You are texting the guest OVER SMS. You already have their phone number — NEVER ask for it.",
    "If you need follow-up info, only ask for a name. One thing at a time.",
    'Before sharing the business phone/email, ask yourself: "Have I offered to connect them with the team?"',
    'If NO: end with a soft offer ("Want me to have the team reach out?") — do not drop contact details yet.',
    "If YES and they declined, or they explicitly asked: then include it.",
    "Never run your own multi-step data collection. One soft question, then stop.",
  ].join("\n");
}

// Standard handoff section. `triggers` is a list of bullets describing when
// to hand off; `afterNote` is the trailing sentence about what to do after.
export function handoffSection({ triggers, phone, afterNote, contactName }) {
  const callee = contactName ? `Give ${contactName} a call` : "Give us a call";
  const emoji  = contactName ? "🔧" : "🤙";
  const lines = [
    "━━━ HANDOFF — send this message and stop when: ━━━",
    ...triggers.map((t) => `- ${t}`),
    `HANDOFF MESSAGE: "Great question for our team! ${callee} at ${phone} and we'll get you sorted ${emoji}"`,
  ];
  if (afterNote) lines.push(afterNote);
  return lines.join("\n");
}

// Business identity block. Pass only the fields you want shown — falsy values
// are skipped so we don't render "Address: undefined".
export function businessInfoBlock({ name, services, phone, email, address, hours, seasonNote }) {
  const lines = ["━━━ BUSINESS INFO ━━━"];
  if (name)       lines.push(`Name: ${name}`);
  if (services)   lines.push(`Services: ${services}`);
  if (phone)      lines.push(`Phone: ${phone}`);
  if (email)      lines.push(`Email: ${email}`);
  if (address)    lines.push(`Address: ${address}`);
  if (hours)      lines.push(`Hours: ${hours}`);
  if (seasonNote) lines.push(seasonNote);
  return lines.join("\n");
}

// FAQ section — emits the header + entries when non-empty, otherwise "".
export function faqBlock(faq) {
  if (!Array.isArray(faq) || faq.length === 0) return "";
  const body = faq.map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n");
  return `━━━ FAQ ━━━\n${body}`;
}

// LIVE DATA footer — same trailing block every builder ended with.
export function liveDataBlock(knowledgeContext) {
  if (!knowledgeContext) return "";
  return `━━━ LIVE DATA ━━━\n${knowledgeContext}`;
}

// Operating-status rule — opening dates, closing dates, season launches.
// Crawler-extracted facts land in the LIVE DATA block under "WEBSITE KNOWLEDGE:".
// Without this rule the bot tends to fall back to training-data assumptions
// (e.g. "RZR season typically opens late June") instead of quoting the
// website's specific date (e.g. "Kremmling opens Apr 18"). The website is
// always more current than training data.
export function operatingStatusBlock() {
  return [
    "━━━ OPERATING STATUS / SEASON DATES ━━━",
    "If the LIVE DATA block contains explicit opening dates, closing dates, season-launch dates, or operating-status text (under WEBSITE KNOWLEDGE, BUSINESS INFO, or anywhere else) — quote those dates verbatim. The website is always more current than your training data.",
    "NEVER replace a specific date with vague phrasing like \"typically opens late June\", \"usually around X\", or \"once the snow clears\" when the data states a specific date. Don't hedge a real date with assumed conditions.",
    "Only when LIVE DATA has NO opening/closing date for the location asked about → say \"I'll need to check with the team on exact dates\" and hand off, or invite them to share more.",
  ].join("\n");
}

// Completeness rule — when a guest asks "what locations / tours / options
// / services do you offer", the bot should enumerate every distinct named
// item from WEBSITE KNOWLEDGE / BUSINESS INFO / FAQ rather than collapsing
// to the most prominent one or two. Bot writing style still local-guide
// (warm, specific, one clear next step) — this just forces coverage.
export function completenessBlock() {
  return [
    "━━━ COVERAGE — list every distinct option ━━━",
    "When the guest asks \"what locations / tours / options / services / packages do you offer?\" or any open-ended menu question — list ALL distinct named items found in WEBSITE KNOWLEDGE, BUSINESS INFO, FAQ, or DYNAMIC BOOKING LINKS. Do not collapse 4 locations into \"a couple\", do not skip a named offering because it sounds similar to another.",
    "Format: name each item, then one short distinguishing detail (terrain, duration, level, address — whatever makes it different from the others). End with one clear next step: ask which fits, or send the relevant booking link.",
    "Still write like a local guide, not a brochure: confident, conversational, one detail per item — never bullet-dump generic marketing copy.",
    "If the same place appears under different names in your data (e.g. a trail area and a shop address) — explain the relationship in one beat, don't list both as if they were separate offerings.",
  ].join("\n");
}

// Hours formatter — accepts either a string or a {weekdays, weekends} object.
// Returns a single-line summary or a generic fallback.
export function formatHours(hours) {
  if (!hours) return "Contact us for current hours.";
  if (typeof hours === "string") return hours;
  const wd = hours.weekdays ?? "";
  const we = hours.weekends ? `. ${hours.weekends}` : "";
  return (wd + we).trim() || "Contact us for current hours.";
}
