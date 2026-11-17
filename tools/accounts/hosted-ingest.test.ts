// HOSTED-03: pure checks for headless live ingest. Fake registry, fake SQL and fake clients only. No network.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import type { AccountStore } from "../../apps/db/src/accounts.js";
import type { SqlExecutor, TransactionalSqlExecutor } from "../../apps/db/src/sql.js";
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
import { seedLiveSourcesInsertMissing, seedRssSources, upgradeStructuredPublicDisplayGrants } from "../live-sources-seed.js";
import {
  buildHostedClientConfig,
  createHostedSession,
  HostedConfigError,
  type SessionClient,
} from "../hosted/hosted-session.js";
import { diffLayerRoles, LAYER_ROLES, planModeratorSeed, seedModeratorAccount } from "../hosted/neon-bootstrap.js";
import { roleCreationsIn } from "../hosted/layer-roles.js";
import { RoleAttributeError, stripPrivilegedRoleAttributes, verifyLayerRoleAttributes, withRoleAttributeCompat } from "../hosted/role-attribute-compat.js";
import {
  DEFAULT_INGEST_TIME_BUDGET_MINUTES,
  drainAiJobs,
  drainDeadlineMs,
  hasClaimableAiJob,
  isTimeBudgetExhausted,
  parseRunFlags,
  resolveIngestTimeBudget,
} from "../hosted/ingest-once.js";
// HOSTED-24C: the attribution backfill, its step in the --once order, and the publish fixtures it is tested with.
import { backfillSourceAttributions, supportKeysOf } from "../hosted/attribution-backfill.js";
import {
  formatAttributionLine,
  runOnceSequence,
  type AttributionBackfillResult,
  type DrainResult,
  type OnceSteps,
  type PublicationSweepResult,
} from "../hosted/ingest-once.js";
import { createTestDatabase, type TestDatabase } from "../../apps/db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../apps/db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../apps/db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../apps/db/src/event-proposal-writer.js";
import { createPublicEventListRepository } from "../../apps/db/src/public-event-list.js";
import { createPublicEventSnapshotRepository } from "../../apps/db/src/public-event-snapshot.js";
import { createPublicProjectionLookupRepository } from "../../apps/db/src/public-projection-lookups.js";
import { createPublicEventListProjectionService } from "../../apps/worker/src/layers/l4-application-integration/public-event-list-projection-service.js";
import { createPublicEventProjectionService } from "../../apps/worker/src/layers/l4-application-integration/public-event-projection-service.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  attributionDecisionIdFor,
  decideProposal,
  type ProposalDecisionDependencies,
} from "../../apps/worker/src/layers/l4-application-integration/proposal-publication.js";

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

describe("structured public display grant (17 Nov, fake executor)", () => {
  const RSS_GRANT = ["model_triage", "model_description", "retain_title", "retain_description", "retain_derived", "public_display"];
  const LEGACY = ["public"];
  const PETABENCANA = "petabencana";
  const BMKG = "source-bmkg-gempa";

  interface RegistryRow {
    source_id: string;
    approval_status: string;
    registry_status: string;
    auto_acquisition_enabled: boolean;
    reuse_basis: string[];
  }

  function legacyRow(sourceId: string, overrides: Partial<RegistryRow> = {}): RegistryRow {
    return {
      source_id: sourceId,
      approval_status: "approved",
      registry_status: "active",
      auto_acquisition_enabled: true,
      reuse_basis: [...LEGACY],
      ...overrides,
    };
  }

  /** Fake registry. It answers the upgrade's UPDATE by applying the same WHERE clause to the rows it holds. */
  function fakeRegistry(rows: RegistryRow[]): { executor: SqlExecutor; statements: string[] } {
    const statements: string[] = [];
    const executor: SqlExecutor = {
      query: async <Row extends object>(text: string, params?: readonly unknown[]) => {
        statements.push(text);
        const row = rows.find((candidate) => candidate.source_id === params?.[0]);
        const eligible = row !== undefined
          && row.approval_status === "approved"
          && row.registry_status === "active"
          && row.auto_acquisition_enabled === true
          && row.reuse_basis.length === 1
          && row.reuse_basis[0] === "public";
        if (!/^\s*UPDATE waspada\.source_registry/u.test(text) || row === undefined || !eligible) {
          return { rows: [] as unknown as Row[] };
        }
        row.reuse_basis = [...RSS_GRANT];
        return { rows: [{ source_id: row.source_id } as unknown as Row] };
      },
      execute: async () => undefined,
    };
    return { executor, statements };
  }

  it("upgrades only the legacy PetaBencana and BMKG rows, adds public_display, and returns the count", async () => {
    const rssFeed = expectedLiveSourceIds()[0]!;
    const rows = [legacyRow(PETABENCANA), legacyRow(BMKG), legacyRow(rssFeed)];
    const { executor, statements } = fakeRegistry(rows);

    assert.equal(await upgradeStructuredPublicDisplayGrants(executor), 2);
    assert.deepEqual(rows[0]!.reuse_basis, RSS_GRANT);
    assert.deepEqual(rows[1]!.reuse_basis, RSS_GRANT);
    assert.deepEqual(rows[2]!.reuse_basis, LEGACY, "an RSS feed is outside this upgrade");

    const updates = statements.filter((text) => /UPDATE waspada\.source_registry/u.test(text));
    assert.equal(updates.length, 2, "one guarded UPDATE per structured source");
    for (const text of updates) {
      assert.match(text, /approval_status = 'approved'/u);
      assert.match(text, /registry_status = 'active'/u);
      assert.match(text, /auto_acquisition_enabled = true/u);
      assert.match(text, /reuse_basis = ARRAY\['public'\]::text\[\]/u);
      assert.doesNotMatch(text, /DELETE/iu);
    }
  });

  it("never changes a revoked, disabled, paused or already-changed row, and a second run changes nothing", async () => {
    const untouched: Array<[string, Partial<RegistryRow>]> = [
      ["revoked", { approval_status: "revoked" }],
      ["disabled", { registry_status: "disabled" }],
      ["auto-acquisition off", { auto_acquisition_enabled: false }],
      ["already changed", { reuse_basis: ["public", "model_triage"] }],
      ["already public_display", { reuse_basis: [...RSS_GRANT] }],
    ];
    for (const [label, overrides] of untouched) {
      const row = legacyRow(BMKG, overrides);
      const before = JSON.stringify(row);
      const { executor } = fakeRegistry([row]);
      assert.equal(await upgradeStructuredPublicDisplayGrants(executor), 0, label);
      assert.equal(JSON.stringify(row), before, `${label}: the row is unchanged`);
    }

    const { executor } = fakeRegistry([legacyRow(PETABENCANA), legacyRow(BMKG)]);
    assert.equal(await upgradeStructuredPublicDisplayGrants(executor), 2);
    assert.equal(await upgradeStructuredPublicDisplayGrants(executor), 0, "the second run is a no-op");
  });

  it("a fresh PetaBencana or BMKG seed carries the same public-display grant as the RSS seed", async () => {
    const statements: { text: string; params: readonly unknown[] }[] = [];
    const executor: SqlExecutor = {
      query: async <Row extends object>(text: string, params?: readonly unknown[]) => {
        statements.push({ text, params: params ?? [] });
        return { rows: [{ source_id: "inserted" } as unknown as Row] };
      },
      execute: async () => undefined,
    };
    await seedLiveSourcesInsertMissing(executor);
    const structured = statements.filter((statement) => statement.params[0] === PETABENCANA || statement.params[0] === BMKG);
    assert.equal(structured.length, 2);
    for (const statement of structured) {
      assert.match(statement.text, /'public_display'\]/u);
      assert.doesNotMatch(statement.text, /ARRAY\['public'\], 'active'/u);
    }
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

describe("Neon role-attribute compatibility (HOSTED-19)", () => {
  const migrationsDir = fileURLToPath(new URL("../../apps/db/migrations/", import.meta.url));
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

  it("strips only NOSUPERUSER, NOREPLICATION and NOBYPASSRLS from waspada ALTER ROLE statements in every migration", () => {
    let touched = 0;
    for (const name of files) {
      const sql = fs.readFileSync(`${migrationsDir}${name}`, "utf8");
      const out = stripPrivilegedRoleAttributes(sql);
      for (const statement of out.match(/ALTER\s+ROLE\s+waspada_[a-z0-9_]+\b[^;]*/giu) ?? []) {
        assert.doesNotMatch(statement, /NOSUPERUSER|NOREPLICATION|NOBYPASSRLS/u, name);
        assert.match(statement, /NOLOGIN/u, name);
      }
      if (out !== sql) touched += 1;
      const stripKeywords = (text: string) => text.replace(/\s+NO(?:SUPERUSER|REPLICATION|BYPASSRLS)\b/gu, "");
      assert.equal(stripKeywords(out), stripKeywords(sql), `${name}: only the three keywords may change`);
    }
    assert.ok(touched >= 8, `expected the hardened-role migrations to be adjusted, got ${touched}`);
  });

  it("keeps NOLOGIN, NOINHERIT, NOCREATEDB and NOCREATEROLE, and leaves other statements alone", () => {
    const sql = "ALTER ROLE waspada_x\n  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;\nCOMMENT ON ROLE waspada_x IS 'NOSUPERUSER';";
    assert.equal(
      stripPrivilegedRoleAttributes(sql),
      "ALTER ROLE waspada_x\n  NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE;\nCOMMENT ON ROLE waspada_x IS 'NOSUPERUSER';",
    );
    assert.equal(stripPrivilegedRoleAttributes("ALTER ROLE other_role NOSUPERUSER;"), "ALTER ROLE other_role NOSUPERUSER;");
  });

  it("the wrapper rewrites execute() only and passes query() through", async () => {
    const seen: string[] = [];
    const inner: SqlExecutor = {
      query: async <Row extends object>(text: string) => {
        seen.push(`q:${text}`);
        return { rows: [] as Row[] };
      },
      execute: async (text: string) => {
        seen.push(`e:${text}`);
      },
    };
    const wrapped = withRoleAttributeCompat(inner);
    await wrapped.execute("ALTER ROLE waspada_y NOLOGIN NOSUPERUSER;");
    await wrapped.query("SELECT 'ALTER ROLE waspada_y NOSUPERUSER'");
    assert.deepEqual(seen, ["e:ALTER ROLE waspada_y NOLOGIN;", "q:SELECT 'ALTER ROLE waspada_y NOSUPERUSER'"]);
  });

  it("fails closed when any waspada role holds superuser, replication or bypassrls", async () => {
    const rows = (bad: boolean) => [
      { rolname: "waspada_a", rolsuper: false, rolreplication: false, rolbypassrls: false },
      { rolname: "waspada_b", rolsuper: false, rolreplication: false, rolbypassrls: bad },
    ];
    const fake = (bad: boolean): Pick<SqlExecutor, "query"> => ({
      query: async <Row extends object>() => ({ rows: rows(bad) as unknown as Row[] }),
    });
    assert.equal(await verifyLayerRoleAttributes(fake(false)), 2);
    await assert.rejects(verifyLayerRoleAttributes(fake(true)), (error: unknown) => {
      assert.ok(error instanceof RoleAttributeError);
      assert.deepEqual(error.roles, ["waspada_b"]);
      return true;
    });
  });
});

// HOSTED-24C: the attribution backfill. An event published before HOSTED-22 has no attribution row, so the public list
// skips it. The backfill gives it the row the publish path would have written, and nothing else. One PGlite instance serves
// the whole DB describe, because repeated PGlite instances in one process crash V8 under WSL Node 24. The publish path is
// the real decideProposal, and the lineage is authored synthetic data.

const H24C_RETRIEVED_AT = "2026-11-10T08:00:00.000Z";
const H24C_SOURCE_PUBLISHED_AT = "2026-11-09T05:30:00.000Z";
const H24C_SOURCE_PUBLISHED_AT_TEXT = "2026-11-09T05:30:00.000000Z";
const H24C_CLAIM_TEXT = "Genangan setinggi 50 cm di Cawang (fiktif)";
const H24C_ZERO: AttributionBackfillResult = { candidates: 0, attributed: 0, skipped: 0, failed: 0 };

const h24cSource = (key: string): string => `source-lineage-${key}`;
const h24cRevision = (key: string): string => `rev-lineage-${key}`;

function h24cProposal(lineage: ProposalLineage, key: string, incidentId: string): EventProposalDto {
  const sourceId = h24cSource(key);
  return {
    schema_version: "2.0",
    ...lineage,
    proposal_id: `prop-${incidentId}`,
    incident_id: incidentId,
    title: "Genangan di Cawang (fiktif)",
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    compatibility_category: "flood",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [{
      claim_id: "claim-1",
      claim_text: H24C_CLAIM_TEXT,
      evidence_label: "attributed_report",
      support_assessment: "supported",
      quote_text: H24C_CLAIM_TEXT,
      evidence_ref_id: `chk-${incidentId}`,
      source_id: sourceId,
      outlet: "Fictional lineage source",
      source_url: `https://lineage.invalid/${key}`,
    }],
    impacts: [],
    interpretation_category: null,
    source_id: sourceId,
    is_multi_source: false,
    source_count: 1,
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: "primary_initial",
    proposed_at: "2026-11-10T08:05:00.000Z",
  } as EventProposalDto;
}

describe("HOSTED-24C attribution backfill (PGlite, real publish path)", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const lineages = new Map<string, ProposalLineage>();
  /** The sources the rights check permits right now. An owner approval is modelled by adding the source here. */
  const permitted = new Set<string>();
  const checkPublicDisplay = async (sourceId: string): Promise<boolean> => permitted.has(sourceId);

  const persistAndPublish = async (key: string, incidentId: string, sourcePermission?: "required" | "local_relaxed") => {
    const lineage = lineages.get(key);
    assert.ok(lineage, `lineage ${key} is seeded`);
    await createEventProposalWriter(db.executor).persistProposal(h24cProposal(lineage, key, incidentId), "live");
    return decideProposal(deps, {
      proposalId: `prop-${incidentId}`,
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
      ...(sourcePermission === undefined ? {} : { sourcePermission }),
    });
  };
  const backfill = (executor: TransactionalSqlExecutor = db.executor): Promise<AttributionBackfillResult> => backfillSourceAttributions({
    executor,
    checkPublicDisplay,
    deadlineMs: Number.POSITIVE_INFINITY,
    now: () => 0,
  });
  const listService = () => createPublicEventListProjectionService({
    candidates: createPublicEventListRepository(db.executor),
    projections: createPublicEventProjectionService({
      snapshots: createPublicEventSnapshotRepository(db.executor),
      lookups: createPublicProjectionLookupRepository(db.executor),
    }),
  });
  const listedEventIds = async (): Promise<string[]> => (await listService().read()).events.map((event) => event.event_id);
  const allAttributionRows = async (): Promise<readonly Record<string, unknown>[]> => (await db.executor.query<Record<string, unknown>>(
    `SELECT review_decision_id, dataset_kind, evidence_ref_id::text AS evidence_ref_id, report_revision_id, review_version,
            decision_status, public_display_name, source_url, reviewer_id, rights_basis_ref, relation, offset_unit,
            to_char(reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reviewed_at,
            to_char(source_published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_published_at
     FROM waspada.public_attribution_review_decisions
     ORDER BY review_decision_id`,
  )).rows;
  const rowsFor = async (key: string) => (await allAttributionRows()).filter((row) => row.report_revision_id === h24cRevision(key));
  const counts = async () => (await db.executor.query<{ versions: number; decisions: number }>(
    `SELECT (SELECT COUNT(*)::int FROM waspada.event_versions WHERE dataset_kind = 'live') AS versions,
            (SELECT COUNT(*)::int FROM waspada.publication_decisions WHERE dataset_kind = 'live') AS decisions`,
  )).rows[0]!;
  const decidedAtOf = async (incidentId: string): Promise<string> => (await db.executor.query<{ decided_at: string }>(
    `SELECT to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at
     FROM waspada.publication_decisions WHERE dataset_kind = 'live' AND proposal_id = $1`,
    [`prop-${incidentId}`],
  )).rows[0]!.decided_at;

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../apps/db/migrations/", import.meta.url)));
    // The public views read only a dataset the namespace config names as live.
    await db.executor.query("INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind) VALUES (true, 'live')");
    deps = { executor: db.executor, datasetKind: "live", checkPublicDisplay };
    for (const key of ["h24c-ok", "h24c-gap", "h24c-off", "h24c-flaky", "h24c-flaky2"]) {
      lineages.set(key, await seedProposalLineage(db.executor, key, "live", H24C_RETRIEVED_AT, H24C_SOURCE_PUBLISHED_AT));
    }
    // Published with its attribution: the source is permitted at publication, as the HOSTED-22 path writes it.
    permitted.add(h24cSource("h24c-ok"));
    assert.equal((await persistAndPublish("h24c-ok", "inc-h24c-ok-1")).status, "published");
    // Published without a row, as before HOSTED-22: the source is not permitted at publication, and local_relaxed lets it publish.
    permitted.clear();
    assert.equal((await persistAndPublish("h24c-gap", "inc-h24c-gap-1", "local_relaxed")).status, "published");
  });

  after(async () => {
    await db?.close();
  });

  it("HOSTED-24C a published event with no attribution row gets one on the first run, and then appears in the public list", async () => {
    assert.deepEqual(await rowsFor("h24c-gap"), [], "no attribution row before the backfill");
    assert.equal((await listedEventIds()).includes("inc-h24c-gap-1"), false, "the public list skips it before the backfill");
    const countsBefore = await counts();

    permitted.add(h24cSource("h24c-gap"));
    assert.deepEqual(await backfill(), { candidates: 1, attributed: 1, skipped: 0, failed: 0 });

    const rows = await rowsFor("h24c-gap");
    assert.equal(rows.length, 1, "the one supporting reference has one row");
    const row = rows[0]!;
    assert.equal(row.review_decision_id, attributionDecisionIdFor("live", String(row.evidence_ref_id)));
    assert.equal(row.decision_status, "approved");
    assert.equal(row.review_version, 1);
    assert.equal(row.public_display_name, "Fictional lineage source", "the registry display name");
    assert.equal(row.source_url, "https://lineage.invalid/h24c-gap", "the revision's own canonical link");
    assert.equal(row.source_published_at, H24C_SOURCE_PUBLISHED_AT_TEXT, "the source's own publish time");
    assert.equal(row.reviewer_id, AGENT_AUTO_PUBLISHER_ID);
    assert.equal(row.reviewed_at, await decidedAtOf("inc-h24c-gap-1"), "the decision time of the publication it belongs to");
    assert.deepEqual(await counts(), countsBefore, "no event version and no publication decision was written");
    assert.ok((await listedEventIds()).includes("inc-h24c-gap-1"), "the public list now shows the event");
  });

  it("HOSTED-24C a second run inserts no row, and an event that is already attributed is not a candidate and is not touched", async () => {
    const rowsBefore = await allAttributionRows();
    assert.equal(rowsBefore.length, 2, "one row for the event published with attribution, one for the backfilled event");
    assert.deepEqual(await backfill(), H24C_ZERO);
    assert.deepEqual(await backfill(), H24C_ZERO, "a repeat is a no-op");
    assert.deepEqual(await allAttributionRows(), rowsBefore, "the same rows, with the same ids and times");
    const listed = await listedEventIds();
    assert.ok(listed.includes("inc-h24c-ok-1") && listed.includes("inc-h24c-gap-1"), "both events stay listed");
  });

  it("HOSTED-24C a version whose source is still not permitted is counted as skipped, retried on later runs, and attributed once permitted", async () => {
    permitted.clear();
    assert.equal((await persistAndPublish("h24c-off", "inc-h24c-off-1", "local_relaxed")).status, "published");
    assert.deepEqual(await rowsFor("h24c-off"), []);

    assert.deepEqual(await backfill(), { candidates: 1, attributed: 0, skipped: 1, failed: 0 });
    assert.deepEqual(await backfill(), { candidates: 1, attributed: 0, skipped: 1, failed: 0 }, "still a candidate on the next run");
    assert.deepEqual(await rowsFor("h24c-off"), [], "no row for a source that is not permitted");

    permitted.add(h24cSource("h24c-off"));
    assert.deepEqual(await backfill(), { candidates: 1, attributed: 1, skipped: 0, failed: 0 });
    assert.equal((await rowsFor("h24c-off")).length, 1);
  });

  it("HOSTED-24C a failed write is counted and the run goes on to the next version, and past the budget nothing is attempted", async () => {
    permitted.clear();
    // The older publication is the first candidate. Its write fails once, and the newer one still gets its row.
    assert.equal((await persistAndPublish("h24c-flaky", "inc-h24c-flaky-1", "local_relaxed")).status, "published");
    assert.equal((await persistAndPublish("h24c-flaky2", "inc-h24c-flaky2-1", "local_relaxed")).status, "published");
    permitted.add(h24cSource("h24c-flaky"));
    permitted.add(h24cSource("h24c-flaky2"));
    let injected = false;
    const flaky: TransactionalSqlExecutor = {
      query: db.executor.query,
      execute: db.executor.execute,
      transaction: <Result>(work: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> => {
        if (!injected) {
          injected = true;
          return Promise.reject(new Error("injected write failure"));
        }
        return db.executor.transaction(work);
      },
    };
    assert.deepEqual(await backfill(flaky), { candidates: 2, attributed: 1, skipped: 0, failed: 1 }, "the first write fails, the second is attributed");
    assert.deepEqual(await rowsFor("h24c-flaky"), [], "the failed write left no row");
    assert.equal((await rowsFor("h24c-flaky2")).length, 1, "the run went on to the next version");

    const pastBudget = await backfillSourceAttributions({
      executor: db.executor,
      checkPublicDisplay,
      deadlineMs: 0,
      now: () => 1,
    });
    assert.deepEqual(pastBudget, H24C_ZERO, "at or after the deadline no version is attempted");
    assert.deepEqual(await rowsFor("h24c-flaky"), []);

    assert.deepEqual(await backfill(), { candidates: 1, attributed: 1, skipped: 0, failed: 0 });
    assert.equal((await rowsFor("h24c-flaky")).length, 1);
  });

  it("HOSTED-24C a failed candidate query returns one failed step and does not throw", async () => {
    const down: TransactionalSqlExecutor = {
      query: <Row extends object>(): Promise<{ readonly rows: readonly Row[] }> => Promise.reject(new Error("connection lost")),
      execute: () => Promise.reject(new Error("connection lost")),
      transaction: <Result>(): Promise<Result> => Promise.reject(new Error("connection lost")),
    };
    assert.deepEqual(await backfill(down), { candidates: 0, attributed: 0, skipped: 0, failed: 1 });
  });
});

describe("HOSTED-24C attribution backfill helpers and the --once order (fakes)", () => {
  const drain: DrainResult = { completed: 0, notCompleted: 0, stop: "empty" };
  const sweep: PublicationSweepResult = {
    assessed: 0,
    published: 0,
    unchanged: 0,
    held: 0,
    denied: 0,
    skipped: 0,
    failed: 0,
    heldReasons: {},
    deniedCodes: {},
    failedCodes: {},
    stop: "done",
  };

  /** The steps of one run, recording the order of calls. An attribution step is added only when one is given. */
  function onceSteps(order: string[], logged: string[], attribution?: OnceSteps["attribution"]): OnceSteps {
    return {
      poll: async () => {
        order.push("poll");
      },
      onPollError: () => order.push("poll-error"),
      drain: async () => {
        order.push("drain");
        return drain;
      },
      sweep: async () => {
        order.push("sweep");
        return sweep;
      },
      ...(attribution === undefined ? {} : { attribution }),
      freshness: async () => {
        order.push("freshness");
      },
      log: (line) => logged.push(line),
    };
  }

  it("HOSTED-24C runs the backfill after the sweep and before freshness, and logs exactly one count line", async () => {
    const order: string[] = [];
    const logged: string[] = [];
    await runOnceSequence(onceSteps(order, logged, async () => {
      order.push("attribution");
      return { candidates: 2, attributed: 1, skipped: 1, failed: 0 };
    }));
    assert.deepEqual(order, ["poll", "drain", "sweep", "attribution", "freshness"]);
    assert.equal(logged.filter((line) => line.startsWith("[Once] Attribution backfill:")).length, 1);
    assert.equal(logged.at(-1), "[Once] Attribution backfill: candidates=2 attributed=1 skipped=1 failed=0");
  });

  it("HOSTED-24C a backfill that throws is counted as one failed step, the run still reaches freshness, and no error text is logged", async () => {
    const order: string[] = [];
    const logged: string[] = [];
    await runOnceSequence(onceSteps(order, logged, async () => {
      order.push("attribution");
      throw new Error("connection lost to a source URL");
    }));
    assert.deepEqual(order, ["poll", "drain", "sweep", "attribution", "freshness"]);
    assert.equal(logged.at(-1), "[Once] Attribution backfill: candidates=0 attributed=0 skipped=0 failed=1");
    assert.equal(logged.some((line) => line.includes("connection lost") || line.includes("URL")), false, "the error text never reaches the log");
  });

  it("HOSTED-24C a run without an attribution step keeps its order and logs no backfill line", async () => {
    const order: string[] = [];
    const logged: string[] = [];
    await runOnceSequence(onceSteps(order, logged));
    assert.deepEqual(order, ["poll", "drain", "sweep", "freshness"]);
    assert.equal(logged.some((line) => line.includes("Attribution backfill")), false);
  });

  it("HOSTED-24C the count line has a fixed shape with no source text", () => {
    assert.equal(
      formatAttributionLine({ candidates: 3, attributed: 2, skipped: 1, failed: 0 }),
      "[Once] Attribution backfill: candidates=3 attributed=2 skipped=1 failed=0",
    );
  });

  it("HOSTED-24C reads one distinct reference per exact tuple, in record order, and counts a malformed entry", () => {
    const hash = "a".repeat(64);
    const ref = {
      report_revision_id: "rev-1",
      permitted_text_hash: hash,
      span_start: 0,
      span_end: 5,
      offset_unit: "unicode_code_points",
      relation: "supports",
    };
    const record = {
      claims: [
        { support: [ref, ref, { ...ref, span_end: 3 }, { ...ref, relation: "context" }, null] },
        { support: [ref] },
      ],
    };
    const result = supportKeysOf(record);
    assert.equal(result.keys.length, 2, "the repeated tuple is listed once");
    assert.equal(result.malformed, 2, "a context relation and a non-object entry are malformed");
    assert.deepEqual(result.keys[0], {
      report_revision_id: "rev-1",
      permitted_text_hash: hash,
      span_start: "0",
      span_end: "5",
      offset_unit: "unicode_code_points",
      relation: "supports",
    });
    assert.deepEqual(supportKeysOf({}), { keys: [], malformed: 0 }, "a record with no claims has no support");
  });
});
