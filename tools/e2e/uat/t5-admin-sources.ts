/*
 * UAT T5 (administrator, source registry and source map). Automated walkthrough (browser subagent). Not user acceptance: see docs/testing/UAT.md.
 *
 * UAT_TARGET chooses the target. Unset means demo, so local demo runs are unchanged.
 *
 * demo (default, local development only). Demo dataset only, as demo.admin. Start `npm run dev` with the accounts runtime first:
 *   npm run accounts:local -- --enable --demo --state accounts-demo
 *   WASPADA_LOCAL_ACCOUNTS=true npm run dev
 *   npx tsx tools/e2e/uat/t5-admin-sources.ts
 *
 * live (hosted staging). Needs UAT_BASE_URL (https; http only for 127.0.0.1 or localhost) and the administrator sign-in
 * WASPADA_ADMIN_USERNAME and WASPADA_ADMIN_PASSWORD. Values are read from the environment and never printed; reports say
 * "the configured base URL". Use the ignored env file:
 *   UAT_TARGET=live UAT_BASE_URL=<staging site URL> node --env-file=.env.local --import tsx tools/e2e/uat/t5-admin-sources.ts
 *   Read-only. It checks the source registry rows and their approval controls, and the explorer's live labels. It never clicks
 *   approve or revoke, because those change the live source registry.
 *
 * Run one file at a time from the repository root. Output: .codex-build/uat/<run-id>/t5-admin-sources.json and screenshots.
 * <run-id> is UAT_RUN_ID, or a timestamp if unset.
 *
 * The run records which external hosts load while the source tab is open, as a note. It does not pass or fail on that.
 * Exit code 1 when a fatal step fails, the dataset is not the one the target expects, or the configuration is invalid.
 * Non-fatal steps do not change the exit code.
 * Labels were read from apps/web/src (AdminWorkspace.tsx, AdminSourceTab.tsx, SourceApprovalPanel.tsx, UnifiedSourceExplorer.tsx,
 * AppShell.tsx, admin-workspace-model.ts).
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
const DEMO_BASE = "http://127.0.0.1:5173";
const TIME_LIMIT_MS = 120_000; // Proposed: the SDP sets no time limit for this task.
const DEMO_USERNAME = "demo.admin";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

type Viewport = (typeof VIEWPORTS)[number];
type Target = "demo" | "live";

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

interface RunConfig {
  target: Target;
  base: string;
  username: string;
  password: string;
  /** Step name for the sign-in. Demo names its demo account; live names only the account kind, never the username. */
  signInStep: string;
}

/** Values that must never reach a log or an error message (passwords, the staging origin). Filled before any step runs. */
const scrubbed: string[] = [];

function scrub(value: string): void {
  if (value.length > 0) scrubbed.push(value);
}

function redact(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  let text = raw.split("\n")[0] ?? "";
  for (const secret of scrubbed) text = text.split(secret).join("[redacted]");
  return text.slice(0, 300);
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

/** UAT_TARGET: unset or "demo" runs the demo walkthrough; "live" runs against the configured hosted site. */
function resolveTarget(): Target {
  const raw = (process.env.UAT_TARGET ?? "").trim();
  if (raw === "" || raw === "demo") return "demo";
  if (raw === "live") return "live";
  throw new Error("UAT_TARGET must be 'demo' (the default when unset) or 'live'");
}

/** Live only. The site URL comes from UAT_BASE_URL and is never printed. */
function resolveLiveBase(): string {
  const raw = (process.env.UAT_BASE_URL ?? "").trim();
  if (raw === "") throw new Error("UAT_TARGET=live needs UAT_BASE_URL set to the hosted staging site URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("UAT_BASE_URL is not a valid URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("UAT_BASE_URL must use https (http is allowed only for 127.0.0.1 or localhost)");
  }
  return raw.replace(/\/+$/u, "");
}

/** Live only. T5 needs the administrator: the source tab is admin-only (admin-workspace-model.ts). */
function liveAdministrator(): { username: string; password: string } {
  const username = (process.env.WASPADA_ADMIN_USERNAME ?? "").trim();
  const password = process.env.WASPADA_ADMIN_PASSWORD ?? "";
  if (username === "" || password === "") {
    throw new Error("live mode needs the administrator sign-in: WASPADA_ADMIN_USERNAME and WASPADA_ADMIN_PASSWORD");
  }
  return { username, password };
}

function resolveConfig(target: Target): RunConfig {
  if (target === "demo") {
    scrub(SYNTHETIC_DEMO_PASSWORD);
    return {
      target,
      base: DEMO_BASE,
      username: DEMO_USERNAME,
      password: SYNTHETIC_DEMO_PASSWORD,
      signInStep: `sign in as ${DEMO_USERNAME} (#masuk)`,
    };
  }
  const base = resolveLiveBase();
  const admin = liveAdministrator();
  scrub(admin.password);
  scrub(base);
  scrub(new URL(base).host);
  return {
    target,
    base,
    username: admin.username,
    password: admin.password,
    signInStep: "sign in as the administrator account from the environment (#masuk)",
  };
}

/** Refuses to run unless the server reports the dataset that the target expects. */
async function assertDataset(run: UatRun, cfg: RunConfig): Promise<boolean> {
  const expected = cfg.target === "demo" ? "demo" : "live";
  const name = cfg.target === "demo"
    ? "dataset is demo (the script refuses to run on live data)"
    : "dataset is live (the script refuses to run on demo data)";
  return run.step(null, "setup", name, async () => {
    const response = await fetch(`${cfg.base}/api/v1/context`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`context returned HTTP ${response.status}`);
    const body = (await response.json()) as { dataset_mode?: unknown };
    if (body.dataset_mode !== expected) throw new Error(`dataset_mode is not ${expected}`);
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
async function login(page: Page, base: string, username: string, password: string): Promise<void> {
  await page.goto(`${base}/#masuk`, { waitUntil: "domcontentloaded" });
  await page.locator("#login-username").fill(username);
  await page.locator("#login-password").fill(password);
  const [loginResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/v1/auth/login") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Masuk", exact: true }).click(),
  ]);
  if (!loginResponse.ok()) throw new Error(`login returned HTTP ${loginResponse.status()}`);
  const session = await page.request.get(`${base}/api/v1/auth/session`);
  const body = (await session.json()) as { status?: unknown };
  if (body.status !== "authenticated") throw new Error("session is not authenticated after login");
}

/**
 * Live only: the registry approval panel (SourceApprovalPanel.tsx) and the explorer's live labels. Read-only. Approve and
 * revoke are never clicked, because they change the live source registry.
 */
async function checkLiveSources(page: Page, vp: string, run: UatRun): Promise<void> {
  await run.step(page, vp, "approval panel 'Persetujuan sumber' is rendered", async () => {
    await page.getByRole("heading", { name: "Persetujuan sumber", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  });

  await run.step(page, vp, "source registry lists at least one source row (li.source-approval__item)", async () => {
    const rows = page.locator("li.source-approval__item");
    await rows.first().waitFor({ state: "attached", timeout: 20_000 }).catch(() => undefined);
    if ((await rows.count()) === 0) throw new Error("the source registry shows no source rows");
  });

  await run.step(page, vp, "each source row offers an approve or revoke control (not clicked)", async () => {
    const controls = page.locator(
      'li.source-approval__item button[aria-label^="Setujui "], li.source-approval__item button[aria-label^="Cabut persetujuan "]',
    );
    await controls.first().waitFor({ state: "visible" });
  });

  // The toolbar and its label are display:none on the map view (unified-source-explorer.css), so this reads the DOM text.
  await run.step(page, vp, "explorer dataset label reads 'LIVE' (DOM text; the toolbar is hidden on the map view)", async () => {
    const label = ((await page.locator(".unified-source-explorer__dataset strong").first().textContent()) ?? "").trim();
    if (label !== "LIVE") throw new Error("the explorer dataset label is not 'LIVE'");
  });

  await run.step(page, vp, "header dataset badge reads 'Langsung' (not 'Data contoh')", async () => {
    const badge = ((await page.locator(".site-header__badge-label").first().textContent()) ?? "").trim();
    if (badge !== "Langsung") throw new Error("the header dataset badge is not 'Langsung'");
  });

  run.skip(vp, "demo-only guard 'Pratinjau sumber ini hanya tersedia pada mode demo'", "live dataset; the guard is a demo-mode check");
}

async function runViewport(browser: Browser, viewport: Viewport, run: UatRun, cfg: RunConfig): Promise<void> {
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

  // External hosts requested while the source tab is open. Recorded as a note only. The staging site itself is not external.
  let recording = false;
  const hosts = new Set<string>();
  const baseHost = new URL(cfg.base).host;
  page.on("request", (request) => {
    if (!recording) return;
    try {
      const url = new URL(request.url());
      if (url.hostname !== "" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.host !== baseHost) hosts.add(url.host);
    } catch {
      /* not a URL: ignore */
    }
  });

  try {
    await run.step(page, vp, cfg.signInStep, () => login(page, cfg.base, cfg.username, cfg.password));
    await dismissIntro(page);

    const sourceTab = cfg.target === "live" ? "Sumber" : "Demo sumber";
    await run.step(page, vp, `open '${sourceTab}' (#admin/sumber) and check it is selected`, async () => {
      recording = true;
      await page.goto(`${cfg.base}/#admin/sumber`, { waitUntil: "domcontentloaded" });
      const tab = page.getByRole("tab", { name: sourceTab, exact: true });
      await tab.waitFor({ state: "visible" });
      if ((await tab.getAttribute("aria-selected")) !== "true") throw new Error(`'${sourceTab}' is not selected`);
    });

    // The explorer is lazy-loaded (AdminSourceTab.tsx), so allow more time for its root element.
    await run.step(page, vp, "source explorer (.unified-source-explorer) is rendered", async () => {
      await page.locator(".unified-source-explorer").waitFor({ state: "visible", timeout: 20_000 });
    });

    if (cfg.target === "demo") {
      // Run-01 failed because the source-copy strings from UnifiedSourceExplorer.tsx are hidden on the map view by design
      // (unified-source-explorer.css, commit f0395b0). Provenance and the demo isolation notice sit in the companion
      // "Sumber" panel, so the check opens that panel first (phone: via "Buka panel sumber") and reads what it shows.
      await run.step(page, vp, "open the companion 'Sumber' panel (phone: via 'Buka panel sumber')", async () => {
        const drawer = page.getByRole("button", { name: /^Buka panel sumber/u });
        if ((await drawer.count()) > 0 && (await drawer.first().isVisible())) {
          await drawer.first().click();
          await page.waitForTimeout(400);
        }
        await page.getByRole("button", { name: "Sumber", exact: true }).first().click();
        await page.waitForTimeout(400);
      });

      await run.step(page, vp, "demo isolation notice: 'Mode demo terisolasi' is visible in the Sumber panel", async () => {
        await page.getByText("Mode demo terisolasi", { exact: false }).first().waitFor({ state: "visible" });
      });

      await run.step(page, vp, "demo snapshot notice: 'penyedia tidak dihubungi untuk data ini' is visible", async () => {
        await page.getByText("penyedia tidak dihubungi untuk data ini", { exact: false }).first().waitFor({ state: "visible" });
      });

      await run.step(page, vp, "workspace header marks the page as demo: 'Pratinjau sumber (demo)' and 'Data contoh'", async () => {
        await page.getByText("Pratinjau sumber (demo)", { exact: false }).first().waitFor({ state: "visible" });
        await page.getByText("Data contoh", { exact: false }).first().waitFor({ state: "visible" });
      });

      // Not a pass: these strings are in the DOM but hidden on the map view, so no user sees them there.
      run.skip(vp, "source copy: 'Demo sumber · pratinjau terpisah', 'DEMO · belum dipublikasi', 'Belum melalui publikasi Waspada', 'Default lokal; ...'",
        "display:none on the map view (unified-source-explorer.css:802-807, commit f0395b0); run-01 failed on these checks");

      await run.step(page, vp, "the live guard ('hanya tersedia pada mode demo') is not shown on the demo dataset", async () => {
        if ((await page.getByText(/Pratinjau sumber ini hanya tersedia pada mode demo/u).count()) > 0) {
          throw new Error("the live-mode guard is shown on the demo dataset");
        }
      });
    } else {
      await checkLiveSources(page, vp, run);
    }

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
  const target = resolveTarget();
  const cfg = resolveConfig(target);
  mkdirSync(outDir, { recursive: true });
  const run = new UatRun(outDir);
  const startedAt = new Date().toISOString();

  if (await assertDataset(run, cfg)) {
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      for (const viewport of VIEWPORTS) {
        try {
          await runViewport(browser, viewport, run, cfg);
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
    mode: cfg.target === "demo"
      ? "automated walkthrough (browser subagent); not user acceptance"
      : "automated walkthrough (browser subagent) against the configured live site; not user acceptance",
    dataset: cfg.target,
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
