/**
 * A11Y-01: axe accessibility audit of the public pages, plus a keyboard pass on the map home.
 *
 * Runs offline, like the browser journey: PGlite, the Worker fetch handler and the built web app on one loopback
 * server, and headless Chromium. Writes tools/e2e/out/a11y-report.json and a11y-report.md.
 *
 * Exit code 1 when any axe violation with impact serious or critical is found, or when the keyboard pass fails.
 * Set A11Y_REPORT_ONLY=1 to write the report and exit 0 regardless of findings.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createTestDatabase } from "../../apps/db/test/harness.js";
import { applyMigrations, readMigrations } from "../../apps/db/src/migrations.js";
import type { WorkerEnvironment } from "../../apps/worker/src/layers/l4-application-integration/api.js";
import { generateServiceKey } from "../../apps/worker/src/security/service-key.js";
import { startUnifiedServer } from "./harness.js";

const requireFromHere = createRequire(import.meta.url);

type Impact = "critical" | "serious" | "moderate" | "minor";
type ColorScheme = "light" | "dark";

interface AuditPage {
  readonly id: string;
  readonly hash: string;
}

interface Viewport {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

interface ViolationSummary {
  readonly id: string;
  readonly impact: Impact | null;
  readonly help: string;
  readonly helpUrl: string;
  readonly nodeCount: number;
  /** First targets only, enough to find the element. */
  readonly targets: string[];
}

interface AuditRow {
  readonly page: string;
  readonly hash: string;
  readonly viewport: string;
  readonly scheme: ColorScheme;
  readonly counts: Record<Impact, number>;
  readonly violations: ViolationSummary[];
}

interface SkippedRoute {
  readonly page: string;
  readonly hash: string;
  readonly viewport: string;
  readonly scheme: ColorScheme;
  readonly reason: string;
}

interface FocusSnapshot {
  readonly isBody: boolean;
  readonly tag: string;
  readonly name: string;
  readonly id: string;
  readonly href: string | null;
  readonly focusIndicator: boolean;
}

interface KeyboardStep extends FocusSnapshot {
  readonly n: number;
}

interface KeyboardReport {
  readonly page: string;
  readonly viewport: string;
  readonly scheme: ColorScheme;
  readonly steps: KeyboardStep[];
  readonly skipLinkFocused: boolean;
  readonly skipTargetFocused: boolean;
  readonly failures: string[];
  readonly passed: boolean;
}

/**
 * Public pages to audit. The registration form lives on #masuk (PasswordLogin renders RegisterForm when
 * registration is available), so there is no separate register route. #mulai is the onboarding route.
 * A hash that is not a route falls back to the map home (#peta). Such a route is skipped with a "skipped" log line
 * and a skipped entry in the report, and is audited automatically once its route exists.
 */
const PAGES: readonly AuditPage[] = [
  { id: "peta", hash: "#peta" },
  { id: "pembaruan", hash: "#pembaruan" },
  { id: "ringkasan-saya", hash: "#ringkasan-saya" },
  { id: "bantuan", hash: "#bantuan" },
  { id: "privasi", hash: "#privasi" },
  { id: "masuk", hash: "#masuk" },
  { id: "mulai", hash: "#mulai" },
  { id: "lupa-sandi", hash: "#lupa-sandi" },
];

/** The map home. Used as the fallback baseline and for the keyboard pass. */
const MAP_HASH = "#peta";

const MOBILE_VIEWPORT: Viewport = { label: "390x844", width: 390, height: 844 };
const DESKTOP_VIEWPORT: Viewport = { label: "1440x900", width: 1440, height: 900 };
const VIEWPORTS: readonly Viewport[] = [MOBILE_VIEWPORT, DESKTOP_VIEWPORT];
const SCHEMES: readonly ColorScheme[] = ["light", "dark"];
const WCAG_TAGS: readonly string[] = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const GATING_IMPACTS: readonly Impact[] = ["critical", "serious"];
const IMPACT_ORDER: readonly Impact[] = ["critical", "serious", "moderate", "minor"];
const MAX_TARGETS = 10;
const TAB_STEPS = 12;
const NETWORK_IDLE_TIMEOUT_MS = 15_000;
const SETTLE_MS = 800;
/** Same key the web app reads in OnboardingIntro.tsx. "done" keeps the intro from opening over the page. */
const INTRO_STORAGE_KEY = "waspada-jakarta:intro:v1";

const OUT_DIR = path.resolve(process.cwd(), "tools/e2e/out");
const DIST_DIR = path.resolve(process.cwd(), "apps/web/dist");

function buildWebApp(): void {
  const result = spawnSync("npm", ["run", "build:web"], { stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error("npm run build:web failed; the audit needs apps/web/dist");
}

async function markIntroDone(context: BrowserContext): Promise<void> {
  await context.addInitScript((storageKey: string) => {
    try {
      window.localStorage.setItem(storageKey, "done");
    } catch {
      // Storage blocked: the intro may open, and the audit still runs.
    }
  }, INTRO_STORAGE_KEY);
}

async function openPage(page: Page, baseUrl: string, hash: string): Promise<void> {
  await page.goto(`${baseUrl}/${hash}`, { waitUntil: "domcontentloaded" });
  // The app polls, so network idle may never settle. Fall back to the settle delay in that case.
  await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {
    console.log(`    networkidle not reached for ${hash}; continuing after load`);
  });
  await page.waitForTimeout(SETTLE_MS);
}

/** Text of the main region. A route that falls back to the map home renders the same text as #peta. */
async function mainSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.getElementById("main-content");
    if (!main) return "";
    return `${main.tagName}.${main.getAttribute("class") ?? ""}|${(main.textContent ?? "").replace(/\s+/g, " ").trim()}`;
  });
}

async function runAxe(page: Page, axeSource: string): Promise<ViolationSummary[]> {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(
    async ([tags, maxTargets]: [string[], number]) => {
      interface RawNode {
        target: Array<string | string[]>;
      }
      interface RawViolation {
        id: string;
        impact?: string | null;
        help: string;
        helpUrl: string;
        nodes: RawNode[];
      }
      const axe = (window as unknown as {
        axe: { run(context: Document, options: object): Promise<{ violations: RawViolation[] }> };
      }).axe;
      const results = await axe.run(document, { runOnly: { type: "tag", values: tags } });
      return results.violations.map((violation) => ({
        id: violation.id,
        impact: (violation.impact ?? null) as Impact | null,
        help: violation.help,
        helpUrl: violation.helpUrl,
        nodeCount: violation.nodes.length,
        targets: violation.nodes
          .slice(0, maxTargets)
          .map((node) => node.target.map((part) => (Array.isArray(part) ? part.join(" >> ") : String(part))).join(" ")),
      }));
    },
    [[...WCAG_TAGS], MAX_TARGETS] as [string[], number],
  );
}

/** Counts axe rules violated per impact. Affected elements are listed per violation in the report. */
function countByImpact(violations: readonly ViolationSummary[]): Record<Impact, number> {
  const counts = emptyCounts();
  for (const violation of violations) {
    if (violation.impact === null) continue;
    counts[violation.impact] += 1;
  }
  return counts;
}

function emptyCounts(): Record<Impact, number> {
  return { critical: 0, serious: 0, moderate: 0, minor: 0 };
}

async function readFocus(page: Page): Promise<FocusSnapshot> {
  return page.evaluate((): FocusSnapshot => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) {
      return { isBody: true, tag: "body", name: "", id: "", href: null, focusIndicator: false };
    }
    const style = getComputedStyle(el);
    const label = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || el.getAttribute("placeholder") || el.getAttribute("value") || "";
    return {
      isBody: false,
      tag: el.tagName.toLowerCase(),
      name: label.replace(/\s+/g, " ").trim().slice(0, 80),
      id: el.id,
      href: el.getAttribute("href"),
      focusIndicator: style.outlineStyle !== "none" || style.boxShadow !== "none",
    };
  });
}

async function runKeyboardPass(browser: Browser, baseUrl: string): Promise<KeyboardReport> {
  const viewport = DESKTOP_VIEWPORT;
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: "light" });
  await markIntroDone(context);
  const failures: string[] = [];
  try {
    // Pass 1: twelve Tab presses from a fresh load. Each focused element needs a visible focus indicator.
    const tabPage = await context.newPage();
    await openPage(tabPage, baseUrl, MAP_HASH);
    const steps: KeyboardStep[] = [];
    for (let n = 1; n <= TAB_STEPS; n += 1) {
      await tabPage.keyboard.press("Tab");
      const snapshot = await readFocus(tabPage);
      steps.push({ n, ...snapshot });
      if (snapshot.isBody) {
        failures.push(`Tab ${n}: focus is on body, so no element received focus.`);
      } else if (!snapshot.focusIndicator) {
        failures.push(`Tab ${n}: <${snapshot.tag}> "${snapshot.name}" has no visible focus indicator (outline-style and box-shadow are both none).`);
      }
    }
    await tabPage.close();

    const first = steps[0];
    const skipLinkFocused = first !== undefined && first.tag === "a" && first.href === "#main-content";
    if (!skipLinkFocused) {
      failures.push(`The first Tab did not focus the skip link (got <${first?.tag ?? "none"}> "${first?.name ?? ""}").`);
    }

    // Pass 2: a fresh load, Tab to the skip link, Enter, then focus must be on #main-content.
    const skipPage = await context.newPage();
    await openPage(skipPage, baseUrl, MAP_HASH);
    await skipPage.keyboard.press("Tab");
    await skipPage.keyboard.press("Enter");
    const activeId = await skipPage.evaluate(() => document.activeElement?.id ?? "");
    const skipTargetFocused = activeId === "main-content";
    if (!skipTargetFocused) {
      failures.push(`Enter on the skip link did not move focus to #main-content (active id: "${activeId}").`);
    }
    await skipPage.close();

    return {
      page: MAP_HASH,
      viewport: viewport.label,
      scheme: "light",
      steps,
      skipLinkFocused,
      skipTargetFocused,
      failures,
      passed: failures.length === 0,
    };
  } finally {
    await context.close();
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderMarkdown(report: {
  generatedAt: string;
  axeCoreVersion: string;
  reportOnly: boolean;
  gateFailed: boolean;
  rows: AuditRow[];
  skipped: SkippedRoute[];
  keyboard: KeyboardReport;
}): string {
  const lines: string[] = [];
  lines.push("# Accessibility audit (A11Y-01)");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- axe-core ${report.axeCoreVersion}, tags: ${WCAG_TAGS.join(", ")}`);
  lines.push(`- Gate: serious or critical violations, and keyboard failures. ${report.reportOnly ? "Report-only run (A11Y_REPORT_ONLY=1)." : "Gating run."}`);
  lines.push(`- Result: ${report.gateFailed ? "FAIL" : "PASS"}`);
  lines.push("");

  lines.push("## Skipped routes");
  lines.push("");
  if (report.skipped.length === 0) {
    lines.push("None.");
  } else {
    const byHash = new Map<string, SkippedRoute[]>();
    for (const item of report.skipped) byHash.set(item.hash, [...(byHash.get(item.hash) ?? []), item]);
    for (const [hash, items] of byHash) {
      lines.push(`- \`${hash}\`: ${items[0]?.reason ?? "skipped"} (${items.length} combinations)`);
    }
  }
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("Counts are axe rules violated per impact. The violations section lists affected elements.");
  lines.push("");
  lines.push("| page | viewport | scheme | serious | critical | moderate | minor |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const row of report.rows) {
    lines.push(`| ${row.page} | ${row.viewport} | ${row.scheme} | ${row.counts.serious} | ${row.counts.critical} | ${row.counts.moderate} | ${row.counts.minor} |`);
  }
  lines.push("");

  lines.push("## Violations");
  lines.push("");
  for (const row of report.rows) {
    if (row.violations.length === 0) continue;
    lines.push(`### ${row.page} · ${row.viewport} · ${row.scheme}`);
    lines.push("");
    for (const violation of row.violations) {
      lines.push(`- \`${violation.id}\` (${violation.impact ?? "unrated"}, ${violation.nodeCount} element${violation.nodeCount === 1 ? "" : "s"}): ${violation.help}. ${violation.helpUrl}`);
      for (const target of violation.targets.slice(0, 3)) {
        lines.push(`  - target: \`${target.replace(/`/g, "")}\``);
      }
    }
    lines.push("");
  }
  if (report.rows.every((row) => row.violations.length === 0)) {
    lines.push("No axe violations in the audited combinations.");
    lines.push("");
  }

  lines.push(`## Keyboard pass (${report.keyboard.page}, ${report.keyboard.viewport}, ${report.keyboard.scheme})`);
  lines.push("");
  lines.push(`- Result: ${report.keyboard.passed ? "PASS" : "FAIL"}`);
  lines.push(`- First Tab on skip link: ${report.keyboard.skipLinkFocused ? "yes" : "no"}`);
  lines.push(`- Enter on skip link moved focus to #main-content: ${report.keyboard.skipTargetFocused ? "yes" : "no"}`);
  lines.push("");
  lines.push("| Tab | tag | name | focus indicator |");
  lines.push("|---|---|---|---|");
  for (const step of report.keyboard.steps) {
    lines.push(`| ${step.n} | ${escapeCell(step.isBody ? "body" : step.tag)} | ${escapeCell(step.name)} | ${step.focusIndicator ? "yes" : "no"} |`);
  }
  if (report.keyboard.failures.length > 0) {
    lines.push("");
    for (const failure of report.keyboard.failures) lines.push(`- ${failure}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const reportOnly = process.env.A11Y_REPORT_ONLY === "1";
  console.log("==================================================================");
  console.log("  Waspada Jakarta: accessibility audit (axe-core, WCAG 2.x A/AA)");
  console.log("==================================================================");

  console.log("\n[Build] Building the web app for the audit (npm run build:web)...");
  buildWebApp();

  const axeModule = requireFromHere("axe-core") as { source: string; version: string };
  const axeCoreVersion = axeModule.version;

  console.log("\n[Setup] Initializing PostgreSQL test instance and applying migrations...");
  const db = await createTestDatabase();
  const migrations = await readMigrations(new URL("../../apps/db/migrations/", import.meta.url));
  await applyMigrations(db.executor, migrations);

  const env: WorkerEnvironment = {
    DATASET_MODE: "synthetic",
    AUTH_ENABLED: "true",
    AUTH_APP_ORIGIN: "http://127.0.0.1:0",
    INTERNAL_SERVICE_KEY: generateServiceKey(),
    WEBHOOK_SERVICE_KEY: generateServiceKey(),
    SQL_EXECUTOR: db.executor,
  };
  const server = await startUnifiedServer({ distDir: DIST_DIR, env });
  console.log(`  Unified server running on ${server.baseUrl}`);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const rows: AuditRow[] = [];
    const skipped: SkippedRoute[] = [];

    for (const viewport of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        const label = `${viewport.label} ${scheme}`;
        console.log(`\n[Audit] ${label}`);
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
        });
        await markIntroDone(context);
        try {
          const baselinePage = await context.newPage();
          await openPage(baselinePage, server.baseUrl, MAP_HASH);
          const baseline = await mainSignature(baselinePage);
          await baselinePage.close();

          for (const auditPage of PAGES) {
            const page = await context.newPage();
            try {
              await openPage(page, server.baseUrl, auditPage.hash);
              const signature = await mainSignature(page);
              if (auditPage.hash !== MAP_HASH && signature !== "" && signature === baseline) {
                const reason = "not a route; falls back to the map home (#peta)";
                console.log(`  skipped ${auditPage.hash} (${label}): ${reason}`);
                skipped.push({ page: auditPage.id, hash: auditPage.hash, viewport: viewport.label, scheme, reason });
                continue;
              }
              const violations = await runAxe(page, axeModule.source);
              const counts = countByImpact(violations);
              rows.push({ page: auditPage.id, hash: auditPage.hash, viewport: viewport.label, scheme, counts, violations });
              console.log(
                `  ${auditPage.hash.padEnd(16)} serious=${counts.serious} critical=${counts.critical} moderate=${counts.moderate} minor=${counts.minor}`,
              );
            } finally {
              await page.close();
            }
          }
        } finally {
          await context.close();
        }
      }
    }

    console.log("\n[Keyboard] #peta at 1440x900, light: Tab x12, then skip link + Enter...");
    const keyboard = await runKeyboardPass(browser, server.baseUrl);
    console.log(`  ${keyboard.passed ? "PASS" : "FAIL"}: ${keyboard.steps.map((step) => (step.isBody ? "body" : step.tag)).join(" > ")}`);
    for (const failure of keyboard.failures) console.log(`  - ${failure}`);

    const blocking = rows.flatMap((row) =>
      row.violations
        .filter((violation) => violation.impact !== null && GATING_IMPACTS.includes(violation.impact))
        .map((violation) => ({ row, violation })),
    );
    const gateFailed = blocking.length > 0 || !keyboard.passed;

    const report = {
      generatedAt: new Date().toISOString(),
      axeCoreVersion,
      wcagTags: [...WCAG_TAGS],
      gatingImpacts: [...GATING_IMPACTS],
      reportOnly,
      gateFailed,
      rows,
      skipped,
      keyboard,
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "a11y-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(OUT_DIR, "a11y-report.md"), renderMarkdown(report));
    console.log(`\n[Report] ${path.join(OUT_DIR, "a11y-report.json")}`);
    console.log(`[Report] ${path.join(OUT_DIR, "a11y-report.md")}`);

    const totals = emptyCounts();
    for (const row of rows) {
      for (const impact of IMPACT_ORDER) totals[impact] += row.counts[impact];
    }
    console.log(`\nTotals across ${rows.length} audited combinations: critical=${totals.critical} serious=${totals.serious} moderate=${totals.moderate} minor=${totals.minor}`);
    console.log(`Gate: ${gateFailed ? "FAIL" : "PASS"}${reportOnly ? " (report-only, exit 0)" : ""}`);
    process.exitCode = gateFailed && !reportOnly ? 1 : 0;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    server.close();
    await db.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("\n[A11y audit FAILED]:", err);
  process.exit(1);
});
