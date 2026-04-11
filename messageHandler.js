// ─────────────────────────────────────────────────────────────────────────────
// messageHandler.js — Channel Abstraction Layer (Phase 7)
// Highmark by Whiteout Solutions
//
// Unified entry point for all message channels: SMS, web widget, test console.
// All channels use the same orchestrator logic. Only formatting instructions differ.
//
// Public API:
//   handleIncomingMessage(params) → { reply, debug }
//   buildChannelInstruction(channel, client) → string
//   isChannelEnabled(channel, client) → boolean
//
// Channel capabilities:
//   sms  — Twilio SMS; short replies, no markdown, no phone ask
//   web  — embed widget; no phone ask, ask email instead, formatting OK
//   test — internal console; behaves like sms, debug output included
//
// All functions are safe (try/catch) and never throw.
// ─────────────────────────────────────────────────────────────────────────────

import { runOrchestrator } from "./agentOrchestrator.js";

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const VALID_CHANNELS = new Set(["sms", "web", "test"]);
const FALLBACK_REPLY = "Hey — something went wrong. Give us a call and we'll help right away.";

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL ENABLE CHECK
// Reads client.enableSms / client.enableWebchat / client.enableTestConsole.
// Defaults to enabled if field is absent (backward compat).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a channel is enabled for this client.
 * All channels default to enabled if not explicitly set to false.
 *
 * @param {"sms"|"web"|"test"} channel
 * @param {object} client
 * @returns {boolean}
 */
export function isChannelEnabled(channel, client) {
  try {
    if (!client) return true; // no client config → allow (fail-open)
    switch (channel) {
      case "sms":  return client.enableSms          !== false;
      case "web":  return client.enableWebchat       !== false;
      case "test": return client.enableTestConsole   !== false;
      default:     return true;
    }
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL INSTRUCTION BUILDER
// Returns a short system-prompt addendum with channel-specific formatting rules.
// Does NOT contain any business logic — only transport-layer guidance.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the channel-specific formatting instruction to append to the system prompt.
 *
 * @param {"sms"|"web"|"test"} channel
 * @param {object} [client]
 * @returns {string}
 */
export function buildChannelInstruction(channel, client) {
  try {
    const name = client?.name ?? "this business";
    switch (channel) {
      case "web":
        return [
          "CHANNEL: Web chat widget — the visitor is on a website, not using SMS.",
          "Do NOT ask for a phone number. If you need contact info, ask for their name and email instead.",
          "You may use light formatting (line breaks for readability).",
          "Keep responses under 480 characters unless detailed info is genuinely needed.",
        ].join(" ");

      case "test":
        return "CHANNEL: Internal test console session. Respond as if SMS — short, direct, no markdown.";

      case "sms":
      default:
        return [
          "CHANNEL: SMS. Keep replies under 320 characters.",
          "No markdown, no bullet lists, no asterisks.",
          "The recipient is on a mobile phone — write for that context.",
        ].join(" ");
    }
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// Unified entry point for all channels. Routes through the orchestrator and
// returns a structured result with debug metadata.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle an incoming message from any channel.
 *
 * @param {{
 *   message:          string,
 *   from:             string,
 *   to:               string,
 *   channel:          "sms"|"web"|"test",
 *   client:           object,
 *   convo:            object,
 *   anthropic:        object,
 *   supabase?:        object,
 *   crmSupabase?:     object,
 *   twilioClient?:    object,
 *   knowledgeContext?: string,
 *   extraInstruction?: string,
 * }} params
 *
 * @returns {Promise<{
 *   reply:    string,
 *   debug: {
 *     intent:    string,
 *     agent:     string,
 *     action:    string|null,
 *     context:   object,
 *     ownerMode: boolean,
 *     channel:   string,
 *     clientId:  string|null,
 *   },
 * }>}
 */
export async function handleIncomingMessage(params) {
  const {
    message,
    from             = null,
    to               = null,
    channel          = "sms",
    client           = null,
    convo            = { messages: [] },
    anthropic        = null,
    supabase         = null,
    crmSupabase      = null,
    twilioClient     = null,
    knowledgeContext  = "",
    extraInstruction  = "",
  } = (params && typeof params === "object" && !Array.isArray(params)) ? params : {};

  const channelName = VALID_CHANNELS.has(channel) ? channel : "sms";
  const msg         = (typeof message === "string" ? message : "").trim();
  const clientId    = client?.id ?? null;

  // Build channel-specific instruction and merge with any extra instruction
  const channelInstr  = buildChannelInstruction(channelName, client);
  const fullExtraInst = [extraInstruction, channelInstr].filter(Boolean).join("\n\n");

  const emptyDebug = {
    intent:    "question",
    agent:     "support",
    action:    null,
    context:   {},
    ownerMode: false,
    channel:   channelName,
    clientId,
  };

  try {
    const result = await runOrchestrator({
      message:          msg,
      convo,
      client,
      anthropic,
      fromNumber:       from,
      supabase,
      crmSupabase,
      twilioClient,
      knowledgeContext,
      extraInstruction: fullExtraInst,
    });

    return {
      reply: result.reply ?? FALLBACK_REPLY,
      debug: {
        intent:    result.intent    ?? "question",
        agent:     result.agent     ?? "support",
        action:    result.parsed?.action ?? null,
        context:   result.context   ?? {},
        ownerMode: result.ownerMode ?? false,
        channel:   channelName,
        clientId,
      },
    };
  } catch (e) {
    console.error(`[MESSAGE_HANDLER] channel=${channelName} fatal:`, e.message);
    return { reply: FALLBACK_REPLY, debug: emptyDebug };
  }
}
