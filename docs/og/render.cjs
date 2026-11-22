// Renders docs/og/og-images.html into public/og-rea.png and public/og-csr.png (1200x630).
const path = require("path");
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}); const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.goto("file://" + path.join(__dirname, "og-images.html"), { waitUntil: "networkidle" }).catch(() => {});
  await p.evaluate(() => document.fonts.ready);
  for (const id of ["rea", "csr"]) await (await p.$("#" + id)).screenshot({ path: path.join(__dirname, "..", "..", "public", `og-${id}.png`) });
  await b.close();
})();
