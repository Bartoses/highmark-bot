// Renders docs/og/og-images.html -> public/og-rea.png, og-csr.png (1200x630) and docs/og/route-placeholders.html -> public/route-*-placeholder.png.
const path = require("path");
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}); const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.goto("file://" + path.join(__dirname, "og-images.html"), { waitUntil: "networkidle" }).catch(() => {});
  await p.evaluate(() => document.fonts.ready);
  for (const id of ["rea", "csr"]) await (await p.$("#" + id)).screenshot({ path: path.join(__dirname, "..", "..", "public", `og-${id}.png`) });
  await p.setViewportSize({ width: 1120, height: 600 });
  await p.goto("file://" + path.join(__dirname, "route-placeholders.html")).catch(() => {});
  for (const id of ["rea", "backcountry"]) await (await p.$("#" + id)).screenshot({ path: path.join(__dirname, "..", "..", "public", `route-${id}-placeholder.png`), omitBackground: true });
  // icon set -> public/icons/<name>-<dark|light>.png
  const fs = require("fs"); fs.mkdirSync(path.join(__dirname, "..", "..", "public", "icons"), { recursive: true });
  await p.goto("file://" + path.join(__dirname, "icons.html")); await p.waitForFunction(() => window.ICON_IDS);
  for (const id of await p.evaluate(() => window.ICON_IDS)) await (await p.$("#" + id)).screenshot({ path: path.join(__dirname, "..", "..", "public", "icons", `${id}.png`), omitBackground: true });
  await b.close();
})();
