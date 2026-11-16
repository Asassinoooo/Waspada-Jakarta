/*
 * UAT T4 (US-03, moderator review of one proposal). Automated walkthrough (browser subagent). Not user acceptance: see docs/testing/UAT.md.
 *
 * UAT_TARGET chooses the target. Unset means demo, so local demo runs are unchanged.
 *
 * demo (default, local development only). Demo dataset only, as demo.moderator. Start `npm run dev` with the accounts runtime first:
 *   npm run accounts:local -- --enable --demo --state accounts-demo
 *   WASPADA_LOCAL_ACCOUNTS=true npm run dev
 *   npx tsx tools/e2e/uat/t4-moderator.ts
 *
 * live (hosted staging). Needs UAT_BASE_URL, the staging site URL (https; http only for 127.0.0.1 or localhost). Values are read
 * from the environment and never printed; reports say "the configured base URL". Use the ignored env file:
 *   UAT_TARGET=live UAT_BASE_URL=<staging site URL> node --env-file=.env.local --import tsx tools/e2e/uat/t4-moderator.ts
 *   Sign-in: UAT_MODERATOR_USERNAME and UAT_MODERATOR_PASSWORD. The hosted bootstrap creates no moderator account, so when these
 *   are unset the script signs in as the administrator (WASPADA_ADMIN_USERNAME and WASPADA_ADMIN_PASSWORD) and logs that.
 *   Live reads the queue. It changes a proposal only when UAT_T4_ACTION is set to reject or publish. Either one changes a real
 *   proposal, and publish also changes the public site. An empty queue is the note "no proposal awaiting review yet", not a failure.
 *
 * Run one file at a time from the repository root. Output: .codex-build/uat/<run-id>/t4-moderator.json and screenshots.
 * <run-id> is UAT_RUN_ID, or a timestamp if unset.
 *
 * Decision: UAT_T4_ACTION=reject or publish. Demo default: reject. Live default: none (read-only). The decision runs once per run,
 * on the desktop viewport. The phone viewport reviews the same kind of proposal read-only. Demo precondition: the moderation queue
 * must hold at least one proposal. If it is empty, the step fails as "precondition not met" and is not a pass.
 * Exit code 1 when a fatal step fails, the dataset is not the one the target expects, or the configuration is invalid.
 * Non-fatal steps do not change the exit code.
 * Labels were read from apps/web/src (AdminWorkspace.tsx, ui/Tabs.tsx, ModeratorReview.tsx, admin-workspace-model.ts).
 * Not scripted here: 320 px and 200% text (UAT.md section 7).
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYNTHETIC_DEMO_PASSWORD } from "../../accounts/demo-accounts.js";

const SCRIPT_NAME = "t4-moderator";
const TASK_ID = "T4";
const REQUIREMENT = "US-03";
const DEMO_BASE = "http://127.0.0.1:5173";
const TIME_LIMIT_MS = 300_000; // Proposed: the SDP sets no time limit for a review.
const DEMO_USERNAME = "demo.moderator";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

type Viewport = (typeof VIEWPORTS)[number];
type Action = "reject" | "publish";
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
  /** Live only: which account kind signed in. */
  account: "moderator" | "administrator" | null;
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

/**
 * Live sign-in from the environment. The moderator pair is used when it is set. The hosted bootstrap creates no moderator
 * account, so otherwise the administrator pair is used and the run records that.
 */
function liveSignIn(): { username: string; password: string; account: "moderator" | "administrator" } {
  const moderatorName = (process.env.UAT_MODERATOR_USERNAME ?? "").trim();
  const moderatorPassword = process.env.UAT_MODERATOR_PASSWORD ?? "";
  if ((moderatorName === "") !== (moderatorPassword === "")) {
    throw new Error("set both UAT_MODERATOR_USERNAME and UAT_MODERATOR_PASSWORD, or neither");
  }
  if (moderatorName !== "") return { username: moderatorName, password: moderatorPassword, account: "moderator" };
  const adminName = (process.env.WASPADA_ADMIN_USERNAME ?? "").trim();
  const adminPassword = process.env.WASPADA_ADMIN_PASSWORD ?? "";
  if (adminName === "" || adminPassword === "") {
    throw new Error("live mode needs a sign-in: UAT_MODERATOR_USERNAME and UAT_MODERATOR_PASSWORD, or WASPADA_ADMIN_USERNAME and WASPADA_ADMIN_PASSWORD");
  }
  return { username: adminName, password: adminPassword, account: "administrator" };
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
      account: null,
    };
  }
  const base = resolveLiveBase();
  const signIn = liveSignIn();
  scrub(signIn.password);
  scrub(base);
  scrub(new URL(base).host);
  return {
    target,
    base,
    username: signIn.username,
    password: signIn.password,
    signInStep: `sign in as the ${signIn.account} account from the environment (#masuk)`,
    account: signIn.account,
  };
}

/** UAT_T4_ACTION. Demo defaults to reject. Live defaults to no decision (read-only) unless it is set explicitly. */
function resolveAction(target: Target): Action | null {
  const raw = (process.env.UAT_T4_ACTION ?? (target === "live" ? "" : "reject")).trim();
  if (target === "live" && raw === "") return null;
  if (raw !== "reject" && raw !== "publish") throw new Error("UAT_T4_ACTION must be 'reject' or 'publish'");
  return raw;
}

function actionNote(cfg: RunConfig, action: Action | null): string {
  if (cfg.target === "demo") return `Decision for this run: ${action}. It changes one proposal in the local demo database.`;
  if (action === null) return "Decision for this run: none (read-only). Set UAT_T4_ACTION to reject or publish to change one real proposal.";
  return action === "publish"
    ? "Decision for this run: publish. It changes one real proposal and publishes it to the live public site."
    : "Decision for this run: reject. It changes one real proposal on the live site.";
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

/**
 * Signs in on #masuk. Labels: "Username" and "Kata sandi" (AccountPages.tsx), submit button "Masuk".
 * Returns the role from the session body (admin, moderator or user), or null when the body has none.
 */
async function login(page: Page, base: string, username: string, password: string): Promise<string | null> {
  await page.goto(`${base}/#masuk`, { waitUntil: "domcontentloaded" });
  await page.locator("#login-username").fill(username);
  await page.locator("#login-password").fill(password);
  const [loginResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/v1/auth/login") && response.request().method() === "POST"),
    page.getByRole("button", { name: "Masuk", exact: true }).click(),
  ]);
  if (!loginResponse.ok()) throw new Error(`login returned HTTP ${loginResponse.status()}`);
  const session = await page.request.get(`${base}/api/v1/auth/session`);
  const body = (await session.json()) as { status?: unknown; user?: { role?: unknown } | null };
  if (body.status !== "authenticated") throw new Error("session is not authenticated after login");
  return typeof body.user?.role === "string" ? body.user.role : null;
}

async function runViewport(browser: Browser, viewport: Viewport, action: Action | null, run: UatRun, cfg: RunConfig): Promise<void> {
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
  const signedIn = { role: null as string | null };
  try {
    await run.step(page, vp, cfg.signInStep, async () => {
      signedIn.role = await login(page, cfg.base, cfg.username, cfg.password);
    });
    await dismissIntro(page);

    // Workspace tabs: role "tab", names from admin-workspace-model.ts, selected state from ui/Tabs.tsx.
    await run.step(page, vp, "open 'Tinjau bukti' (#admin/tinjau) and check it is selected", async () => {
      if (cfg.target === "live") {
        // Live: the queue request itself must succeed. A failed request and an empty queue look alike in the UI.
        const [queueResponse] = await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/moderation/proposals" && response.request().method() === "GET"),
          page.goto(`${cfg.base}/#admin/tinjau`, { waitUntil: "domcontentloaded" }),
        ]);
        if (!queueResponse.ok()) throw new Error(`moderation queue returned HTTP ${queueResponse.status()}`);
      } else {
        await page.goto(`${cfg.base}/#admin/tinjau`, { waitUntil: "domcontentloaded" });
      }
      const tab = page.getByRole("tab", { name: "Tinjau bukti", exact: true });
      await tab.waitFor({ state: "visible" });
      if ((await tab.getAttribute("aria-selected")) !== "true") throw new Error("'Tinjau bukti' is not selected");
    });

    // Role boundary: adminTabsFor gives a moderator only the moderator tabs (admin-workspace-model.ts). Presentation only; the server still guards data.
    // Live: an administrator is offered every tab, so the moderator boundary does not apply to that account.
    const boundaryTab = cfg.target === "live" ? "Sumber" : "Demo sumber";
    const boundaryName = `role boundary: '${boundaryTab}' and 'Akun & peran' are not offered to a moderator`;
    if (cfg.target === "live" && signedIn.role === "admin") {
      run.skip(vp, boundaryName, "signed in as an administrator; the moderator boundary applies to moderator accounts only");
    } else {
      await run.step(page, vp, boundaryName, async () => {
        for (const name of [boundaryTab, "Akun & peran"]) {
          if ((await page.getByRole("tab", { name, exact: true }).count()) > 0) {
            throw new Error(`the '${name}' tab is shown to a moderator`);
          }
        }
      });
    }

    const proposals = page.locator("button.proposal-card-btn");
    let hasProposal = true;
    if (cfg.target === "live") {
      await run.step(page, vp, "queue is reachable: 'Antrean proposal insiden' or the empty-queue status is shown", async () => {
        await page.locator('aside[aria-label="Antrean proposal insiden"], .moderator-empty-queue').first().waitFor({ state: "visible" });
      });
      hasProposal = await proposals.first().waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
      if (!hasProposal) run.note(`${vp}: no proposal awaiting review yet. Proposal selection and the decision did not run. This is not a failure.`);
    } else {
      await run.step(page, vp, "queue 'Antrean proposal insiden' is visible", async () => {
        await page.locator('aside[aria-label="Antrean proposal insiden"]').waitFor({ state: "visible" });
      });
      // Proposal cards: button.proposal-card-btn with data-proposal-id (ModeratorReview.tsx).
      await run.step(page, vp, "precondition: at least one proposal is in the queue", async () => {
        const found = await proposals.first().waitFor({ state: "visible" }).then(() => true, () => false);
        if (!found) throw new Error("precondition not met: no proposal in the moderation queue");
      });
    }

    if (hasProposal) {
      await run.step(page, vp, "select the first proposal and read its identity section", async () => {
        await proposals.first().click();
        await page.locator('section[aria-label="Identitas proposal insiden"]').waitFor({ state: "visible" });
      });

      await run.step(page, vp, "decision controls 'Setujui & Terbitkan' and 'Tolak' are visible", async () => {
        await page.getByRole("button", { name: "Setujui & Terbitkan", exact: true }).waitFor({ state: "visible" });
        await page.getByRole("button", { name: "Tolak", exact: true }).waitFor({ state: "visible" });
      });

      if ((await page.locator('aside[aria-label="Ringkasan perbedaan dari agen AI"]').count()) > 0) {
        run.note(`${vp}: a discrepancy callout is shown for this proposal; the decision belongs to the moderator`);
      }

      if (vp !== "desktop") {
        run.skip(vp, "decision (publish or reject)", cfg.target === "live"
          ? "the decision runs once per run, on desktop, and only when UAT_T4_ACTION is set"
          : "the decision runs once per run, on desktop, so the demo queue changes once");
      } else if (action === null) {
        run.skip(vp, "decision (publish or reject)", "read-only: UAT_T4_ACTION is not set, so no proposal is changed");
      } else if (action === "reject") {
        await run.step(page, vp, "reject the proposal with 'Tolak'", async () => {
          await page.getByRole("button", { name: "Tolak", exact: true }).click();
          const banner = page.locator(".feedback-banner").first();
          await banner.waitFor({ state: "visible" });
          if (((await banner.getAttribute("class")) ?? "").includes("feedback-banner--error")) {
            throw new Error("the moderation feedback banner reports an error");
          }
        });
      } else {
        await run.step(page, vp, "publish: 'Setujui & Terbitkan', then 'Konfirmasi & Terbitkan'", async () => {
          await page.getByRole("button", { name: "Setujui & Terbitkan", exact: true }).click();
          await page.getByRole("heading", { name: "Setujui & Terbitkan Proposal", exact: true }).waitFor({ state: "visible" });
          await page.getByRole("button", { name: "Konfirmasi & Terbitkan", exact: true }).click();
          const banner = page.locator(".feedback-banner").first();
          await banner.waitFor({ state: "visible" });
          if (((await banner.getAttribute("class")) ?? "").includes("feedback-banner--error")) {
            throw new Error("the moderation feedback banner reports an error");
          }
        });
      }
    } else {
      for (const name of [
        "select the first proposal and read its identity section",
        "decision controls 'Setujui & Terbitkan' and 'Tolak' are visible",
        "decision (publish or reject)",
      ]) {
        run.skip(vp, name, "no proposal awaiting review yet");
      }
    }

    await run.step(page, vp, "time limit (proposed): review and decision within 300 s", async () => {
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
  const action = resolveAction(target);
  mkdirSync(outDir, { recursive: true });
  const run = new UatRun(outDir);
  const startedAt = new Date().toISOString();
  run.note(actionNote(cfg, action));
  if (cfg.account === "administrator") {
    run.note("No moderator account is configured for live mode (UAT_MODERATOR_USERNAME is unset; the hosted bootstrap creates none). Signed in as the administrator account.");
  }

  if (await assertDataset(run, cfg)) {
    if (target === "live" && action === "publish") {
      console.warn("WARNING: UAT_T4_ACTION=publish. The first proposal in the live moderation queue will be approved and published. A real proposal will change, and the public site will change.");
    } else if (target === "live" && action === "reject") {
      console.warn("WARNING: UAT_T4_ACTION=reject. The first proposal in the live moderation queue will be rejected. A real proposal will change.");
    }
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      for (const viewport of VIEWPORTS) {
        try {
          await runViewport(browser, viewport, action, run, cfg);
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
