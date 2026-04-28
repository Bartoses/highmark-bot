// ─────────────────────────────────────────────────────────────────────────────
// SMS OPT-IN — Progressive consent (Sprint: Prompt 7B)
//
// Web chat consent flow:
//   1. User opens chat → no consent shown
//   2. User asks questions → normal conversation
//   3. User shows SMS intent ("text me", "notify me") → bot asks for consent
//   4. User says "yes" → opted_in=true; bot asks for phone
//   5. User provides phone → lead saved with opted_in=true; CRM tagged 'sms_lead'
//   6. User says "no" → flag cleared; conversation continues normally
//
// Pure functions only — no I/O. Callers (webChat.js / smsOrchestrator.js)
// own state persistence, CRM upserts, and Twilio sends.
// ─────────────────────────────────────────────────────────────────────────────

import { extractPhoneFromMessage } from "./crossChannel.js";

// ── Intent detection ──────────────────────────────────────────────────────────
// Returns true if the message reads like the user wants to be reached via SMS
// (notifications, callbacks, alerts when something becomes available).
//
// Designed to FIRE on clear signals and STAY QUIET on incidental phone mentions
// ("what's your phone number"), since asking for the bot's number is not the
// same as asking to be texted by it.

const SMS_INTENT_PATTERNS = [
  /\btext me\b/i,
  /\btext us\b/i,
  /\bnotify me\b/i,
  /\bnotify us\b/i,
  /\blet me know\b/i,
  /\bsend (me )?(an? )?(update|alert|notification|reminder)\b/i,
  /\b(send|shoot) (me )?(a )?text\b/i,
  /\bcall me\b/i,
  /\breach me\b/i,
  /\b(when (it|something) (opens|becomes available)|when (spots|space|availability) opens? up)\b/i,
];

export function isSmsIntent(message) {
  if (!message || typeof message !== "string") return false;
  const text = message.trim();
  if (!text) return false;
  for (const re of SMS_INTENT_PATTERNS) {
    if (re.test(text)) return true;
  }
  // Generic "updates" / "phone" mentions — only trigger when paired with a
  // first-person hint to avoid catching "do you have updates on snow conditions"
  if (/\b(get|sign up for|stay) (in the loop|updated|posted)\b/i.test(text)) return true;
  if (/\bping me\b/i.test(text)) return true;
  return false;
}

// ── Reply detection ───────────────────────────────────────────────────────────
// Used after a consent prompt has been sent. Classifies the visitor's reply.
// Returns "yes" | "no" | "unknown".

const YES_PATTERNS = [
  /^(y|ya|ye|yea|yeah|yep|yup|yes|sure|ok|okay|k|kk|sounds good|that works|please do|absolutely|of course|go ahead|do it|yeah please|yes please)\b/i,
  /\b(sign me up|count me in|i'?m in|i am in)\b/i,
];

const NO_PATTERNS = [
  /^(n|no|nope|nah|negative|pass|not now|maybe later|no thanks|no thank you|i'?m good|i am good|i'?ll pass)\b/i,
  /\b(don'?t text|do not text|skip|leave it)\b/i,
];

export function detectConsentReply(message) {
  if (!message || typeof message !== "string") return "unknown";
  const text = message.trim();
  if (!text) return "unknown";
  for (const re of NO_PATTERNS)  { if (re.test(text)) return "no"; }
  for (const re of YES_PATTERNS) { if (re.test(text)) return "yes"; }
  return "unknown";
}

// ── Phone detection ───────────────────────────────────────────────────────────
// Reuses the cross-channel phone extractor (E.164 normalization built in).

export function detectPhoneInMessage(message) {
  return extractPhoneFromMessage(message);
}

// ── Name extraction ───────────────────────────────────────────────────────────
// Pulls a plausible first/last name out of a message that may also contain a
// phone number. Strips the phone digits first so we don't read "720" as a name.
//
// Returns the captured name as a string ("John" or "John Smith"), or null when
// nothing name-like is present. Conservative on purpose — false positives go
// into the leads table and look terrible to the operator.

const NAME_INTRO_RE =
  /(?:^|[\s,.;:!?-])(?:i'?m|i am|my name(?:'s| is)?|this is|it'?s|call me|name'?s|name is)\s+([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)?)/i;

const STANDALONE_NAME_RE =
  /^\s*([A-Z][a-z'-]{1,}(?:\s+[A-Z][a-z'-]{1,})?)\s*(?:[,.\-—]|$)/;

const NAME_STOPWORDS = new Set([
  "yes", "yeah", "yep", "no", "nope", "ok", "okay", "sure", "thanks",
  "thank", "hi", "hey", "hello", "please", "sounds", "good", "great",
  "fine", "cool", "awesome", "perfect", "absolutely",
]);

// Tokens that look like a name word but are really prepositions/conjunctions.
// We drop these from the tail of a captured name so "Sara at" → "Sara".
const NAME_TAIL_NOISE = new Set([
  "at", "on", "by", "in", "from", "via", "to", "and", "or", "but",
  "with", "for", "the", "a", "an", "of", "is", "im",
]);

export function extractNameFromMessage(message) {
  if (!message || typeof message !== "string") return null;
  // Strip out anything that looks like a phone number first so digit runs
  // don't confuse the name patterns.
  const stripped = message
    .replace(/\+?\d[\d\s().-]{6,}\d/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;

  const intro = stripped.match(NAME_INTRO_RE);
  if (intro?.[1]) return cleanName(intro[1]);

  const standalone = stripped.match(STANDALONE_NAME_RE);
  if (standalone?.[1]) {
    const candidate = cleanName(standalone[1]);
    if (candidate && !NAME_STOPWORDS.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}

function cleanName(raw) {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  // Drop trailing prepositions/conjunctions that look like name tokens
  // (e.g. "Sara at" → "Sara") before title-casing.
  const tokens = trimmed.split(" ").filter(Boolean);
  while (tokens.length > 1 && NAME_TAIL_NOISE.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  if (!tokens.length) return null;
  return tokens
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// ── Reply builders ────────────────────────────────────────────────────────────
// All copy is benefit-led, compliance-secondary. Brand name interpolated from
// client.name so the message reads as the business, not Highmark.

function brandLabel(client) {
  return client?.name ?? client?.botName ?? "us";
}

export function buildConsentPrompt(client) {
  const brand = brandLabel(client);
  return [
    "Got you — I can text you when spots open or if anything opens up 👍",
    "",
    `Just to confirm, are you okay getting a quick text from ${brand} about availability and booking options?`,
    "",
    "(We keep it light — no spam. Msg freq varies. Msg & data rates may apply. Reply STOP anytime to opt out.)",
  ].join("\n");
}

export function buildConsentConfirmReply() {
  return "Perfect 🙌 What's your name and the best number to text you?";
}

export function buildPhoneCapturedReply() {
  return "Awesome — you're on the list 🏔 I'll text you as soon as availability opens up.";
}

export function buildDeclineReply() {
  return "All good 👍 I'll keep everything here in chat.";
}

// ── First-touch SMS opener ────────────────────────────────────────────────────
// Used on the SMS channel when a brand-new visitor texts in for the first time.
// Short, branded, compliance present but secondary.

export function buildSmsFirstTouchOpener(client) {
  const brand = brandLabel(client);
  return [
    `${brand} here 👋 I can help with availability, bookings, and questions.`,
    "",
    "Reply STOP to opt out anytime.",
  ].join("\n");
}
