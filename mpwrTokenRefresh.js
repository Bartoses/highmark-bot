// mpwrTokenRefresh.js — Auto-refresh MPWR JWT via headless login
//
// Usage:
//   node mpwrTokenRefresh.js          (or: npm run refresh-token)
//
// What it does:
//   1. Launches headless Chrome and logs into mpwr-hq.poladv.com
//   2. Extracts the fresh __xauth JWT cookie
//   3. Updates local .env (MPWR_TOKEN=...)
//   4. If RAILWAY_API_TOKEN is set — pushes the new token to all Railway services
//
// Required env vars: MPWR_EMAIL, MPWR_PASSWORD
// Optional env vars: RAILWAY_API_TOKEN (enables auto-push to Railway)
//
// One-time setup:
//   npm run refresh-token          (runs this script)
//   npx playwright install chromium  (installs headless Chrome, ~90MB, one time)
//
// To automate daily on Mac: add to crontab
//   0 8 * * * cd /Users/sbartosewcz/Desktop/highmark-bot && node mpwrTokenRefresh.js >> ~/.mpwr-refresh.log 2>&1

import 'dotenv/config';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ENV_PATH   = join(__dirname, '.env');
const PROJECT_ID = process.env.RAILWAY_PROJECT_ID || 'f0af0844-40da-47d1-94e7-07c5bfb430f9';
const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

// ── Railway API ───────────────────────────────────────────────────────────────

async function railwayGql(query, variables = {}) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RAILWAY_API_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function pushToRailway(newToken) {
  const data = await railwayGql(`
    query($id: String!) {
      project(id: $id) {
        environments { edges { node { id name } } }
        services      { edges { node { id name } } }
      }
    }
  `, { id: PROJECT_ID });

  const envId    = data.project.environments.edges.find(e => e.node.name === 'production')?.node.id;
  const services = data.project.services.edges.map(e => e.node);

  if (!envId) throw new Error('Railway: production environment not found');

  for (const svc of services) {
    await railwayGql(`
      mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }
    `, {
      input: {
        projectId:     PROJECT_ID,
        environmentId: envId,
        serviceId:     svc.id,
        name:          'MPWR_TOKEN',
        value:         newToken,
      },
    });
    console.log(`[refresh] Railway ✅  ${svc.name}`);
  }
}

// ── Local .env ────────────────────────────────────────────────────────────────

function updateLocalEnv(newToken) {
  try {
    let content = readFileSync(ENV_PATH, 'utf8');
    if (/^MPWR_TOKEN=/m.test(content)) {
      content = content.replace(/^MPWR_TOKEN=.*$/m, `MPWR_TOKEN=${newToken}`);
    } else {
      content += `\nMPWR_TOKEN=${newToken}\n`;
    }
    writeFileSync(ENV_PATH, content);
    console.log('[refresh] Local .env updated');
  } catch (err) {
    console.warn('[refresh] Could not update .env:', err.message);
  }
}

// ── Playwright login ──────────────────────────────────────────────────────────

async function fetchFreshToken() {
  const email    = process.env.MPWR_EMAIL;
  const password = process.env.MPWR_PASSWORD;
  if (!email || !password) throw new Error('MPWR_EMAIL or MPWR_PASSWORD not set');

  console.log('[refresh] Launching headless browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // Navigate to MPWR — lands on splash with a Login button
    await page.goto('https://mpwr-hq.poladv.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Click the Login button — triggers Auth0 redirect to auth.polaris.com
    await page.click('button:has-text("Login"), a:has-text("Login")');
    await page.waitForURL('**/auth.polaris.com/**', { timeout: 15000 });

    // Auth0 Universal Login form
    await page.waitForSelector('input[name="username"]', { timeout: 10000 });
    await page.fill('input[name="username"]', email);
    await page.fill('input[name="password"]', password);

    // Submit and wait for redirect back to MPWR
    await Promise.all([
      page.waitForURL('**/mpwr-hq.poladv.com/**', { timeout: 30000 }),
      page.click('button[type="submit"]'),
    ]);

    // Give the app a moment to set cookies
    await page.waitForTimeout(2000);

    const cookies   = await context.cookies('https://mpwr-hq.poladv.com');
    const authCookie = cookies.find(c => c.name === '__xauth');
    if (!authCookie) throw new Error('__xauth cookie not found — login may have failed');

    // Strip "Bearer " prefix — MPWR_TOKEN stores just the JWT
    const jwt     = authCookie.value.replace(/^Bearer\s+/, '');
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    const exp     = new Date(payload.exp * 1000);

    console.log(`[refresh] Fresh JWT obtained`);
    console.log(`[refresh] Expires: ${exp.toISOString()} (${exp.toLocaleString('en-US', { timeZone: 'America/Denver' })} MT)`);

    return jwt;
  } finally {
    await browser.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const jwt = await fetchFreshToken();

  updateLocalEnv(jwt);

  if (process.env.RAILWAY_API_TOKEN) {
    console.log('[refresh] Pushing to Railway...');
    await pushToRailway(jwt);
    console.log('[refresh] Railway updated — new token active on next cron tick ✅');
  } else {
    console.log('\n[refresh] RAILWAY_API_TOKEN not set — set it in .env to enable auto-push.');
    console.log('[refresh] New token saved to .env. Copy it to Railway manually if needed.\n');
  }

  console.log('[refresh] Done ✅');
}

main().catch(err => {
  console.error('[refresh] Failed:', err.message);
  process.exit(1);
});
