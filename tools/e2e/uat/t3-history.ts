/*
 * UAT T3 (US-03, inspect origins and history). Automated walkthrough (browser subagent). Not user acceptance: see docs/testing/UAT.md.
 *
 * Demo dataset only, as an anonymous visitor. Start `npm run dev` first (Vite on 127.0.0.1:5173, Worker on :8787).
 * Run one file at a time from the repository root: npx tsx tools/e2e/uat/t3-history.ts
 * Output: .codex-build/uat/<run-id>/t3-history.json and screenshots. <run-id> is UAT_RUN_ID, or a timestamp if unset.
 *
 * Exit code 1 when a fatal step fails or the dataset is not demo. Non-fatal steps do not change the exit code.
 * Labels were read from apps/web/src (MapEventList.tsx, MapPopup.tsx, EventDetail.tsx, MapHome.tsx).
 * Label not confirmed: an "origins" heading. The public view has none; the claims section "Bukti" (kicker "Klaim per sumber")
 * is treated as the origins view. Per-claim source attribution is also not confirmed, so it is recorded as skipped.
 * Not scripted here: 320 px and 200% text (UAT.md section 7).
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYNTHETIC_DEMO_PASSWORD } from "../../accounts/demo-accounts.js";

const SCRIPT_NAME = "t3-history";
const TASK_ID = "T3";
const REQUIREMENT = "US-03";
const BASE = "http://127.0.0.1:5173";
const TIME_LIMIT_MS = 120_000; // Proposed: the SDP sets no time limit for this task.
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

interface StepRecord {
  viewport: string;
  step: number;
  name: string;
  ok: boolean;
  fatal: boolean;
  ms: number;
  error?: string;
}

interface SkipRecord {
  viewport: string;
  name: string;
  reason: string;
}

function redact(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const firstLine = raw.split("\n")[0] ?? "";
  return firstLine.split(SYNTHETIC_DEMO_PASSWORD).join("[redacted]").slice(0, 300);
}

class UatRun {
  readonly steps: StepRecord[] = [];
  readonly skipped: SkipRecord[] = [];
  readonly notes: string[] = [];
  readonly taskSeconds: Record<string, number> = {};
  private counter = 0;

  constructor(readonly outDir: string) {}

  /** Runs one step. A failure is recorded and the script continues. `fatal = false` marks a non-fatal step. */
  async step(page: Page | null, viewport: string, name: string, action: () => Promise<void>, fatal = true): Promise<boolean> {
    const started = performance.now();
    let error: string | undefined;
    try {
      await action();
    } catch (cause) {
      error = redact(cause);
    }
    this.counter += 1;
    const ms = Math.round(performance.now() - started);
    const ok = error === undefined;
    this.steps.push({ viewport, step: this.counter, name, ok, fatal, ms, ...(error === undefined ? {} : { error }) });
    if (page !== null) {
      const file = `${viewport}-${String(this.counter).padStart(2, "0")}-${ok ? "ok" : "fail"}.png`;
      await page.screenshot({ path: join(this.outDir, file), timeout: 10_000 }).catch(() => undefined);
    }
    return ok;
  }

  recordFailure(viewport: string, name: string, cause: unknown): void {
    this.counter += 1;
    this.steps.push({ viewport, step: this.counter, name, ok: false, fatal: true, ms: 0, error: redact(cause) });
  }

  skip(viewport: string, name: string, reason: string): void {
    this.skipped.push({ viewport, name, reason });
  }

  note(text: string): void {
    this.notes.push(text);
  }
}

function resolveRun(): { runId: string; outDir: string } {
  const fromEnv = process.env.UAT_RUN_ID?.trim();
  const runId = fromEnv !== undefined && fromEnv !== "" ? fromEnv : new Date().toISOString().replace(/[:.]/g, "-");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(runId)) {
    throw new Error("UAT_RUN_ID must start with a letter or digit and use only letters, digits, dot, underscore or hyphen");
  }
  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".codex-build", "uat", runId);
  return { runId, outDir };
}

/** Refuses to run unless the server reports the demo dataset. Live mode would change what these steps mean. */
async function assertDemoDataset(run: UatRun): Promise<boolean> {
  return run.step(null, "setup", "dataset is demo (the script refuses to run on live data)", async () => {
    const response = await fetch(`${BASE}/api/v1/context`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`context returned HTTP ${response.status}`);
    const body = (await response.json()) as { dataset_mode?: unknown };
    if (body.dataset_mode !== "demo") throw new Error("dataset_mode is not demo");
  });
}

async function dismissIntro(page: Page): Promise<void> {
  const skip = page.getByRole("button", { name: "Lewati", exact: true });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click().catch(() => undefined);
    await page.waitForTimeout(500);
  }
}

/** First event_id from the public list, used only to build the direct #detail/api/<id> route. */
async function firstEventId(page: Page): Promise<string | null> {
  const response = await page.request.get(`${BASE}/api/v1/events`);
  if (!response.ok()) return null;
  const body: unknown = await response.json();
  const list: unknown = Array.isArray(body) ? body : (body as { data?: unknown }).data;
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    if (typeof item === "object" && item !== null && typeof (item as { event_id?: unknown }).event_id === "string") {
      return (item as { event_id: string }).event_id;
    }
  }
  return null;
}

async function runViewport(browser: Browser, viewport: Viewport, run: UatRun): Promise<void> {
  const started = performance.now();
  const vp = viewport.name;
  const context: BrowserContext = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "id-ID",
  });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("waspada-theme", "light");
    } catch {
      /* storage blocked: the default theme applies */
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  try {
    await run.step(page, vp, "open #peta and close the first-visit introduction if shown", async () => {
      await page.goto(`${BASE}/#peta`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await dismissIntro(page);
    });

    const cards = page.locator('ul[aria-label="Laporan terbit"] button.map-card');
    if (vp === "phone") {
      await run.step(page, vp, "phone: open the list with the 'Daftar laporan' toggle when it is shown", async () => {
        const toggle = page.getByRole("button", { name: /^Daftar laporan/u });
        if (await toggle.isVisible()) {
          await toggle.click();
        }
      });
    }

    // Opening the detail: card, then the popup's "Lihat detail" button, which opens the "Detail laporan" sheet (MapPopup.tsx, MapHome.tsx).
    await run.step(page, vp, "select the first report card and open 'Lihat detail'", async () => {
      await cards.first().waitFor({ state: "visible" });
      await cards.first().click();
      await page.getByRole("button", { name: "Lihat detail", exact: true }).first().click();
      await page.getByText("Waktu dan cakupan", { exact: true }).waitFor({ state: "visible" });
    });

    // Label confirmed: kicker "Riwayat fixture sintetis" and heading "Perubahan" (EventDetail.tsx, ApiHistory).
    await run.step(page, vp, "history section 'Perubahan' is labelled as synthetic fixture history", async () => {
      await page.getByRole("heading", { name: "Perubahan", exact: true }).waitFor({ state: "visible" });
      await page.getByText("Riwayat fixture sintetis", { exact: true }).waitFor({ state: "visible" });
    });

    await run.step(page, vp, "history shows entries, or a clear 'not found' or 'unavailable' message", async () => {
      await page.locator(".history-panel .state-panel--loading").waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
      const outcomes = [
        page.getByRole("list", { name: "Entri riwayat fixture sintetis", exact: true }),
        page.getByText("Riwayat record tidak ditemukan.", { exact: true }),
        page.getByText("Riwayat belum dapat dimuat.", { exact: true }),
      ];
      for (const outcome of outcomes) {
        if (await outcome.first().isVisible().catch(() => false)) return;
      }
      throw new Error("no history entries and no clear empty or error message");
    });

    run.skip(vp, "history is marked as not the current state", "the note 'Riwayat sintetis ini bukan keadaan terkini.' appears only while history loads (EventDetail.tsx:147); the kicker is checked instead");

    // Origins view: the claims section "Bukti" with kicker "Klaim per sumber" (ApiEventDetail). Heading "Bukti" is confirmed.
    await run.step(page, vp, "origins: the 'Bukti' section lists claims, or states that no evidence is recorded", async () => {
      await page.getByRole("heading", { name: "Bukti", exact: true }).waitFor({ state: "visible" });
      await page.getByText("Klaim per sumber", { exact: true }).waitFor({ state: "visible" });
      // Scoped to the claims section (aria-labelledby="api-claim-heading"), so impact cards in the facts section are not counted.
      const claims = page.locator('section[aria-labelledby="api-claim-heading"] article.claim-card');
      const empty = page.getByText("Bukti tidak tersedia pada fixture demo ini.", { exact: true });
      if ((await claims.count()) === 0 && !(await empty.isVisible().catch(() => false))) {
        throw new Error("no claim cards and no empty-evidence message");
      }
    });

    run.skip(vp, "each claim names its source", "label not confirmed: the claim card markup shows the evidence label and quote; judge from screenshot");

    // Direct route: #detail/api/<id> (routeFromHash in App.tsx, screen "detail-api").
    await run.step(page, vp, "direct route #detail/api/<id> shows the same history and time section", async () => {
      const id = await firstEventId(page);
      if (id === null) throw new Error("no event_id in /api/v1/events");
      await page.goto(`${BASE}/#detail/api/${encodeURIComponent(id)}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Waktu dan cakupan", exact: true }).waitFor({ state: "visible" });
      await page.getByRole("heading", { name: "Perubahan", exact: true }).waitFor({ state: "visible" });
    });

    await run.step(page, vp, "time limit (proposed): T3 steps finished within 120 s", async () => {
      const elapsed = performance.now() - started;
      if (elapsed > TIME_LIMIT_MS) throw new Error(`took ${Math.round(elapsed / 1000)} s`);
    }, false);
  } finally {
    run.taskSeconds[vp] = Math.round((performance.now() - started) / 100) / 10;
    await context.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const { runId, outDir } = resolveRun();
  mkdirSync(outDir, { recursive: true });
  const run = new UatRun(outDir);
  const startedAt = new Date().toISOString();

  if (await assertDemoDataset(run)) {
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      for (const viewport of VIEWPORTS) {
        try {
          await runViewport(browser, viewport, run);
        } catch (cause) {
          run.recordFailure(viewport.name, "viewport run", cause);
        }
      }
    } catch (cause) {
      run.recordFailure("launch", "chromium launch", cause);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  const failedFatal = run.steps.filter((step) => step.fatal && !step.ok).length;
  const failedSoft = run.steps.filter((step) => !step.fatal && !step.ok).length;
  const log = {
    script: SCRIPT_NAME,
    task: TASK_ID,
    requirement: REQUIREMENT,
    mode: "automated walkthrough (browser subagent); not user acceptance",
    dataset: "demo",
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    time_limit_seconds: TIME_LIMIT_MS / 1000,
    task_seconds: run.taskSeconds,
    steps: run.steps,
    skipped: run.skipped,
    notes: run.notes,
    summary: { passed: run.steps.filter((step) => step.ok).length, failed_fatal: failedFatal, failed_soft: failedSoft },
  };
  writeFileSync(join(outDir, `${SCRIPT_NAME}.json`), `${JSON.stringify(log, null, 2)}\n`, "utf8");
  console.log(`${SCRIPT_NAME}: ${log.summary.passed} passed, ${failedFatal} fatal failed, ${failedSoft} non-fatal failed. Log: ${join(outDir, `${SCRIPT_NAME}.json`)}`);
  process.exitCode = failedFatal > 0 ? 1 : 0;
}

main().catch((cause: unknown) => {
  console.error(`${SCRIPT_NAME}: run aborted: ${redact(cause)}`);
  process.exitCode = 1;
});
