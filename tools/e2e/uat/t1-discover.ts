/*
 * UAT T1 (US-01, discovery). Automated walkthrough (browser subagent). Not user acceptance: see docs/testing/UAT.md.
 *
 * Demo dataset only. Start `npm run dev` first (Vite on 127.0.0.1:5173, Worker on :8787). T1 needs no login.
 * Run one file at a time from the repository root: npx tsx tools/e2e/uat/t1-discover.ts
 * Output: .codex-build/uat/<run-id>/t1-discover.json and screenshots. <run-id> is UAT_RUN_ID, or a timestamp if unset.
 *
 * Exit code 1 when a fatal step fails or the dataset is not demo. Non-fatal steps are logged and do not change the exit code.
 * Labels were read from apps/web/src (MapHome.tsx, MapEventList.tsx, MapPopup.tsx, EventDetail.tsx).
 * Label not confirmed: the warning-boundary wording. The public map has no boundary label or polygon, so that check is
 * recorded as skipped and must be judged from the screenshot.
 * Not scripted here: 320 px and 200% text (UAT.md section 7).
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYNTHETIC_DEMO_PASSWORD } from "../../accounts/demo-accounts.js";

const SCRIPT_NAME = "t1-discover";
const TASK_ID = "T1";
const REQUIREMENT = "US-01";
const BASE = "http://127.0.0.1:5173";
const TIME_LIMIT_MS = 60_000;
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
  // The first-visit introduction opens on #peta. Its skip control is a button labelled "Lewati" (OnboardingIntro.tsx).
  const skip = page.getByRole("button", { name: "Lewati", exact: true });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click().catch(() => undefined);
    await page.waitForTimeout(500);
  }
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

    if (vp === "phone") {
      // Phone list fallback: the toggle's accessible name starts with "Daftar laporan" (MapHome.tsx).
      await run.step(page, vp, "phone: open the list with the 'Daftar laporan' toggle when it is shown", async () => {
        const toggle = page.getByRole("button", { name: /^Daftar laporan/u });
        if (await toggle.isVisible()) {
          await toggle.click();
        }
      });
    }

    // Cards: button.map-card inside ul[aria-label="Laporan terbit"] (MapEventList.tsx).
    const cards = page.locator('ul[aria-label="Laporan terbit"] button.map-card');
    await run.step(page, vp, "list 'Laporan terbit' shows at least one report card", async () => {
      await cards.first().waitFor({ state: "visible" });
    });

    await run.step(page, vp, "the report card is a button, so it is keyboard reachable (NFR-03)", async () => {
      const tag = await cards.first().evaluate((element) => element.tagName);
      if (tag !== "BUTTON") throw new Error(`card element is ${tag}`);
    });

    // Event time: "Waktu kejadian: <value>" in .map-card__meta (MapEventList.tsx).
    await run.step(page, vp, "the card shows the event time ('Waktu kejadian')", async () => {
      const text = await cards.first().innerText();
      if (!/Waktu kejadian:\s*\S/u.test(text)) throw new Error("no 'Waktu kejadian:' line on the first card");
    });

    // Source: sourceCountText gives "<n> sumber" or "Sumber tidak tercatat" (published-events.ts).
    await run.step(page, vp, "the card shows the source count", async () => {
      const text = await cards.first().locator(".map-card__sources").innerText();
      if (!/\d+ sumber|Sumber tidak tercatat/u.test(text)) throw new Error("source count line not recognised");
    });

    await run.step(page, vp, "select the card; the popup offers 'Lihat detail'", async () => {
      await cards.first().click();
      await page.getByRole("button", { name: "Lihat detail", exact: true }).first().waitFor({ state: "visible" });
    });

    // Label confirmed for point wording: "Titik lokasi dari sumber." / "Titik lokasi perkiraan dari sumber."
    // and "Lokasi belum dipetakan dari sumber." (MapPopup.tsx:56-57). Non-fatal.
    await run.step(page, vp, "popup states the location: point wording or 'Belum dipetakan'", async () => {
      await page.getByText(/Titik lokasi|Lokasi belum dipetakan|Belum dipetakan/u).first().waitFor({ state: "visible" });
    }, false);

    // Label not confirmed: no warning-boundary wording exists on the public map (MapPopup.tsx:56-57 captions every mapped marker as a point).
    run.skip(vp, "warning boundary is distinguishable from a point", "label not confirmed: no boundary wording or polygon on #peta; judge from screenshot");

    await run.step(page, vp, "open 'Detail laporan' and read its event time and scope", async () => {
      await page.getByRole("button", { name: "Lihat detail", exact: true }).first().click();
      await page.getByRole("heading", { name: "Detail laporan", exact: true }).waitFor({ state: "visible" });
      await page.getByText("Waktu dan cakupan", { exact: true }).waitFor({ state: "visible" });
      await page.getByText("Waktu kejadian", { exact: true }).first().waitFor({ state: "visible" });
    });

    await run.step(page, vp, "time limit: event time and location read within 60 s (NFR-03 target)", async () => {
      // Includes page load and waits, so this is an upper bound on the user's own time.
      const elapsed = performance.now() - started;
      if (elapsed > TIME_LIMIT_MS) throw new Error(`took ${Math.round(elapsed / 1000)} s`);
    });
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
