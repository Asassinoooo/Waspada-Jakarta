/**
 * GUI-04: screenshots of the admin workspace from the offline harness. Synthetic data only: a fresh PGlite database,
 * one seeded synthetic admin account, the Worker fetch handler in-process. Never point this at hosted data.
 *
 *   npm run build:web && GUI_OUT=<dir> node --import tsx tools/gui/admin-shots.ts
 */
import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright";
import { REVIEW_CHUNKS, REVIEW_PROPOSALS } from "./review-fixtures.js";
import { seedRssSources } from "../live-sources-seed.js";
import { createTestDatabase } from "../../apps/db/test/harness.js";
import { applyMigrations, readMigrations } from "../../apps/db/src/migrations.js";
import { createAccountStore } from "../../apps/db/src/accounts.js";
import { hashPassword } from "../../apps/worker/src/accounts/password.js";
import { generateServiceKey } from "../../apps/worker/src/security/service-key.js";
import type { WorkerEnvironment } from "../../apps/worker/src/layers/l4-application-integration/api.js";
import { startUnifiedServer } from "../e2e/harness.js";

const OUT = path.resolve(process.env.GUI_OUT ?? "tools/gui/out/admin");
const DIST = path.resolve("apps/web/dist");
const USERNAME = "gui.admin";
const PASSWORD = `gui-${generateServiceKey().slice(0, 16)}`;
const TABS = (process.env.GUI_TABS ?? "ringkasan,tinjau,alur,sumber,akun").split(",");
const VIEWPORTS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "390", width: 390, height: 844 },
];
const SCHEMES = (process.env.GUI_SCHEMES ?? "light,dark").split(",") as Array<"light" | "dark">;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const db = await createTestDatabase();
  await applyMigrations(db.executor, await readMigrations(new URL("../../apps/db/migrations/", import.meta.url)));
  await createAccountStore(db.executor, "demo").createPasswordAccount({
    datasetMode: "demo",
    username: USERNAME,
    passwordHash: await hashPassword(PASSWORD),
    displayName: "Admin GUI (sintetis)",
    role: "admin",
    now: new Date().toISOString(),
    reason: "Synthetic GUI screenshot fixture",
  });
  // GUI_RICH=1: more synthetic accounts and the 14 RSS sources with mixed health and approval, so the Akun and Sumber
  // tabs show their real shape. All names are fictitious; nothing comes from a live database.
  if (process.env.GUI_RICH === "1") {
    const store = createAccountStore(db.executor, "demo");
    const people: Array<[string, string, "user" | "moderator" | "admin"]> = [
      ["sari.moderator", "Sari Wulandari (sintetis)", "moderator"],
      ["budi.moderator", "Budi Santoso (sintetis)", "moderator"],
      ["dewi.admin", "Dewi Lestari (sintetis)", "admin"],
      ["rina.pengguna", "Rina Kusuma (sintetis)", "user"],
      ["agus.pengguna", "Agus Pratama (sintetis)", "user"],
      ["lama.pengguna", "Tono Hidayat (sintetis)", "user"],
    ];
    for (const [username, displayName, role] of people) {
      await store.createPasswordAccount({ datasetMode: "demo", username, passwordHash: await hashPassword(`gui-${generateServiceKey().slice(0, 12)}`), displayName, role, now: new Date().toISOString(), reason: "Synthetic GUI screenshot fixture" });
    }
    await db.executor.query("UPDATE waspada.accounts SET active = false WHERE display_name = 'Tono Hidayat (sintetis)'");
    await seedRssSources(db.executor);
    await db.executor.query(`UPDATE waspada.source_registry SET last_checked_at = now() - interval '9 minutes', last_success_at = now() - interval '9 minutes' WHERE access_method = 'rss'`);
    const ids = (await db.executor.query<{ source_id: string }>("SELECT source_id FROM waspada.source_registry WHERE access_method = 'rss' ORDER BY source_id")).rows.map((row) => row.source_id);
    if (ids[1]) await db.executor.query("UPDATE waspada.source_registry SET health_status = 'degraded', last_success_at = now() - interval '3 hours' WHERE source_id = $1", [ids[1]]);
    if (ids[4]) await db.executor.query("UPDATE waspada.source_registry SET approval_status = 'revoked', auto_publication_policy = 'never' WHERE source_id = $1", [ids[4]]);
    if (ids[7]) await db.executor.query("UPDATE waspada.source_registry SET health_status = 'unknown', last_checked_at = NULL, last_success_at = NULL, approval_status = 'pending' WHERE source_id = $1", [ids[7]]);
  }
  const env: WorkerEnvironment = {
    DATASET_MODE: "synthetic",
    AUTH_ENABLED: "true",
    AUTH_APP_ORIGIN: "http://127.0.0.1:0",
    INTERNAL_SERVICE_KEY: generateServiceKey(),
    WEBHOOK_SERVICE_KEY: generateServiceKey(),
    SQL_EXECUTOR: db.executor,
  };
  const server = await startUnifiedServer({ distDir: DIST, env });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    for (const viewport of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: scheme });
        await context.addInitScript(() => { try { localStorage.setItem("waspada-jakarta:intro:v1", "done"); } catch { /* ignore */ } });
        const login = await context.request.post(`${server.baseUrl}/api/v1/auth/login`, {
          headers: { Origin: server.baseUrl, "X-Waspada-Request": "1" },
          data: { username: USERNAME, password: PASSWORD },
        });
        if (login.status() !== 200) throw new Error(`login ${login.status()}`);
        // GUI_REVIEW_FIXTURE=1: the review queue shows synthetic proposals (tools/gui/review-fixtures.ts) instead of an empty queue.
        if (process.env.GUI_REVIEW_FIXTURE === "1") {
          await context.route("**/api/v1/moderation/proposals", (route) => route.fulfill({ json: { proposals: REVIEW_PROPOSALS } }));
          await context.route("**/api/v1/moderation/proposals/*", (route) => {
            const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
            const proposal = REVIEW_PROPOSALS.find((item) => item.proposal_id === id);
            return proposal ? route.fulfill({ json: { proposal, chunks: REVIEW_CHUNKS[id] ?? [] } }) : route.fallback();
          });
        }
        for (const tab of TABS) {
          const page = await context.newPage();
          await page.goto(`${server.baseUrl}/#admin/${tab}`, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
          await page.waitForTimeout(1_200);
          // GUI_CLICK="Kelola": opens the second matching control before the capture (e.g. one account editor).
          if (process.env.GUI_CLICK) {
            await page.getByRole("button", { name: process.env.GUI_CLICK, exact: true }).nth(1).click().catch(() => undefined);
            await page.waitForTimeout(400);
          }
          if (process.env.GUI_PROBE) console.log("probe", JSON.stringify(await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => { const cs = getComputedStyle(el); return [el.className, cs.display, cs.gridTemplateColumns, cs.gridColumn, el.getBoundingClientRect().width | 0]; }), process.env.GUI_PROBE)));
          const file = path.join(OUT, `admin-${tab}-${viewport.label}-${scheme}.png`);
          await page.screenshot({ path: file, fullPage: true });
          console.log(`ok ${path.basename(file)}`);
          await page.close();
        }
        for (const hash of ["#masuk"]) {
          const anon = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: scheme });
          const page = await anon.newPage();
          await page.goto(`${server.baseUrl}/${hash}`, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(1_500);
          await page.screenshot({ path: path.join(OUT, `masuk-${viewport.label}-${scheme}.png`), fullPage: true });
          await anon.close();
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().then(() => process.exit(0), (error: unknown) => { console.error(error); process.exit(1); });
