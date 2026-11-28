/**
 * GUI-05: report screenshots from the hosted site, one file per report figure, each in the aspect ratio of the
 * image it replaces in the Google Docs report. Public pages only, no sign-in. Uses whatever is published at the time.
 *   GUI_BASE_URL=https://… GUI_RESOLVE="host=ip" GUI_OUT=dir node --import tsx tools/gui/report-shots.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

const BASE = process.env.GUI_BASE_URL ?? "https://waspada-jakarta.waspada-worker.workers.dev";
const OUT = process.env.GUI_OUT ?? "docs/testing/evidence/2026-11-28/report";
const RESOLVE = process.env.GUI_RESOLVE ?? "";
const INTRO_KEY = "waspada-jakarta:intro:v1";

interface Shot {
  file: string;
  hash: string;
  width: number;
  height: number;
  scale?: number;
  scheme?: "light" | "dark";
  fullPageClip?: { width: number; height: number };
  act?: (page: Page) => Promise<void>;
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1_800);
}

/** GUI_EVENT_ID picks the report for the detail figures; otherwise the published report with the most versions. */
async function firstEventId(page: Page): Promise<string> {
  if (process.env.GUI_EVENT_ID) return process.env.GUI_EVENT_ID;
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/events?limit=100");
    const body = await response.json() as { data?: Array<{ event_id: string; version?: number }> };
    const items = [...(body.data ?? [])].sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    return items[0]?.event_id ?? "";
  });
}

const shots = (eventId: string): Shot[] => [
  { file: "fig-3-09-map-desktop.png", hash: "#peta", width: 1440, height: 900 },
  { file: "fig-3-10-list-phone.png", hash: "#peta", width: 390, height: 844, act: async (page) => {
    await page.locator('button[aria-label^="Daftar "]').first().click();
    await page.waitForTimeout(900);
  } },
  { file: "fig-3-11-detail-desktop.png", hash: `#detail/api/${encodeURIComponent(eventId)}`, width: 1440, height: 900 },
  { file: "fig-5-03-map-desktop.png", hash: "#peta", width: 1280, height: 800 },
  { file: "fig-5-04a-map-390.png", hash: "#peta", width: 390, height: 842 },
  { file: "fig-5-04b-map-320.png", hash: "#peta", width: 320, height: 800 },
  { file: "fig-5-05-detail-full.png", hash: `#detail/api/${encodeURIComponent(eventId)}`, width: 900, height: 900, fullPageClip: { width: 900, height: 1573 }, act: async (page) => {
    for (const summary of await page.locator("details > summary").all()) await summary.click().catch(() => undefined);
    await page.waitForTimeout(500);
  } },
  { file: "fig-5-06-area-saya.png", hash: "#ringkasan-saya", width: 1280, height: 1100, act: async (page) => {
    await page.getByLabel("Tambah tempat").fill("Jakarta");
    await page.getByRole("button", { name: "Tambah", exact: true }).first().click();
    await page.getByRole("button", { name: "Tampilkan ringkasan" }).click();
    await page.waitForTimeout(3_500);
    await page.locator(".briefing-results, [class*=briefing]").first().scrollIntoViewIfNeeded().catch(() => undefined);
    await page.evaluate(() => window.scrollBy(0, 120));
    await page.waitForTimeout(500);
  } },
  { file: "fig-5-09-search-empty.png", hash: "#peta", width: 1280, height: 800, act: async (page) => {
    await page.getByPlaceholder("Cari judul atau lokasi...").fill("Kalideres Utara Raya");
    await page.waitForTimeout(1_000);
  } },
  { file: "fig-5-12-zoom-200.png", hash: "#peta", width: 640, height: 400, scale: 2 },
  { file: "fig-5-16-detail-times.png", hash: `#detail/api/${encodeURIComponent(eventId)}`, width: 1280, height: 800, act: async (page) => {
    const times = page.locator("details", { hasText: "Waktu penerbitan dan pengambilan sumber" }).first();
    await times.locator("summary").click().catch(() => undefined);
    await times.evaluate((element) => element.scrollIntoView({ block: "center" })).catch(() => undefined);
    await page.waitForTimeout(600);
  } },
  { file: "fig-5-17-map-dark.png", hash: "#peta", width: 1280, height: 800, scheme: "dark" },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  if (RESOLVE) {
    const [host, ip] = RESOLVE.split("=");
    args.push(`--host-resolver-rules=MAP ${host} ${ip}`);
  }
  const browser = await chromium.launch({ headless: true, args });
  try {
    const probe = await browser.newPage();
    await probe.goto(`${BASE}/#peta`, { waitUntil: "domcontentloaded" });
    const eventId = await firstEventId(probe);
    await probe.close();
    if (!eventId) throw new Error("no published event found");
    console.log(`event ${eventId}`);
    for (const shot of shots(eventId)) {
      const context = await browser.newContext({
        viewport: { width: shot.width, height: shot.height },
        deviceScaleFactor: shot.scale ?? 1,
        colorScheme: shot.scheme ?? "light",
      });
      await context.addInitScript((key: string) => { try { localStorage.setItem(key, "done"); } catch { /* ignore */ } }, INTRO_KEY);
      const page = await context.newPage();
      await page.goto(`${BASE}/${shot.hash}`, { waitUntil: "domcontentloaded" });
      await settle(page);
      if (shot.act) await shot.act(page);
      const file = path.join(OUT, shot.file);
      if (shot.fullPageClip) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, ...shot.fullPageClip } });
      } else {
        await page.screenshot({ path: file });
      }
      console.log(`ok ${shot.file}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
