// ─────────────────────────────────────────────────────────────────────────────
// Highmark Embed Widget v1.0
// Usage: <script src="https://your-railway-url/embed.js" data-client="client_id"></script>
//
// Self-initializing. No dependencies. Async. Does not block page rendering.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  "use strict";

  // ── Config ──────────────────────────────────────────────────────────────────
  const script     = document.currentScript || document.querySelector("script[data-client]");
  const CLIENT_ID  = script?.getAttribute("data-client");
  const BASE_URL   = script?.getAttribute("data-url") || (script?.src ? new URL(script.src).origin : "");
  const POSITION   = script?.getAttribute("data-position") || "right"; // "right" | "left"

  if (!CLIENT_ID || !BASE_URL) {
    console.warn("[Highmark] Missing data-client or could not determine base URL.");
    return;
  }

  // ── Session identity (persisted across page loads) ──────────────────────────
  const STORAGE_KEY   = `hm_session_${CLIENT_ID}`;
  const HISTORY_KEY   = `hm_history_${CLIENT_ID}`;
  const OPEN_KEY      = `hm_open_${CLIENT_ID}`;

  function getSessionId() {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  }

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
    catch { return []; }
  }

  function saveHistory(msgs) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(msgs.slice(-60))); }
    catch {}
  }

  // ── State ───────────────────────────────────────────────────────────────────
  let sessionId = getSessionId();
  let messages  = loadHistory();
  let isOpen    = localStorage.getItem(OPEN_KEY) === "1";
  let isTyping  = false;
  let config    = { name: "Chat", botName: "Summit", primaryColor: "#2563eb", position: POSITION };

  // ── CSS ─────────────────────────────────────────────────────────────────────
  const CSS = `
    #hm-widget * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #hm-widget { position: fixed; ${POSITION === "left" ? "left:20px" : "right:20px"}; bottom: 20px; z-index: 2147483647; display: flex; flex-direction: column; align-items: ${POSITION === "left" ? "flex-start" : "flex-end"}; }
    #hm-btn { width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer; background: var(--hm-primary); color: #fff; font-size: 24px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 16px rgba(0,0,0,.22); transition: transform .18s, box-shadow .18s; }
    #hm-btn:hover { transform: scale(1.07); box-shadow: 0 6px 20px rgba(0,0,0,.28); }
    #hm-panel { width: 360px; max-width: calc(100vw - 24px); background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,.18); display: flex; flex-direction: column; overflow: hidden; margin-bottom: 12px; transition: opacity .2s, transform .2s; }
    #hm-panel.hm-hidden { opacity: 0; pointer-events: none; transform: translateY(12px); }
    #hm-header { background: var(--hm-primary); color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 10px; }
    #hm-header .hm-avatar { width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,.22); display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; }
    #hm-header .hm-title { flex: 1; }
    #hm-header .hm-title strong { display: block; font-size: 14px; font-weight: 600; }
    #hm-header .hm-title span { font-size: 11px; opacity: .8; }
    #hm-header .hm-close { background: none; border: none; color: #fff; cursor: pointer; font-size: 18px; padding: 2px 4px; opacity: .8; line-height: 1; }
    #hm-messages { flex: 1; overflow-y: auto; padding: 14px 12px; display: flex; flex-direction: column; gap: 8px; max-height: 340px; min-height: 200px; background: #f8f9fb; }
    .hm-msg { max-width: 82%; padding: 10px 13px; border-radius: 14px; font-size: 13px; line-height: 1.5; word-break: break-word; }
    .hm-msg.hm-bot { background: #fff; border: 1px solid #e5e7eb; color: #111; border-bottom-left-radius: 4px; align-self: flex-start; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
    .hm-msg.hm-user { background: var(--hm-primary); color: #fff; border-bottom-right-radius: 4px; align-self: flex-end; }
    .hm-typing { display: flex; gap: 4px; align-items: center; padding: 10px 13px; }
    .hm-dot { width: 7px; height: 7px; border-radius: 50%; background: #adb5bd; animation: hm-bounce .9s infinite ease-in-out; }
    .hm-dot:nth-child(2) { animation-delay: .15s; }
    .hm-dot:nth-child(3) { animation-delay: .3s; }
    @keyframes hm-bounce { 0%,60%,100% { transform: translateY(0); } 30% { transform: translateY(-6px); } }
    #hm-footer { padding: 10px 12px; background: #fff; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; }
    #hm-input { flex: 1; border: 1px solid #d1d5db; border-radius: 20px; padding: 8px 14px; font-size: 13px; outline: none; color: #111; resize: none; max-height: 80px; line-height: 1.4; }
    #hm-input:focus { border-color: var(--hm-primary); }
    #hm-send { background: var(--hm-primary); border: none; border-radius: 50%; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: opacity .15s; }
    #hm-send:disabled { opacity: .5; cursor: default; }
    #hm-send svg { width: 16px; height: 16px; fill: #fff; }
    #hm-branding { text-align: center; padding: 5px 0 8px; font-size: 10px; color: #adb5bd; }
    #hm-branding a { color: inherit; text-decoration: none; }
    #hm-branding a:hover { text-decoration: underline; }
    @media (max-width: 400px) { #hm-panel { width: calc(100vw - 24px); } }
  `;

  // ── DOM ─────────────────────────────────────────────────────────────────────
  function inject() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = "hm-widget";
    root.innerHTML = `
      <div id="hm-panel" class="${isOpen ? "" : "hm-hidden"}">
        <div id="hm-header">
          <div class="hm-avatar">🏔</div>
          <div class="hm-title">
            <strong id="hm-bot-name">${config.botName}</strong>
            <span>Usually replies instantly</span>
          </div>
          <button class="hm-close" id="hm-close-btn" aria-label="Close">✕</button>
        </div>
        <div id="hm-messages"></div>
        <div id="hm-footer">
          <textarea id="hm-input" placeholder="Type a message…" rows="1" autocomplete="off"></textarea>
          <button id="hm-send" aria-label="Send">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
        <div id="hm-branding"><a href="https://usehighmark.com" target="_blank" rel="noopener">Powered by Highmark</a></div>
      </div>
      <button id="hm-btn" aria-label="Chat with us">💬</button>
    `;
    document.body.appendChild(root);

    // Apply primary color CSS variable
    root.style.setProperty("--hm-primary", config.primaryColor);

    renderMessages();
    bindEvents();
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function renderMessages() {
    const container = document.getElementById("hm-messages");
    if (!container) return;
    container.innerHTML = "";
    for (const msg of messages) {
      appendMessageEl(msg.role, msg.content);
    }
    if (isTyping) showTypingIndicator();
    scrollBottom();
  }

  function linkify(text) {
    const esc = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    return esc.replace(/https?:\/\/[^\s<>"]+/g, url =>
      `<a href="${url}" target="_blank" rel="noopener" style="color:inherit;word-break:break-all;text-decoration:underline;">${url}</a>`);
  }

  function appendMessageEl(role, text) {
    const container = document.getElementById("hm-messages");
    if (!container) return;
    const div = document.createElement("div");
    div.className = `hm-msg ${role === "assistant" ? "hm-bot" : "hm-user"}`;
    div.innerHTML = linkify(text);
    container.appendChild(div);
  }

  function showTypingIndicator() {
    const container = document.getElementById("hm-messages");
    if (!container) return;
    const existing = container.querySelector(".hm-typing");
    if (existing) return;
    const div = document.createElement("div");
    div.className = "hm-msg hm-bot hm-typing";
    div.innerHTML = '<div class="hm-dot"></div><div class="hm-dot"></div><div class="hm-dot"></div>';
    container.appendChild(div);
    scrollBottom();
  }

  function removeTypingIndicator() {
    const container = document.getElementById("hm-messages");
    if (!container) return;
    const el = container.querySelector(".hm-typing");
    if (el) el.remove();
  }

  function scrollBottom() {
    const container = document.getElementById("hm-messages");
    if (container) container.scrollTop = container.scrollHeight;
  }

  // ── Events ──────────────────────────────────────────────────────────────────
  function bindEvents() {
    document.getElementById("hm-btn").addEventListener("click", togglePanel);
    document.getElementById("hm-close-btn").addEventListener("click", closePanel);
    document.getElementById("hm-send").addEventListener("click", sendMessage);

    const input = document.getElementById("hm-input");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 80)}px`;
    });
  }

  function openPanel() {
    isOpen = true;
    localStorage.setItem(OPEN_KEY, "1");
    const panel = document.getElementById("hm-panel");
    if (panel) panel.classList.remove("hm-hidden");
    document.getElementById("hm-input")?.focus();
    // Send greeting on first open if no messages yet
    if (messages.length === 0) sendGreeting();
  }

  function closePanel() {
    isOpen = false;
    localStorage.removeItem(OPEN_KEY);
    const panel = document.getElementById("hm-panel");
    if (panel) panel.classList.add("hm-hidden");
  }

  function togglePanel() { isOpen ? closePanel() : openPanel(); }

  // ── API ─────────────────────────────────────────────────────────────────────
  async function fetchConfig() {
    try {
      const r = await fetch(`${BASE_URL}/web/config/${encodeURIComponent(CLIENT_ID)}`);
      if (!r.ok) return;
      const data = await r.json();
      config = { ...config, ...data };
      // Apply config to DOM if already injected
      const botNameEl = document.getElementById("hm-bot-name");
      if (botNameEl) botNameEl.textContent = config.botName;
      const root = document.getElementById("hm-widget");
      if (root) root.style.setProperty("--hm-primary", config.primaryColor);
    } catch { /* non-fatal — use defaults */ }
  }

  async function sendGreeting() {
    await sendToApi("hi");
  }

  async function sendMessage() {
    const input = document.getElementById("hm-input");
    const text  = input?.value?.trim();
    if (!text || isTyping) return;

    input.value = "";
    input.style.height = "auto";

    // Optimistically render user message
    messages.push({ role: "user", content: text });
    saveHistory(messages);
    appendMessageEl("user", text);
    scrollBottom();

    await sendToApi(text);
  }

  async function sendToApi(text) {
    const sendBtn = document.getElementById("hm-send");
    if (sendBtn) sendBtn.disabled = true;
    isTyping = true;
    showTypingIndicator();

    try {
      const r = await fetch(`${BASE_URL}/web/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ clientId: CLIENT_ID, sessionId, message: text }),
      });

      removeTypingIndicator();
      isTyping = false;
      if (sendBtn) sendBtn.disabled = false;

      if (!r.ok) {
        appendMessageEl("assistant", "Sorry, something went wrong. Please try again!");
        return;
      }

      const data = await r.json();
      const reply = data.reply || "I'm here to help — what can I do for you?";

      messages.push({ role: "assistant", content: reply });
      saveHistory(messages);
      appendMessageEl("assistant", reply);
      scrollBottom();

    } catch {
      removeTypingIndicator();
      isTyping = false;
      if (sendBtn) sendBtn.disabled = false;
      appendMessageEl("assistant", "Oops! Connection issue. Please check your network and try again.");
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  function init() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => { fetchConfig().then(inject); });
    } else {
      fetchConfig().then(inject);
    }

    // Auto-open if was open before page reload
    if (isOpen) {
      const waitForDom = setInterval(() => {
        if (document.getElementById("hm-panel")) {
          clearInterval(waitForDom);
          openPanel();
        }
      }, 50);
    }
  }

  init();
})();
