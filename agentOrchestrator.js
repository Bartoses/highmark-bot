// ─────────────────────────────────────────────────────────────────────────────
// agentOrchestrator.js — Unified Agent Orchestration Layer (Phase 5)
// Highmark by Whiteout Solutions
//
// Connects agentCore → prompts → clientConfig → actionEngine → Claude into a
// single orchestrated flow. Designed as a drop-in replacement for the plain
// getClaudeReply() call in the DEFAULT branch of the /sms handler.
//
// Flow (per message):
//   1. detectIntent   (agentCore)      — classify the message
//   2. detectContext  (agentCore)      — extract date, groupSize, urgency, etc.
//   3. selectAgent    (agentCore)      — pick the right agent role
//   4. getAgentPrompt (prompts)        — load agent system instructions
//   5. buildSystemPrompt (agentCore)   — compose layered prompt
//   6. Claude API call                 — request structured JSON response
//   7. parseAgentResponse (agentCore)  — safely parse JSON / plain text
//   8. executeAction  (actionEngine)   — run action if present
//   9. return { reply, parsed, actionResult, agent, intent, context }
//
// Never throws. Always returns a valid reply string.
// ─────────────────────────────────────────────────────────────────────────────

import {
  detectIntent as agentDetectIntent,
  detectContext,
  selectAgent,
  buildSystemPrompt as agentBuildSystemPrompt,
  parseAgentResponse,
} from "./agentCore.js";

import { getAgentPrompt, GLOBAL_PROMPT } from "./prompts.js";
import { getClientKnowledge }             from "./clientConfig.js";
import { executeAction, buildIntegrations } from "./actionEngine.js";
import {
  detectOwner,
  buildOwnerInstruction,
  routeOwnerAgent,
  isOwnerActionAllowed,
  storePendingAction,
  getPendingAction,
  clearPendingAction,
  isAffirmative,
  isNegative,
} from "./ownerMode.js";
import { detectAndHandleOperatorCommand } from "./operatorBriefing.js";

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TOKENS      = 600;   // slightly higher than vanilla call — JSON overhead
const MAX_HISTORY     = 10;    // last N messages included in Claude context
const FALLBACK_REPLY  = "Hey — something went wrong. Give us a call and we'll help right away.";

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT PROFILE SERIALIZER
// Converts a live client config object to a compact string for prompt injection.
// Avoids leaking internal fields (env refs, FH keys, etc.).
// ─────────────────────────────────────────────────────────────────────────────
function serializeClientProfile(client) {
  if (!client) return "";
  try {
    const safe = {
      name:         client.name         ?? "Unknown",
      industry:     client.industry     ?? "outdoor",
      tone:         client.tone         ?? "friendly",
      bookingMode:  client.bookingMode  ?? "informational",
      services:     Array.isArray(client.services) ? client.services.slice(0, 5) : [],
      supportPhone: client.supportPhone ?? null,
      handoffPhone: client.handoffPhone ?? null,
      timezone:     client.timezone     ?? "America/Denver",
    };
    // Include booking links summary (first 3 only to stay compact)
    const links = Array.isArray(client.bookingLinks)
      ? client.bookingLinks.slice(0, 3).map((l) => `${l.title}: ${l.url}`).join(", ")
      : Object.entries(client.bookingUrls ?? {}).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(", ");
    if (links) safe.bookingLinks = links;
    return JSON.stringify(safe, null, 2);
  } catch {
    return client.name ?? "Client";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORY BUILDER
// Formats the last N conversation messages for the Claude messages array.
// ─────────────────────────────────────────────────────────────────────────────
function buildHistory(convo) {
  const messages = (convo?.messages ?? []).slice(-MAX_HISTORY);
  return messages
    .filter((m) => m?.role && m?.content)
    .map(({ role, content }) => ({ role, content: String(content) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full multi-agent orchestration flow for a single message.
 *
 * @param {{
 *   message: string,
 *   convo: object,
 *   client: object,
 *   anthropic: object,
 *   supabase?: object,
 *   crmSupabase?: object,
 *   twilioClient?: object,
 *   knowledgeContext?: string,
 *   extraInstruction?: string,
 * }} opts
 *
 * @returns {Promise<{
 *   reply: string,
 *   parsed: object,
 *   actionResult: object|null,
 *   agent: string,
 *   intent: string,
 *   context: object,
 * }>}
 */
export async function runOrchestrator(params) {
  const {
    message,
    convo,
    client,
    anthropic,
    fromNumber       = null,
    supabase         = null,
    crmSupabase      = null,
    twilioClient     = null,
    knowledgeContext = "",
    extraInstruction = "",
  } = (params && typeof params === "object" && !Array.isArray(params)) ? params : {};
  // ── Safe defaults ──────────────────────────────────────────────────────────
  const msg = (typeof message === "string" ? message : "").trim();

  let intent    = "question";
  let context   = { date: null, groupSize: null, serviceType: null, urgency: "low", returningUser: false };
  let agent     = "support";
  let ownerMode = false;

  try {
    // ── Step 1-3: Intent → context → agent ──────────────────────────────────
    intent  = agentDetectIntent(msg);
    context = detectContext(msg);

    // ── Owner detection (runs before agent selection) ────────────────────────
    ownerMode = detectOwner(fromNumber, client);
    agent = ownerMode ? routeOwnerAgent(intent) : selectAgent(intent);

    console.log(`[ORCHESTRATOR] msg="${msg.slice(0, 40)}…" intent=${intent} agent=${agent} ownerMode=${ownerMode} urgency=${context.urgency}`);

    // ── Owner confirmation gate (runs before Claude to avoid API cost) ────────
    // If the owner has a pending action awaiting YES/NO, intercept before Claude.
    if (ownerMode && fromNumber) {
      const pending = getPendingAction(fromNumber);
      if (pending) {
        if (isAffirmative(msg)) {
          clearPendingAction(fromNumber);
          console.log(`[ORCHESTRATOR] owner confirmed action=${pending.action}`);
          const integrations = buildIntegrations({ supabase, crmSupabase, twilioClient, client });
          const confirmResult = await executeAction({
            action:  pending.action,
            data:    pending.data,
            context,
            client,
            integrations,
          });
          console.log(`[ORCHESTRATOR] confirmed action=${pending.action} success=${confirmResult.success}`);
          const confirmReply = confirmResult.ownerReply
            ?? confirmResult.fallbackMessage
            ?? (confirmResult.success ? "Done." : "Something went wrong. Try again.");
          return { reply: confirmReply, parsed: {}, actionResult: confirmResult, agent, intent, context, ownerMode };
        } else if (isNegative(msg)) {
          clearPendingAction(fromNumber);
          console.log(`[ORCHESTRATOR] owner cancelled action=${pending.action}`);
          return { reply: "Cancelled.", parsed: {}, actionResult: null, agent, intent, context, ownerMode };
        }
        // Ambiguous reply — clear the pending action and let Claude handle it normally
        console.log(`[ORCHESTRATOR] ambiguous reply with pending action=${pending.action}, clearing`);
        clearPendingAction(fromNumber);
      }
    }

    // ── Owner command shortcut (deterministic, no Claude cost) ───────────────
    if (ownerMode && supabase && client) {
      const commandReply = await detectAndHandleOperatorCommand(msg, client, supabase).catch(() => null);
      if (commandReply) {
        console.log(`[ORCHESTRATOR] owner command handled deterministically, reply_len=${commandReply.length}`);
        return { reply: commandReply, parsed: {}, actionResult: null, agent, intent, context, ownerMode };
      }
    }

    // ── Step 4-5: Build layered system prompt ────────────────────────────────
    // Pull per-client KB knowledge (400 chars max) — prefer passed-in context
    let kbContext = knowledgeContext || "";
    if (!kbContext && supabase && client?.id) {
      kbContext = await getClientKnowledge(client.id, supabase).catch(() => "");
    }

    // Append extra instruction to knowledge context so it's visible in the prompt
    const fullKnowledgeContext = [kbContext, extraInstruction].filter(Boolean).join("\n\n");

    const baseSystemPrompt = agentBuildSystemPrompt({
      globalPrompt:     GLOBAL_PROMPT,
      clientProfile:    serializeClientProfile(client),
      agentPrompt:      getAgentPrompt(agent),
      knowledgeContext: fullKnowledgeContext,
    });

    // Owner mode: append operator instruction to override guest-facing behavior
    const systemPrompt = ownerMode
      ? `${baseSystemPrompt}\n\n${buildOwnerInstruction(client)}`
      : baseSystemPrompt;

    // ── Step 6: Claude API call ───────────────────────────────────────────────
    const history = buildHistory(convo);

    // Inject context hint as system addendum so Claude can reference it
    const contextHint = [
      context.date        ? `Detected date: ${context.date}` : null,
      context.groupSize   ? `Group size: ${context.groupSize}` : null,
      context.serviceType ? `Service: ${context.serviceType}` : null,
      context.urgency !== "low" ? `Urgency: ${context.urgency}` : null,
    ].filter(Boolean).join(". ");

    const systemFinal = contextHint
      ? `${systemPrompt}\n\nDETECTED CONTEXT: ${contextHint}`
      : systemPrompt;

    // ── Claude API call with one retry on transient failure ──────────────────
    let response;
    let lastApiError;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        response = await anthropic.messages.create({
          model:      "claude-sonnet-4-6",
          max_tokens: MAX_TOKENS,
          system:     systemFinal,
          messages:   history,
        });
        break; // success — exit retry loop
      } catch (apiErr) {
        lastApiError = apiErr;
        if (attempt === 0) {
          console.warn(`[ORCHESTRATOR] Claude API error (attempt 1/${2}), retrying in 600ms: ${apiErr.message}`);
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }
    if (!response) throw lastApiError; // both attempts failed → caught by outer try/catch

    const rawText = response?.content?.[0]?.text ?? "";

    // ── Step 7: Parse structured response ─────────────────────────────────────
    const parsed = parseAgentResponse(rawText);

    // Log structured output for debugging
    console.log(`[ORCHESTRATOR] parsed agent=${parsed.agent} action=${parsed.action} reply_len=${parsed.reply?.length}`);

    // ── Step 8: Execute action if present ─────────────────────────────────────
    let actionResult = null;
    if (parsed.action && typeof parsed.action === "string") {
      // Owner mode: block customer-only actions
      if (ownerMode && !isOwnerActionAllowed(parsed.action)) {
        console.log(`[ORCHESTRATOR] owner mode blocked action=${parsed.action}`);
        actionResult = { success: false, result: null, fallbackMessage: null };
      } else {
        const integrations = buildIntegrations({ supabase, crmSupabase, twilioClient, client });
        actionResult = await executeAction({
          action:       parsed.action,
          data:         parsed.data ?? {},
          context,
          client,
          integrations,
        });

        console.log(`[ORCHESTRATOR] action=${parsed.action} success=${actionResult.success}`);

        // If action failed and has a fallback message, incorporate it into the reply
        if (!actionResult.success && actionResult.fallbackMessage) {
          // Prefer Claude's reply if it already contains useful info, otherwise use fallback
          if (!parsed.reply || parsed.reply.length < 20) {
            parsed.reply = actionResult.fallbackMessage;
          }
        }

        // Owner BI: store pending action if confirmation is required
        if (ownerMode && actionResult.requiresConfirmation && actionResult.result?.pendingAction && fromNumber) {
          storePendingAction(fromNumber, actionResult.result.pendingAction, actionResult.result.pendingData ?? {});
          console.log(`[ORCHESTRATOR] stored pending action=${actionResult.result.pendingAction} for ${fromNumber}`);
        }
      }
    }

    // ── Step 9: Extract final reply ───────────────────────────────────────────
    let reply = parsed.reply;

    // Owner BI override: if the action returned a real data reply, use it instead of Claude's text
    if (ownerMode) {
      console.log(`[ORCHESTRATOR] owner post-action: action=${parsed.action} actionResult.success=${actionResult?.success} hasOwnerReply=${!!actionResult?.ownerReply} ownerReplyLen=${actionResult?.ownerReply?.length ?? 0}`);
      if (actionResult?.ownerReply) {
        reply = actionResult.ownerReply;
        console.log(`[ORCHESTRATOR] ownerReply override applied, len=${reply.length}`);
      } else if (actionResult && !actionResult.success && actionResult.fallbackMessage) {
        // Action failed — use fallback instead of Claude's confused text
        reply = actionResult.fallbackMessage;
        console.log(`[ORCHESTRATOR] owner action fail — using fallback: ${actionResult.fallbackMessage}`);
      }
    }

    // Safety: if reply is empty or missing, use fallback
    if (!reply || typeof reply !== "string" || reply.trim().length === 0) {
      reply = FALLBACK_REPLY;
    }

    return { reply, parsed, actionResult, agent, intent, context, ownerMode };

  } catch (e) {
    console.error("[ORCHESTRATOR] fatal error:", e.message);
    return {
      reply:        FALLBACK_REPLY,
      parsed:       { agent: null, intent: null, action: null, data: {}, reply: FALLBACK_REPLY },
      actionResult: null,
      agent,
      intent,
      context,
      ownerMode,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPATIBILITY WRAPPER
// Drop-in replacement for getClaudeReply() in index.js.
// Same signature shape — returns reply string only.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wraps runOrchestrator() to match the getClaudeReply() interface.
 * Use this when you want to swap in the orchestrator without refactoring callers.
 *
 * @param {object} convo
 * @param {object} client
 * @param {object} anthropic
 * @param {string} message      — the current user message
 * @param {string} knowledgeContext
 * @param {string} extraInstruction
 * @param {object} [opts]       — { supabase, crmSupabase, twilioClient }
 * @returns {Promise<string>}   — reply text only
 */
export async function getOrchestratorReply(
  convo,
  client,
  anthropic,
  message,
  knowledgeContext = "",
  extraInstruction = "",
  { supabase = null, crmSupabase = null, twilioClient = null, fromNumber = null } = {}
) {
  const { reply } = await runOrchestrator({
    message, convo, client, anthropic,
    fromNumber,
    supabase, crmSupabase, twilioClient,
    knowledgeContext, extraInstruction,
  });
  return reply;
}
