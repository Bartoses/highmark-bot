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

// Hours formatter — accepts either a string or a {weekdays, weekends} object.
// Returns a single-line summary or a generic fallback.
export function formatHours(hours) {
  if (!hours) return "Contact us for current hours.";
  if (typeof hours === "string") return hours;
  const wd = hours.weekdays ?? "";
  const we = hours.weekends ? `. ${hours.weekends}` : "";
  return (wd + we).trim() || "Contact us for current hours.";
}
