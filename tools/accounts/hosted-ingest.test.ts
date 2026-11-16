// HOSTED-03: pure checks for headless live ingest. Fake registry, fake SQL and fake clients only. No network.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Client } from "pg";
import type { AccountStore } from "../../apps/db/src/accounts.js";
import type { SqlExecutor } from "../../apps/db/src/sql.js";
import { BLOCKED_REDIRECT_ERROR } from "../../apps/worker/src/runtime/outbound-fetch-policy.js";
import {
  checkLiveSourceCoverage,
  expectedLiveSourceIds,
  formatCoverageFailure,
  formatCoverageSkips,
  formatNotFetchedLine,
  formatSourceHealthLine,
  rssFeedHealthEntry,
  shouldPollFeed,
  structuredHealthEntry,
  type RegistryRow,
} from "../live-source-coverage.js";
import { seedLiveSourcesInsertMissing, seedRssSources } from "../live-sources-seed.js";
import {
  buildHostedClientConfig,
  createHostedSession,
  HostedConfigError,
  type SessionClient,
} from "../hosted/hosted-session.js";
import { diffLayerRoles, LAYER_ROLES, planModeratorSeed, seedModeratorAccount } from "../hosted/neon-bootstrap.js";
import { roleCreationsIn } from "../hosted/layer-roles.js";
import {
  DEFAULT_INGEST_TIME_BUDGET_MINUTES,
  drainAiJobs,
  drainDeadlineMs,
  hasClaimableAiJob,
  isTimeBudgetExhausted,
  parseRunFlags,
  resolveIngestTimeBudget,
} from "../hosted/ingest-once.js";

const READY_ROWS: RegistryRow[] = expectedLiveSourceIds().map((id) => ({
  source_id: id,
  approval_status: "approved",
  registry_status: "active",
  auto_acquisition_enabled: true,
}));
const POLL_SET = expectedLiveSourceIds();

describe("coverage guard (owner decision, 16 Nov)", () => {
  it("accepts all 16 sources when each is approved, active and auto-acquisition enabled", () => {
    assert.equal(expectedLiveSourceIds().length, 16);
    const report = checkLiveSourceCoverage({ expectedIds: POLL_SET, pollSetIds: POLL_SET, rows: READY_ROWS });
    assert.equal(report.ok, true);
    assert.deepEqual(formatCoverageSkips(report), []);
  });

  it("does not refuse a revoked source: it is logged as skipped and the others stay ready", () => {
    const rows = READY_ROWS.map((row) => row.source_id === "petabencana"
      ? { ...row, approval_status: "revoked", auto_acquisition_enabled: false }
      : row);
    const report = checkLiveSourceCoverage({ expectedIds: POLL_SET, pollSetIds: POLL_SET, rows });
    assert.equal(report.ok, true);
    assert.deepEqual(formatCoverageSkips(report), ["revoked: petabencana, skipped"]);
    assert.doesNotMatch(formatCoverageSkips(report).join("\n"), /https?:|:\/\//u);
  });

  it("refuses only when a source row is missing, and names it without any URL", () => {
    const rows = READY_ROWS.filter((row) => row.source_id !== "source-bmkg-gempa");
    const report = checkLiveSourceCoverage({ expectedIds: POLL_SET, pollSetIds: POLL_SET, rows });
    assert.equal(report.ok, false);
    assert.deepEqual(report.missing, ["source-bmkg-gempa"]);
    const text = formatCoverageFailure(report).join("\n");
    assert.match(text, /missing from source_registry: source-bmkg-gempa/u);
    assert.doesNotMatch(text, /https?:|:\/\//u);
  });

  it("refuses a poll-set drift", () => {
    const report = checkLiveSourceCoverage({
      expectedIds: POLL_SET,
      pollSetIds: POLL_SET.filter((id) => id !== "source-tempo-nasional"),
      rows: READY_ROWS,
    });
    assert.deepEqual(report.notPolled, ["source-tempo-nasional"]);
    assert.equal(report.ok, false);
  });
});

describe("per-cycle fetch decision", () => {
  const row = (overrides: Partial<RegistryRow>): RegistryRow => ({ ...READY_ROWS[0]!, ...overrides });

  it("polls only an approved, auto-acquisition-enabled row", () => {
    assert.equal(shouldPollFeed(row({})), true);
  });

  it("does not poll a revoked, suspended, pending or disabled row, or a missing one", () => {
    assert.equal(shouldPollFeed(row({ approval_status: "revoked", auto_acquisition_enabled: false })), false);
    assert.equal(shouldPollFeed(row({ approval_status: "suspended", auto_acquisition_enabled: false })), false);
    assert.equal(shouldPollFeed(row({ approval_status: "pending", auto_acquisition_enabled: false })), false);
    assert.equal(shouldPollFeed(row({ auto_acquisition_enabled: false })), false);
    assert.equal(shouldPollFeed(undefined), false);
  });

  it("prints the not-fetched line with a count and ids only", () => {
    assert.equal(formatNotFetchedLine([]), "  [Source Health] revoked_or_disabled_not_fetched count=0 source_ids=none");
    assert.equal(
      formatNotFetchedLine(["source-cnn-utama", "source-tempo-nasional"]),
      "  [Source Health] revoked_or_disabled_not_fetched count=2 source_ids=source-cnn-utama,source-tempo-nasional",
    );
  });
});

describe("per-source health line", () => {
  it("prints counts and an error class only, and never a URL", () => {
    const line = formatSourceHealthLine(rssFeedHealthEntry({
      sourceId: "source-antara-metro",
      status: "success",
      totalParsed: 20,
      admitted: 3,
      cycleDuplicates: 1,
      triage: {
        total: 20, ingested: 3, dropped: 5, uncertain: 1, authzRejected: 0, geoRejected: 0, nonActionable: 0,
        providerFailures: 0, rateLimited: 0, rateLimitDeferred: 0, duplicate: 2, budgetDeferred: 0, byCategory: {},
        detConsidered: 0, detCandidate: 0, detAmbiguous: 0, detLowSignal: 0, detBroadOnly: 0, detSpecific: 0,
        detStrong: 0, detSupporting: 0, detAlertOnly: 0, detNonScene: 0, detUnknownRole: 0, detModelCallsSkipped: 0,
        detRuleVersion: "", detGazetteerVersion: "", detLexiconVersion: "",
      },
    }));
    assert.equal(
      line,
      "  [Source Health] source-antara-metro fetched=20 new=3 deduped=3 triage_accepted=3 triage_rejected=5 source_not_cleared=0 blocked_fetch=0 error=none",
    );
  });

  it("classifies a blocked redirect and a timed-out poll without printing their text", () => {
    const blocked = formatSourceHealthLine(rssFeedHealthEntry({
      sourceId: "source-cnn-utama", status: "fetch_error", error: BLOCKED_REDIRECT_ERROR, totalParsed: 0, admitted: 0, cycleDuplicates: 0,
    }));
    assert.match(blocked, /blocked_fetch=1 error=blocked_redirect/u);

    const timedOut = formatSourceHealthLine(structuredHealthEntry({
      sourceId: "petabencana", outcome: "error", fetched: 0, revisions: 0,
      error: "Request timed out after 20000ms for https://api.example.invalid/reports",
    }, 0));
    assert.match(timedOut, /error=timeout/u);
    assert.doesNotMatch(timedOut, /https?:|example\.invalid/u);
  });
});

describe("layer role list", () => {
  it("matches every CREATE ROLE waspada_ statement in the migrations, and diffs both ways", () => {
    const dir = fileURLToPath(new URL("../../apps/db/migrations/", import.meta.url));
    const created = new Set<string>();
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".sql"))) {
      for (const role of roleCreationsIn(fs.readFileSync(`${dir}/${file}`, "utf8"))) created.add(role);
    }
    assert.deepEqual([...created].sort(), [...LAYER_ROLES].sort());

    const diff = diffLayerRoles(LAYER_ROLES, LAYER_ROLES.slice(1).concat("waspada_extra_role"));
    assert.deepEqual(diff.missing, [LAYER_ROLES[0]]);
    assert.deepEqual(diff.unexpected, ["waspada_extra_role"]);
  });
});

describe("hosted connection settings", () => {
  it("strips sslmode and forces verified TLS, which node-postgres then honours", () => {
    const config = buildHostedClientConfig("postgresql://u:p@example.invalid/db?sslmode=require");
    assert.doesNotMatch(config.connectionString, /sslmode/u);
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
    // connectionParameters is internal to node-postgres and not in @types/pg. Reading it here checks what the client will use.
    const client = new Client({ ...config }) as unknown as { readonly connectionParameters: { readonly ssl: unknown } };
    assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: true });
  });

  it("refuses sslmode=disable, a pooled endpoint and an invalid URL, with a code and no URL text", () => {
    for (const [url, code] of [
      ["postgresql://u:secret@example.invalid/db?sslmode=disable", "neon_sslmode_refused"],
      ["postgresql://u:secret@ep-cool-name-pooler.example.invalid/db?sslmode=require", "neon_pooler_refused"],
      ["not a url at all", "neon_url_invalid"],
    ] as const) {
      try {
        buildHostedClientConfig(url);
        assert.fail("expected a refusal");
      } catch (error) {
        assert.ok(error instanceof HostedConfigError);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /secret|example\.invalid|cool-name|not a url/u);
      }
    }
  });
});

interface FakeClient extends SessionClient {
  readonly statements: string[];
  fireError(error: Error): void;
  fireNotice(code: string): void;
  failNext(error: Error): void;
}

function fakeFactory(): { create: (config: unknown) => FakeClient; clients: FakeClient[] } {
  const clients: FakeClient[] = [];
  const create = (): FakeClient => {
    const listeners = new Map<string, (value: unknown) => void>();
    let pendingFailure: Error | undefined;
    const statements: string[] = [];
    const client: FakeClient = {
      statements,
      connect: async () => undefined,
      query: async (text: string) => {
        statements.push(text);
        if (pendingFailure !== undefined) {
          const failure = pendingFailure;
          pendingFailure = undefined;
          throw failure;
        }
        return { rows: [] };
      },
      end: async () => undefined,
      on: (event, listener) => {
        listeners.set(event, listener);
        return client;
      },
      fireError: (error) => listeners.get("error")?.(error),
      fireNotice: (code) => listeners.get("notice")?.({ code }),
      failNext: (error) => {
        pendingFailure = error;
      },
    };
    clients.push(client);
    return client;
  };
  return { create, clients };
}

describe("hosted session", () => {
  it("runs a transaction on one client and rolls back when the work throws", async () => {
    const factory = fakeFactory();
    const session = createHostedSession({
      connectionString: "postgresql://u:p@example.invalid/db?sslmode=require",
      createClient: (config) => factory.create(config),
    });
    await session.executor.transaction(async (tx) => {
      await tx.query("SELECT 1");
    });
    await assert.rejects(session.executor.transaction(async () => {
      throw new Error("boom");
    }));
    assert.equal(factory.clients.length, 1);
    assert.deepEqual(factory.clients[0]!.statements, ["BEGIN", "SELECT 1", "COMMIT", "BEGIN", "ROLLBACK"]);
    await session.close();
  });

  it("does not send ROLLBACK on a connection that already dropped, and fails statements inside it", async () => {
    const factory = fakeFactory();
    const session = createHostedSession({
      connectionString: "postgresql://u:p@example.invalid/db?sslmode=require",
      createClient: (config) => factory.create(config),
    });
    await assert.rejects(session.executor.transaction(async (tx) => {
      factory.clients[0]!.fireError(Object.assign(new Error("terminated"), { code: "57P01" }));
      await tx.query("SELECT 2");
    }));
    assert.deepEqual(factory.clients[0]!.statements, ["BEGIN"]);
    await session.close();
  });

  it("reconnects on the next call after the connection ends, without throwing from the error event", async () => {
    const factory = fakeFactory();
    const logs: string[] = [];
    const session = createHostedSession({
      connectionString: "postgresql://u:p@example.invalid/db?sslmode=require",
      createClient: (config) => factory.create(config),
      log: (line) => logs.push(line),
    });
    await session.executor.query("SELECT 1");
    factory.clients[0]!.fireError(Object.assign(new Error("terminated"), { code: "57P01" }));
    await session.executor.query("SELECT 2");
    assert.equal(factory.clients.length, 2);
    assert.deepEqual(factory.clients[1]!.statements, ["SELECT 2"]);
    assert.match(logs.join("\n"), /connection ended \(57P01\)/u);
    await session.close();
  });

  it("keeps the connection after a SQL error and rebuilds it after a timeout-style failure", async () => {
    const factory = fakeFactory();
    const session = createHostedSession({
      connectionString: "postgresql://u:p@example.invalid/db?sslmode=require",
      createClient: (config) => factory.create(config),
    });
    await session.executor.query("SELECT 1");
    factory.clients[0]!.failNext(Object.assign(new Error("duplicate key"), { code: "23505" }));
    await assert.rejects(session.executor.query("SELECT 2"));
    await session.executor.query("SELECT 3");
    assert.equal(factory.clients.length, 1);

    factory.clients[0]!.failNext(new Error("Query read timeout"));
    await assert.rejects(session.executor.query("SELECT 4"));
    await session.executor.query("SELECT 5");
    assert.equal(factory.clients.length, 2);
    assert.deepEqual(factory.clients[1]!.statements, ["SELECT 5"]);
    await session.close();
  });

  it("counts transaction-state warnings from the server (interleaving tripwire)", async () => {
    const factory = fakeFactory();
    const logs: string[] = [];
    const session = createHostedSession({
      connectionString: "postgresql://u:p@example.invalid/db?sslmode=require",
      createClient: (config) => factory.create(config),
      log: (line) => logs.push(line),
    });
    await session.executor.query("SELECT 1");
    factory.clients[0]!.fireNotice("25001");
    factory.clients[0]!.fireNotice("00000");
    assert.equal(session.transactionStateWarnings(), 1);
    assert.match(logs.join("\n"), /transaction-state warning 25001 \(count 1\)/u);
    await session.close();
  });
});

describe("bootstrap source seed", () => {
  function recordingExecutor(): { executor: SqlExecutor; statements: string[] } {
    const statements: string[] = [];
    const executor: SqlExecutor = {
      query: async <Row extends object>(text: string) => {
        statements.push(text);
        return { rows: [{ source_id: "inserted" } as unknown as Row] };
      },
      execute: async () => undefined,
    };
    return { executor, statements };
  }

  it("bootstrap inserts only missing rows and never issues an update that could undo a revocation", async () => {
    const { executor, statements } = recordingExecutor();
    const summary = await seedLiveSourcesInsertMissing(executor);
    assert.equal(summary.inserted + summary.existing, 16);
    assert.ok(statements.every((text) => !/DO UPDATE/iu.test(text)), "no statement may update an existing row");
    assert.equal(statements.filter((text) => /source_registry/u.test(text)).length, 16);
  });

  it("the default serve RSS seed never updates an existing row, so a revoked feed stays revoked", async () => {
    const { executor, statements } = recordingExecutor();
    assert.equal(await seedRssSources(executor), 14);
    assert.ok(statements.every((text) => !/DO UPDATE/iu.test(text)), "no statement may update an existing row");
  });
});

describe("live seed list (HOSTED-09: 16 sources, all approved and on)", () => {
  it("inserts exactly the 16 expected sources, each approved, active and auto-acquisition enabled", async () => {
    const recorded: { text: string; params: readonly unknown[] }[] = [];
    const executor: SqlExecutor = {
      query: async <Row extends object>(text: string, params?: readonly unknown[]) => {
        recorded.push({ text, params: params ?? [] });
        return { rows: [{ source_id: "inserted" } as unknown as Row] };
      },
      execute: async () => undefined,
    };
    await seedLiveSourcesInsertMissing(executor);
    const inserts = recorded.filter((statement) => /INSERT INTO waspada\.source_registry/u.test(statement.text));
    assert.equal(inserts.length, 16);
    assert.deepEqual(inserts.map((statement) => statement.params[0]).sort(), [...expectedLiveSourceIds()].sort());
    assert.ok(expectedLiveSourceIds().includes("petabencana"));
    assert.ok(expectedLiveSourceIds().includes("source-bmkg-gempa"));
    for (const statement of inserts) {
      assert.match(statement.text, /'active', 'approved', 'healthy', true/u);
    }
  });
});

describe("moderator bootstrap env (HOSTED-09)", () => {
  const ENV_USER = "WASPADA_MODERATOR_USERNAME";
  const ENV_PASS = "WASPADA_MODERATOR_PASSWORD";

  it("both set: seeds the moderator with the given values", () => {
    assert.deepEqual(planModeratorSeed({ [ENV_USER]: "test_moderator", [ENV_PASS]: "test-password-123" }), {
      kind: "seed",
      username: "test_moderator",
      password: "test-password-123",
    });
  });

  it("neither set (or both empty): skips", () => {
    assert.deepEqual(planModeratorSeed({}), { kind: "skip" });
    assert.deepEqual(planModeratorSeed({ [ENV_USER]: "", [ENV_PASS]: "" }), { kind: "skip" });
  });

  it("exactly one set: refuses with a code and prints no value", () => {
    const secretUser = "test_moderator_user_7731";
    const secretPass = "test-password-SECRET-9913";
    for (const env of [{ [ENV_USER]: secretUser }, { [ENV_PASS]: secretPass }]) {
      assert.throws(() => planModeratorSeed(env), (error: unknown) => {
        assert.ok(error instanceof HostedConfigError);
        assert.equal(error.code, "moderator_env_partial");
        assert.doesNotMatch(error.message, /test_moderator|test-password|SECRET/u);
        return true;
      });
    }
  });
});

describe("moderator seed (HOSTED-09, fake store, no database)", () => {
  function fakeStore(existing: boolean): { store: AccountStore; created: { role: string; username: string }[] } {
    const created: { role: string; username: string }[] = [];
    const store = {
      datasetMode: "live",
      findPasswordCredentialByUsername: async () => (existing ? { account: {} } : null),
      createPasswordAccount: async (input: { role: string; username: string }) => {
        created.push(input);
        return {};
      },
    } as unknown as AccountStore;
    return { store, created };
  }
  const input = { username: "Test_Moderator", password: "test-password-123", now: "2026-11-16T00:00:00.000Z" };

  it("creates a moderator-role account with the normalised username", async () => {
    const fresh = fakeStore(false);
    assert.equal(await seedModeratorAccount(fresh.store, input), "seeded");
    assert.equal(fresh.created.length, 1);
    assert.equal(fresh.created[0]!.role, "moderator");
    assert.equal(fresh.created[0]!.username, "test_moderator");
  });

  it("leaves an existing username alone: no create, never a reset", async () => {
    const existing = fakeStore(true);
    assert.equal(await seedModeratorAccount(existing.store, input), "already exists");
    assert.equal(existing.created.length, 0);
  });
});

describe("HOSTED-13 scheduled one-cycle ingest (pure decisions, fakes only)", () => {
  const TWENTY_MIN_MS = 20 * 60_000;

  it("parses --once only together with --headless and refuses it alone", () => {
    assert.deepEqual(parseRunFlags(["--headless", "--once"]), { headless: true, once: true });
    assert.deepEqual(parseRunFlags(["--headless"]), { headless: true, once: false });
    assert.deepEqual(parseRunFlags([]), { headless: false, once: false });
    const refused = parseRunFlags(["--once"]);
    assert.equal(refused.once, true);
    assert.equal(refused.headless, false);
    assert.match(refused.error ?? "", /--once runs only with --headless/u);
  });

  it("defaults the drain budget to 20 minutes and accepts whole minutes from 1 to 25", () => {
    assert.equal(DEFAULT_INGEST_TIME_BUDGET_MINUTES, 20);
    assert.deepEqual(resolveIngestTimeBudget(undefined), { budgetMs: TWENTY_MIN_MS, invalid: false });
    assert.deepEqual(resolveIngestTimeBudget("   "), { budgetMs: TWENTY_MIN_MS, invalid: false });
    assert.deepEqual(resolveIngestTimeBudget("1"), { budgetMs: 60_000, invalid: false });
    assert.deepEqual(resolveIngestTimeBudget("25"), { budgetMs: 25 * 60_000, invalid: false });
  });

  it("falls back to the default for an out-of-range or malformed budget", () => {
    for (const raw of ["0", "26", "-5", "2.5", "20m", "1e3"]) {
      assert.deepEqual(resolveIngestTimeBudget(raw), { budgetMs: TWENTY_MIN_MS, invalid: true }, raw);
    }
  });

  it("the deadline counts from run start, and the budget is exhausted exactly at the deadline", () => {
    const deadline = drainDeadlineMs(1_000_000, TWENTY_MIN_MS);
    assert.equal(deadline, 1_000_000 + TWENTY_MIN_MS);
    assert.equal(isTimeBudgetExhausted(deadline - 1, deadline), false);
    assert.equal(isTimeBudgetExhausted(deadline, deadline), true);
  });

  it("starts no claim once the budget is already used up", async () => {
    let processed = 0;
    let claimChecks = 0;
    const result = await drainAiJobs({
      deadlineMs: 100,
      now: () => 100,
      hasClaimableJob: async () => {
        claimChecks += 1;
        return true;
      },
      processNextJob: async () => {
        processed += 1;
        return true;
      },
    });
    assert.deepEqual(result, { completed: 0, notCompleted: 0, stop: "budget" });
    assert.equal(processed, 0);
    assert.equal(claimChecks, 0);
  });

  it("never starts a job at or after the deadline, even while the queue still has work", async () => {
    let clock = 0;
    let processed = 0;
    const result = await drainAiJobs({
      deadlineMs: 50,
      now: () => clock,
      hasClaimableJob: async () => true,
      processNextJob: async () => {
        processed += 1;
        clock += 20; // jobs start at t=0, 20 and 40; at t=60 the budget is spent
        return true;
      },
    });
    assert.equal(processed, 3);
    assert.deepEqual(result, { completed: 3, notCompleted: 0, stop: "budget" });
  });

  it("stops as empty without calling processNextJob when no job is claimable", async () => {
    let processed = 0;
    const result = await drainAiJobs({
      deadlineMs: Infinity,
      now: () => 0,
      hasClaimableJob: async () => false,
      processNextJob: async () => {
        processed += 1;
        return true;
      },
    });
    assert.deepEqual(result, { completed: 0, notCompleted: 0, stop: "empty" });
    assert.equal(processed, 0);
  });

  it("drains until the queue is empty and counts completed jobs", async () => {
    const claimable = [true, true, false];
    let claimIndex = 0;
    let processed = 0;
    const result = await drainAiJobs({
      deadlineMs: Infinity,
      now: () => 0,
      hasClaimableJob: async () => claimable[claimIndex++] ?? false,
      processNextJob: async () => {
        processed += 1;
        return true;
      },
    });
    assert.equal(processed, 2);
    assert.deepEqual(result, { completed: 2, notCompleted: 0, stop: "empty" });
  });

  it("stops after three jobs in a row that do not complete, and a completed job resets the streak", async () => {
    const outcomes = [false, false, true, false, false, false, true];
    let index = 0;
    const result = await drainAiJobs({
      deadlineMs: Infinity,
      now: () => 0,
      hasClaimableJob: async () => true,
      processNextJob: async () => outcomes[index++] ?? true,
    });
    assert.equal(index, 6, "the seventh outcome is never reached");
    assert.deepEqual(result, { completed: 1, notCompleted: 5, stop: "consecutive_not_completed" });
  });

  it("lets a thrown error propagate, so the caller can treat a lost database as a hard error", async () => {
    await assert.rejects(
      drainAiJobs({
        deadlineMs: Infinity,
        now: () => 0,
        hasClaimableJob: async () => true,
        processNextJob: async () => {
          throw new Error("connection lost");
        },
      }),
      /connection lost/u,
    );
  });

  it("the claimable check is read-only and mirrors the claim predicate for the live dataset", async () => {
    const calls: { text: string; params: readonly unknown[] | undefined }[] = [];
    const executor: Pick<SqlExecutor, "query"> = {
      query: async <Row extends object>(text: string, params?: readonly unknown[]) => {
        calls.push({ text, params });
        return { rows: [] as Row[] };
      },
    };
    const found = await hasClaimableAiJob(executor, "live", "2026-11-16T00:00:00.000Z");
    assert.equal(found, false);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0]!.text, /\b(UPDATE|INSERT|DELETE)\b|FOR UPDATE/iu);
    assert.match(calls[0]!.text, /status IN \('pending', 'retry'\) AND available_at <= \$1/u);
    assert.match(calls[0]!.text, /status = 'leased' AND lease_expires_at < \$1/u);
    assert.deepEqual(calls[0]!.params, ["2026-11-16T00:00:00.000Z", "live"]);

    const withRow: Pick<SqlExecutor, "query"> = {
      query: async <Row extends object>() => ({ rows: [{ found: 1 }] as unknown as Row[] }),
    };
    assert.equal(await hasClaimableAiJob(withRow, "live", "2026-11-16T00:00:00.000Z"), true);
  });
});
