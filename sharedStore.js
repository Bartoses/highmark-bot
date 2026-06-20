// sharedStore.js — P0-5: shared rate-limit counters + caches across web instances
//
// The per-phone rate limiter and the daily-summary cache used to live in process
// memory, so with >1 web instance the rate limit became N× looser and caches never
// shared. This module provides a tiny KV with two backends:
//
//   • Upstash Redis (REST) — used when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//     are set. Atomic INCR+EXPIRE gives a correct cross-instance fixed-window limiter.
//   • In-memory Map (TTL) — the fallback. Correct for a single instance; identical to
//     the previous behavior. Used whenever Upstash isn't configured.
//
// @upstash/redis is lazy-imported ONLY when the env vars are present, so the package
// is effectively optional: with no env vars set, nothing is imported and the app runs
// exactly as before. Deploying this before provisioning Upstash is therefore zero-risk.

let redisClient = null;
let resolvedMode = "memory";
let initPromise = null;

// Lazily construct the Upstash client. Returns null (→ memory mode) when unconfigured
// or if the import/init fails for any reason (fail-safe to in-memory).
async function getRedis() {
  if (redisClient) return redisClient;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const { Redis } = await import("@upstash/redis");
        redisClient = new Redis({
          url:   process.env.UPSTASH_REDIS_REST_URL,
          token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        resolvedMode = "redis";
        console.log("[STORE] Shared store backend: Upstash Redis");
      } catch (err) {
        console.error("[STORE] Upstash init failed — using in-memory fallback:", err.message);
        redisClient = null;
        resolvedMode = "memory";
      }
    })();
  }
  await initPromise;
  return redisClient;
}

// ── In-memory fallback (TTL map) ──────────────────────────────────────────────
const mem = new Map(); // key -> { value, expiresAt|null }

function memGet(key) {
  const e = mem.get(key);
  if (!e) return null;
  if (e.expiresAt && Date.now() > e.expiresAt) { mem.delete(key); return null; }
  return e.value;
}
function memSet(key, value, ttlSec) {
  mem.set(key, { value, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : null });
}

// Periodic prune so the fallback map can't grow unbounded. unref() so it never
// keeps a short-lived process (e.g. the cron worker) alive.
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, e] of mem) if (e.expiresAt && now > e.expiresAt) mem.delete(k);
}, 5 * 60 * 1000);
pruneTimer.unref?.();

// ── Public API ────────────────────────────────────────────────────────────────

// Increment a counter and return its new value. On first hit, sets a TTL so the
// counter expires after the window (fixed-window rate limiting). Cross-instance
// atomic under Redis; window-scoped under the memory fallback.
export async function incrWithTtl(key, ttlSec) {
  const r = await getRedis();
  if (r) {
    const count = await r.incr(key);
    if (count === 1) await r.expire(key, ttlSec);
    return count;
  }
  const now = Date.now();
  const e   = mem.get(key);
  if (!e || (e.expiresAt && now > e.expiresAt)) {
    mem.set(key, { value: 1, expiresAt: now + ttlSec * 1000 });
    return 1;
  }
  e.value += 1;
  return e.value;
}

// Cache get — returns the stored value (object-safe) or null. Never throws.
export async function cacheGet(key) {
  const r = await getRedis();
  if (r) { try { return await r.get(key); } catch { return null; } }
  return memGet(key);
}

// Cache set with optional TTL (seconds). Never throws.
export async function cacheSet(key, value, ttlSec) {
  const r = await getRedis();
  if (r) {
    try { await r.set(key, value, ttlSec ? { ex: ttlSec } : undefined); } catch { /* non-fatal */ }
    return;
  }
  memSet(key, value, ttlSec);
}

// "redis" once Upstash is initialized, else "memory". For health/observability.
export function storeMode() { return resolvedMode; }

// Live backend health with a real round-trip. The Upstash REST client constructor
// does NOT validate credentials (REST is per-request), so storeMode() alone can
// report "redis" while the connection is actually broken. This performs an actual
// GET so the answer is honest: "memory" | "redis" | "redis-unreachable".
export async function storeHealth() {
  const r = await getRedis();
  if (!r) return "memory";
  try {
    await r.get("__healthcheck__");
    return "redis";
  } catch {
    return "redis-unreachable";
  }
}

// Test-only: reset the in-memory fallback between cases.
export function __resetMemoryStore() { mem.clear(); }
