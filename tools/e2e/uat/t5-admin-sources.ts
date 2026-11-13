/*
 * UAT T5 (administrator, source preview in demo only). Automated walkthrough (browser subagent). Not user acceptance: see docs/testing/UAT.md.
 *
 * Demo dataset only, as demo.admin. Start `npm run dev` with the accounts runtime first:
 *   npm run accounts:local -- --enable --demo --state accounts-demo
 *   WASPADA_LOCAL_ACCOUNTS=true npm run dev
 * Run one file at a time from the repository root: npx tsx tools/e2e/uat/t5-admin-sources.ts
 * Output: .codex-build/uat/<run-id>/t5-admin-sources.json and screenshots. <run-id> is UAT_RUN_ID, or a timestamp if unset.
 *
 * The run records which external hosts load while the 'Demo sumber' tab is open, as a note. It does not pass or fail on that.
 * Exit code 1 when a fatal step fails or the dataset is not demo. Non-fatal steps do not change the exit code.
 * Labels were read from apps/web/src (AdminWorkspace.tsx, AdminSourceTab.tsx, UnifiedSourceExplorer.tsx, admin-workspace-model.ts).
 * Not scripted here: 320 px and 200% text (UAT.md section 7).
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYNTHETIC_DEMO_PASSWORD } from "../../accounts/demo-accounts.js";

const SCRIPT_NAME = "t5-admin-sources";
const TASK_ID = "T5";
const REQUIREMENT = "none directly; supports US-03 (origins) and NFR-07 (protected administrator access)";
const BASE = "http://127.0.0.1:5173";
const TIME_LIMIT_MS = 120_000; // Proposed: the SDP sets no time limit for this task.
const DEMO_USERNAME = "demo.admin";
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

/** Signs in on #masuk. Labels: "Username" and "Kata sandi" (AccountPages.tsx), submit button "Masuk". */
async function login(page: Page, username: string): Promise<void> {
  await page.goto(`${BASE}/#masuk`, { waitUntil: "domcontentloaded" });
  await page.locator("#login-username").fill(username);
  await page.locator("#login-password").fill(SYNTHETIC_DEMO_PASSWORD);
  const [loginResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/v1/auth/login") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Masuk", exact: true }).click(),
  ]);
  if (!loginResponse.ok()) throw new Error(`login returned HTTP ${loginResponse.status()}`);
  const session = await page.request.get(`${BASE}/api/v1/auth/session`);
  const body = (await session.json()) as { status?: unknown };
  if (body.status !== "authenticated") throw new Error("session is not authenticated after login");
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

  // External hosts requested while the source tab is open. Recorded as a note only.
  let recording = false;
  const hosts = new Set<string>();
  page.on("request", (request) => {
    if (!recording) return;
    try {
      const url = new URL(request.url());
      if (url.hostname !== "" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") hosts.add(url.host);
    } catch {
      /* not a URL: ignore */
    }
  });

  try {
    await run.step(page, vp, `sign in as ${DEMO_USERNAME} (#masuk)`, () => login(page, DEMO_USERNAME));
    await dismissIntro(page);

    await run.step(page, vp, "open 'Demo sumber' (#admin/sumber) and check it is selected", async () => {
      recording = true;
      await page.goto(`${BASE}/#admin/sumber`, { waitUntil: "domcontentloaded" });
      const tab = page.getByRole("tab", { name: "Demo sumber", exact: true });
      await tab.waitFor({ state: "visible" });
      if ((await tab.getAttribute("aria-selected")) !== "true") throw new Error("'Demo sumber' is not selected");
    });

    // The explorer is lazy-loaded (AdminSourceTab.tsx), so allow more time for its root element.
    await run.step(page, vp, "source explorer (.unified-source-explorer) is rendered", async () => {
      await page.locator(".unified-source-explorer").waitFor({ state: "visible", timeout: 20_000 });
    });

    // Demo-only notice: confirmed in UnifiedSourceExplorer.tsx (kicker, badge, not-published label, provider note).
    await run.step(page, vp, "demo-only notice: kicker 'Demo sumber · pratinjau terpisah'", async () => {
      await page.getByText("Demo sumber · pratinjau terpisah", { exact: true }).waitFor({ state: "visible" });
    });

    await run.step(page, vp, "demo-only notice: badge 'DEMO · belum dipublikasi'", async () => {
      await page.getByText("DEMO · belum dipublikasi", { exact: true }).first().waitFor({ state: "visible" });
    });

    await run.step(page, vp, "demo-only notice: 'Belum melalui publikasi Waspada'", async () => {
      await page.getByText("Belum melalui publikasi Waspada", { exact: true }).waitFor({ state: "visible" });
    });

    await run.step(page, vp, "provider note: 'Default lokal; permintaan penyedia hanya setelah tindakan Anda.'", async () => {
      await page.getByText("Default lokal; permintaan penyedia hanya setelah tindakan Anda.", { exact: true }).waitFor({ state: "visible" });
    });

    await run.step(page, vp, "the live guard ('hanya tersedia pada mode demo') is not shown on the demo dataset", async () => {
      if ((await page.getByText(/Pratinjau sumber ini hanya tersedia pada mode demo/u).count()) > 0) {
        throw new Error("the live-mode guard is shown on the demo dataset");
      }
    });

    await run.step(page, vp, "heading 'Peta sumber Jakarta' is visible", async () => {
      await page.getByRole("heading", { name: "Peta sumber Jakarta", exact: true }).waitFor({ state: "visible" });
    });

    await run.step(page, vp, "administrator sees the admin-only 'Akun & peran' tab", async () => {
      await page.getByRole("tab", { name: "Akun & peran", exact: true }).waitFor({ state: "visible" });
    });

    recording = false;
    run.note(`${vp}: external hosts requested while on #admin/sumber: ${hosts.size > 0 ? [...hosts].join(", ") : "none"}. Recorded for review; not a pass or fail.`);

    await run.step(page, vp, "time limit (proposed): T5 steps finished within 120 s", async () => {
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
