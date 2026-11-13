/*
 * UAT T2 (US-02, following updates). Automated walkthrough (browser subagent). Not user acceptance: see docs/testing/UAT.md.
 *
 * Demo dataset only, as demo.warga. Start `npm run dev` with the accounts runtime first:
 *   npm run accounts:local -- --enable --demo --state accounts-demo
 *   WASPADA_LOCAL_ACCOUNTS=true npm run dev
 * Run one file at a time from the repository root: npx tsx tools/e2e/uat/t2-updates.ts
 * Output: .codex-build/uat/<run-id>/t2-updates.json and screenshots. <run-id> is UAT_RUN_ID, or a timestamp if unset.
 *
 * What this run can show: saving an interest and the demo gates. The matched-update checks (reason shown, no duplicate
 * alert) need the live dataset, so they are recorded as skipped, not passed. The password is read from
 * tools/accounts/demo-accounts.ts and is never printed; error text is redacted.
 * Exit code 1 when a fatal step fails or the dataset is not demo. Non-fatal steps do not change the exit code.
 * Labels were read from apps/web/src (AccountPages.tsx, Preferences.tsx, BriefingResults.tsx, UpdatesCenter.tsx).
 * Not scripted here: 320 px and 200% text (UAT.md section 7).
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYNTHETIC_DEMO_PASSWORD } from "../../accounts/demo-accounts.js";

const SCRIPT_NAME = "t2-updates";
const TASK_ID = "T2";
const REQUIREMENT = "US-02";
const BASE = "http://127.0.0.1:5173";
const TIME_LIMIT_MS = 120_000; // Proposed: the SDP sets no time limit for US-02.
const DEMO_USERNAME = "demo.warga";
const SAMPLE_PLACE = "Menteng"; // A public district name. Participants must not enter their own address.
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
  try {
    await run.step(page, vp, `sign in as ${DEMO_USERNAME} (#masuk)`, () => login(page, DEMO_USERNAME));

    await run.step(page, vp, "open 'Ringkasan saya' (#ringkasan-saya)", async () => {
      await page.goto(`${BASE}/#ringkasan-saya`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Ringkasan saya", exact: true }).first().waitFor({ state: "visible" });
    });

    // Form: form.preference-entry with label "Tambah tempat" and submit button "Tambah" (Preferences.tsx).
    await run.step(page, vp, "add a place under 'Tambah tempat' and press 'Tambah'", async () => {
      const form = page.locator("form.preference-entry").filter({ has: page.getByLabel("Tambah tempat", { exact: true }) });
      await form.getByLabel("Tambah tempat", { exact: true }).fill(SAMPLE_PLACE);
      await form.getByRole("button", { name: "Tambah", exact: true }).click();
      await page.getByText("Minat ditambahkan. Simpan untuk menyimpannya di browser ini.", { exact: true }).waitFor({ state: "visible" });
    });

    await run.step(page, vp, "save with 'Simpan di perangkat ini'", async () => {
      await page.getByRole("button", { name: "Simpan di perangkat ini", exact: true }).click();
      await page.getByText("Minat berhasil disimpan di browser ini.", { exact: true }).waitFor({ state: "visible" });
    });

    await run.step(page, vp, "reload: the saved place is still listed under 'Minat tempat'", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await page.getByRole("list", { name: "Minat tempat", exact: true }).getByText(SAMPLE_PLACE, { exact: true }).waitFor({ state: "visible" });
    });

    await run.step(page, vp, "demo gate on 'Ringkasan saya': live briefing is unavailable, and no live match is shown", async () => {
      await page.getByText(/Briefing live tidak tersedia pada mode demo\./u).first().waitFor({ state: "visible" });
      if ((await page.getByText("Mengapa muncul", { exact: true }).count()) > 0) {
        throw new Error("a 'Mengapa muncul' reason is shown on the demo dataset");
      }
    });

    run.skip(vp, "a relevant update shows its 'Mengapa muncul' reason (US-02)", "requires the live dataset: BriefingResults.tsx:164-166 hides matches in demo mode");

    await run.step(page, vp, "open 'Pembaruan' (#pembaruan) and read the demo gate", async () => {
      await page.goto(`${BASE}/#pembaruan`, { waitUntil: "domcontentloaded" });
      await page.getByText(/Pembaruan live tidak tersedia pada mode demo\./u).first().waitFor({ state: "visible" });
      if ((await page.locator('ol[aria-label="Pembaruan publik yang cocok"]').count()) > 0) {
        throw new Error("matched updates are listed on the demo dataset");
      }
    });

    run.skip(vp, "one change is shown once with no duplicate alert (US-02)", "requires the live dataset: UpdatesCenter.tsx:668 gate; needs a real correction in a live run");
    run.skip(vp, "version history or source of a matched update", "requires the live dataset: no matched update is listed in demo mode");

    await run.step(page, vp, "time limit (proposed): T2 steps finished within 120 s", async () => {
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
  run.note("Interests are kept in this browser's storage only. Each viewport run uses a fresh browser context, so no interest carries over.");

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
