/**
 * GUI-03: screenshot sweep for the design audit. Public pages only, read from a running site (default: hosted).
 * 390x844 and 1440x900, light and dark. Never point this at admin or account pages with real data.
 *
 *   GUI_BASE_URL=https://... GUI_EVENT_ID=<published id> GUI_OUT=docs/testing/evidence/<date>/gui/before \
 *   GUI_RESOLVE="host=ip" node --import tsx tools/gui/gui-shots.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";

const BASE = process.env.GUI_BASE_URL ?? "https://waspada-jakarta.waspada-worker.workers.dev";
const EVENT_ID = process.env.GUI_EVENT_ID ?? "";
const OUT = path.resolve(process.env.GUI_OUT ?? "docs/testing/evidence/gui/before");
const RESOLVE = process.env.GUI_RESOLVE ?? "";
const INTRO_STORAGE_KEY = "waspada-jakarta:intro:v1";

const VIEWPORTS = [
  { label: "390", width: 390, height: 844 },
  { label: "1440", width: 1440, height: 900 },
] as const;
const SCHEMES = ["light", "dark"] as const;

interface Shot { id: string; hash: string; fullPage: boolean; intro?: boolean }
const SHOTS: Shot[] = [
  { id: "peta-intro", hash: "#peta", fullPage: false, intro: true },
  { id: "peta", hash: "#peta", fullPage: false },
  ...(EVENT_ID ? [
    { id: "peta-selected", hash: `#peta?event=${encodeURIComponent(EVENT_ID)}`, fullPage: false },
    { id: "detail", hash: `#detail/api/${encodeURIComponent(EVENT_ID)}`, fullPage: true },
  ] : []),
  { id: "pembaruan", hash: "#pembaruan", fullPage: true },
  { id: "ringkasan-saya", hash: "#ringkasan-saya", fullPage: true },
  { id: "bantuan", hash: "#bantuan", fullPage: true },
  { id: "privasi", hash: "#privasi", fullPage: true },
  { id: "unduh", hash: "#unduh", fullPage: true },
  { id: "masuk", hash: "#masuk", fullPage: true },
  { id: "mulai", hash: "#mulai", fullPage: true },
  { id: "lupa-sandi", hash: "#lupa-sandi", fullPage: true },
];

async function prepare(context: BrowserContext, intro: boolean) {
  if (intro) return;
  await context.addInitScript((key: string) => { try { localStorage.setItem(key, "done"); } catch { /* ignore */ } }, INTRO_STORAGE_KEY);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  if (RESOLVE) {
    const [host, ip] = RESOLVE.split("=");
    args.push(`--host-resolver-rules=MAP ${host} ${ip}`);
  }
  const browser = await chromium.launch({ headless: true, args });
  try {
    for (const viewport of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        for (const shot of SHOTS) {
          const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: scheme, deviceScaleFactor: 1 });
          await prepare(context, shot.intro === true);
          const page = await context.newPage();
          await page.goto(`${BASE}/${shot.hash}`, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
          await page.waitForTimeout(1_500);
          const file = path.join(OUT, `${shot.id}-${viewport.label}-${scheme}.png`);
          await page.screenshot({ path: file, fullPage: shot.fullPage });
          console.log(`ok ${path.basename(file)}`);
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
