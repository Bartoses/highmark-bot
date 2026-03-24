/**
 * Summit SMS Simulator
 * Local testing CLI — no Twilio costs, no real SMS sent.
 *
 * Usage:
 *   1. In one terminal:  TEST_MODE=true npm run dev
 *   2. In another:       node test.js
 *
 * Commands during the session:
 *   /reset   — clear conversation history (start fresh)
 *   /quit    — exit
 */

import readline from "readline";

const SERVER      = process.env.TEST_SERVER || "http://localhost:3000";
const FROM_NUMBER = "+15550001234"; // fake guest number
const TO_NUMBER   = "+15559999999"; // fake Twilio number

const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout,
});

function prompt() {
  rl.question("You: ", async (input) => {
    const msg = input.trim();
    if (!msg) return prompt();

    // ── /quit ──────────────────────────────────────────────
    if (msg === "/quit") {
      console.log("Bye.");
      rl.close();
      process.exit(0);
    }

    // ── /reset ─────────────────────────────────────────────
    if (msg === "/reset") {
      try {
        await fetch(`${SERVER}/reset`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ from: FROM_NUMBER }),
        });
        console.log("\n[Conversation reset — Summit will treat you as a new guest]\n");
      } catch (err) {
        console.error("[Reset failed]", err.message);
      }
      return prompt();
    }

    // ── Normal message ─────────────────────────────────────
    try {
      const res = await fetch(`${SERVER}/sms`, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    new URLSearchParams({
          Body: msg,
          From: FROM_NUMBER,
          To:   TO_NUMBER,
        }),
      });

      const data = await res.json();
      const reply = data.reply ?? "(no reply)";
      const chars = reply.length;
      const texts = Math.ceil(chars / 160);

      console.log(`\nSummit (${chars} chars / ~${texts} text${texts !== 1 ? "s" : ""}): ${reply}\n`);
    } catch (err) {
      console.error("[Error]", err.message);
      console.error("Is the server running? Start it with: TEST_MODE=true npm run dev\n");
    }

    prompt();
  });
}

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(" Summit SMS Simulator");
console.log(` Server: ${SERVER}`);
console.log(" Commands: /reset  /quit");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

prompt();
