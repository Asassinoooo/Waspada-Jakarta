// INTEL-02 B2: every persisted proposal has a unique ID, nothing is silently dropped, and the moderation
// notification names the proposal that was persisted. Fake agents, mock embeddings, PGlite. No network.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import {
  createNineRouterRateGate,
  setNineRouterRateGate,
  type NineRouterFetch,
} from "../../db/src/ninerouter-rate-gate.js";
import {
  createIncidentIntelligenceWorkflow,
  proposalIdFor,
  IncidentWorkflowInputSchema,
} from "../src/workflows/incident-intelligence-workflow.js";
import { createJobRunner } from "../src/job-runner.js";
import { createMockCorrelatorAgent, createMockInterpreterAgent } from "./mock-agents.js";
import type { NineRouterConfig } from "../src/providers/ninerouter-adapter.js";
import type { z } from "zod";

type IncidentWorkflowInput = z.infer<typeof IncidentWorkflowInputSchema>;

const NO_SLEEP_CLOCK = { now: () => Date.now(), sleep: async () => {} };
const MOCK_CONFIG: NineRouterConfig = {
  baseUrl: "http://nr.test",
  apiKey: "",
  chatModel: "Waspada-Jakarta",
  embeddingModel: "gemini/gemini-embedding-2-preview",
  embeddingDimensions: 768,
  executionMode: "mock",
  explicitMock: false,
};
const BANJIR_TEXT = "Banjir setinggi 40 cm merendam Jalan Mampang Prapatan, Jakarta Selatan.";

function reportInput(revisionId: string, text = BANJIR_TEXT): IncidentWorkflowInput {
  return {
    reportRevisionId: revisionId,
    reportText: text,
    sourceKind: "rss",
    sourceDisplayName: "Fixture News",
    sourceId: `source-${revisionId}`,
    publishedAt: "2026-11-11T07:00:00.000Z",
    datasetKind: "synthetic",
    traceId: `trace-${revisionId}`,
    evidenceChunks: [{ chunkId: `chk-${revisionId}`, spanStart: 0, spanEnd: text.length, text }],
  };
}

function interpreter(overrides: Parameters<typeof createMockInterpreterAgent>[0] = {}) {
  return createMockInterpreterAgent({
    summary: "Banjir merendam Jalan Mampang Prapatan, Jakarta Selatan",
    incidentType: "banjir",
    primaryCategory: "disasters_weather",
    location: { label: "Jalan Mampang Prapatan", approximateCoordinates: null, precision: "district" },
    evidence: [],
    ...overrides,
  });
}

describe("INTEL-02 proposal IDs (unit)", () => {
  it("a new incident keeps prop-inc-<revision>; a linked report is keyed to the incident and its own revision", () => {
    assert.equal(proposalIdFor("inc-rev-1", "rev-1", false), "prop-inc-rev-1");
    assert.equal(proposalIdFor("inc-rev-1", "rev-2", true), "prop-inc-rev-1-rev-2");
    assert.notEqual(proposalIdFor("inc-rev-1", "rev-2", true), proposalIdFor("inc-rev-1", "rev-3", true));
  });
});

describe("INTEL-02 proposal IDs (workflow, PGlite)", () => {
  let db: TestDatabase;
  let savedMode: string | undefined;

  beforeEach(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    // Embeddings are mock vectors, so no gateway call is made.
    savedMode = process.env.NINEROUTER_MODE;
    process.env.NINEROUTER_MODE = "mock";
    const transport: NineRouterFetch = async (input) => {
      throw new Error(`no gateway in this test: ${String(input)}`);
    };
    setNineRouterRateGate(createNineRouterRateGate({ transport, clock: NO_SLEEP_CLOCK, log: () => {} }));
  });

  afterEach(async () => {
    setNineRouterRateGate(undefined);
    if (savedMode === undefined) delete process.env.NINEROUTER_MODE;
    else process.env.NINEROUTER_MODE = savedMode;
    await db.close();
  });

  async function runReport(input: IncidentWorkflowInput, agents: { interpreter: ReturnType<typeof interpreter>; correlator: ReturnType<typeof createMockCorrelatorAgent> }) {
    const workflow = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      config: MOCK_CONFIG,
      agentOverrides: { interpreter: agents.interpreter, correlator: agents.correlator },
    });
    const execution = await (await workflow.createRun()).start({ inputData: input });
    assert.equal(execution.status, "success");
    return execution.result as any;
  }

  async function storedRow(proposalId: string) {
    const rows = await db.executor.query<{ proposal_id: string; claims: string }>(
      `SELECT ep.proposal_id,
              (SELECT count(*)::text FROM waspada.proposal_claims pc
                WHERE pc.dataset_kind = ep.dataset_kind AND pc.proposal_id = ep.proposal_id) AS claims
       FROM waspada.event_proposals ep
       WHERE ep.dataset_kind = 'synthetic' AND ep.proposal_id = $1`,
      [proposalId],
    );
    return rows.rows[0];
  }

  it("two reports linked to the same incident as 'unresolved' both persist (the old prop-<incident> ID collided and dropped the second)", async () => {
    const first = await runReport(reportInput("rev-unres-1"), {
      interpreter: interpreter({ evidence: [{ chunkId: "chk-rev-unres-1", exactQuote: "Banjir setinggi 40 cm", supports: "tinggi air" }] }),
      correlator: createMockCorrelatorAgent({ decision: "new_incident", candidateIncidentId: null }),
    });
    const incidentId = first.incident.incidentId as string;
    assert.equal(first.proposal.proposal_id, `prop-inc-rev-unres-1`);

    const unresolvedCorrelator = () => createMockCorrelatorAgent({
      decision: "unresolved",
      candidateIncidentId: incidentId,
      reasoning: "Laporan kedua belum pasti.",
    });
    const second = await runReport(reportInput("rev-unres-2", "Banjir merendam Jalan Mampang Prapatan sejak pagi."), {
      interpreter: interpreter({ evidence: [{ chunkId: "chk-rev-unres-2", exactQuote: "Banjir merendam Jalan Mampang Prapatan", supports: "lokasi" }] }),
      correlator: unresolvedCorrelator(),
    });
    assert.equal(second.correlation.decision, "unresolved");
    assert.equal(second.proposal.proposal_id, `prop-${incidentId}-rev-unres-2`);

    const third = await runReport(reportInput("rev-unres-3", "Banjir di Jalan Mampang Prapatan, air masih naik."), {
      interpreter: interpreter({ evidence: [{ chunkId: "chk-rev-unres-3", exactQuote: "air masih naik", supports: "kondisi" }] }),
      correlator: unresolvedCorrelator(),
    });
    assert.equal(third.proposal.proposal_id, `prop-${incidentId}-rev-unres-3`);

    for (const id of [second.proposal.proposal_id, third.proposal.proposal_id] as string[]) {
      const row = await storedRow(id);
      assert.ok(row, `${id} is persisted`);
      assert.equal(Number(row.claims), 1, `${id} keeps its claim`);
    }
  });

  it("a chain of same_incident reports gives each report its own ID, with a count that grows and no ID reuse", async () => {
    const first = await runReport(reportInput("rev-chain-1"), {
      interpreter: interpreter({ evidence: [{ chunkId: "chk-rev-chain-1", exactQuote: "Banjir setinggi 40 cm", supports: "tinggi air" }] }),
      correlator: createMockCorrelatorAgent({ decision: "new_incident", candidateIncidentId: null }),
    });
    const incidentId = first.incident.incidentId as string;

    const ids: string[] = [first.proposal.proposal_id];
    for (const [index, revision] of ["rev-chain-2", "rev-chain-3"].entries()) {
      const next = await runReport(reportInput(revision, `Banjir merendam Jalan Mampang Prapatan, laporan ${index + 2}.`), {
        interpreter: interpreter({ evidence: [{ chunkId: `chk-${revision}`, exactQuote: `laporan ${index + 2}`, supports: "konfirmasi" }] }),
        correlator: createMockCorrelatorAgent({ decision: "same_incident", candidateIncidentId: incidentId }),
      });
      assert.equal(next.correlation.decision, "same_incident");
      assert.equal(next.proposal.proposal_id, `prop-${incidentId}-${revision}`);
      assert.equal(next.proposal.source_count, index + 2, "the count grows from the latest proposal");
      ids.push(next.proposal.proposal_id);
    }
    assert.equal(new Set(ids).size, ids.length, "no proposal ID is reused");
    const latest = await storedRow(ids[2]!);
    assert.equal(Number(latest?.claims), 3, "the latest proposal carries every claim, so none is lost");
  });

  it("an unresolved report between corroborations does not reset the count (the chain head keeps extending)", async () => {
    const first = await runReport(reportInput("rev-mix-1"), {
      interpreter: interpreter({ evidence: [{ chunkId: "chk-rev-mix-1", exactQuote: "Banjir setinggi 40 cm", supports: "tinggi air" }] }),
      correlator: createMockCorrelatorAgent({ decision: "new_incident", candidateIncidentId: null }),
    });
    const incidentId = first.incident.incidentId as string;
    const linked = (revision: string, decision: "same_incident" | "unresolved", quote: string) =>
      runReport(reportInput(revision, `Banjir merendam Jalan Mampang Prapatan, ${quote}.`), {
        interpreter: interpreter({ evidence: [{ chunkId: `chk-${revision}`, exactQuote: quote, supports: "konfirmasi" }] }),
        correlator: createMockCorrelatorAgent({ decision, candidateIncidentId: incidentId }),
      });

    const second = await linked("rev-mix-2", "same_incident", "laporan kedua");
    assert.equal(second.proposal.source_count, 2);
    const unresolved = await linked("rev-mix-3", "unresolved", "laporan ketiga");
    assert.equal(unresolved.proposal.proposal_id, `prop-${incidentId}-rev-mix-3`);
    const fourth = await linked("rev-mix-4", "same_incident", "laporan keempat");

    assert.equal(fourth.proposal.source_count, 3, "the count grows from the corroborated chain, not from the unresolved proposal");
    assert.equal(fourth.proposal.claims.length, 3, "the chain keeps its corroborated claims and the new one");
    assert.equal(Number((await storedRow(unresolved.proposal.proposal_id as string))?.claims), 1, "the unresolved report keeps its own claim");
    assert.equal(Number((await storedRow(fourth.proposal.proposal_id as string))?.claims), 3);
  });

  it("a proposal ID conflict fails the run before any incident, decision or link is written", async () => {
    const writer = createEventProposalWriter(db.executor);
    await writer.persistProposal({
      schema_version: "2.0",
      proposal_id: "prop-inc-rev-conflict-run",
      title: "Banjir lama",
      incident_type: "banjir",
      primary_category: "disasters_weather",
      severity: "unknown",
      event_time: { precision: "unknown", value: null },
      location_label: null,
      coordinates: null,
      claims: [{ claim_id: "claim-1", claim_text: "lama", evidence_label: "under_review", support_assessment: "supported", quote_text: "", evidence_ref_id: "x" }],
      proposed_at: "2026-11-11T07:00:00.000Z",
    }, "synthetic");

    const workflow = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      config: MOCK_CONFIG,
      agentOverrides: {
        interpreter: interpreter({ evidence: [{ chunkId: "chk-rev-conflict-run", exactQuote: "Banjir setinggi 40 cm", supports: "tinggi air" }] }),
        correlator: createMockCorrelatorAgent({ decision: "new_incident", candidateIncidentId: null }),
      },
    });
    const execution = await (await workflow.createRun()).start({ inputData: reportInput("rev-conflict-run") });
    assert.notEqual(execution.status, "success", "a conflicting ID must not succeed silently");

    const incidents = await db.executor.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM waspada.incidents WHERE dataset_kind = 'synthetic' AND incident_id = 'inc-rev-conflict-run'`,
    );
    assert.equal(Number(incidents.rows[0]?.n), 0, "no incident was written for the conflicting run");
    const decisions = await db.executor.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM waspada.incident_correlation_decisions WHERE dataset_kind = 'synthetic' AND report_revision_id = 'rev-conflict-run'`,
    );
    assert.equal(Number(decisions.rows[0]?.n), 0, "no correlation decision was written for the conflicting run");
    const existing = await storedRow("prop-inc-rev-conflict-run");
    assert.equal(Number(existing?.claims), 1, "the existing proposal is unchanged");
  });

  it("a conflicting proposal ID is returned as already_exists and logged, not dropped silently", async () => {
    const writer = createEventProposalWriter(db.executor);
    const base: EventProposalDto = {
      schema_version: "2.0",
      proposal_id: "prop-conflict-check",
      title: "Banjir",
      incident_type: "banjir",
      primary_category: "disasters_weather",
      severity: "unknown",
      event_time: { precision: "unknown", value: null },
      location_label: null,
      coordinates: null,
      claims: [{ claim_id: "claim-1", claim_text: "a", evidence_label: "under_review", support_assessment: "supported", quote_text: "", evidence_ref_id: "x" }],
      proposed_at: "2026-11-11T07:00:00.000Z",
    };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      assert.equal((await writer.persistProposal(base, "synthetic")).outcome, "created");
      const again = await writer.persistProposal({ ...base, claims: [] }, "synthetic");
      assert.equal(again.outcome, "already_exists");
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(warnings.some((line) => /prop-conflict-check already exists/.test(line)), "the conflict is logged");
    const row = await storedRow("prop-conflict-check");
    assert.equal(Number(row?.claims), 1, "the existing proposal is unchanged");
  });
});

describe("INTEL-02 moderation notification (job runner, PGlite)", () => {
  let db: TestDatabase;
  let savedMode: string | undefined;
  let savedFetch: typeof fetch;

  beforeEach(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
    savedMode = process.env.NINEROUTER_MODE;
    process.env.NINEROUTER_MODE = "mock";
    setNineRouterRateGate(createNineRouterRateGate({
      transport: async () => { throw new Error("no gateway in this test"); },
      clock: NO_SLEEP_CLOCK,
      log: () => {},
    }));
    savedFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = savedFetch;
    setNineRouterRateGate(undefined);
    if (savedMode === undefined) delete process.env.NINEROUTER_MODE;
    else process.env.NINEROUTER_MODE = savedMode;
    await db.close();
  });

  it("notifies the worker with the persisted proposal ID, not the old prop-<revisionId>", async () => {
    const revisionId = "rev-notify-1";
    const text = "Banjir setinggi 40 cm merendam Jalan Mampang Prapatan, Jakarta Selatan.";
    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ('trace-notify-1', 'synthetic', now(), 'succeeded', '{}'::jsonb) ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
    );
    await db.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method, approved_hosts,
          access_restrictions, reuse_basis, registry_status, approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ('source-notify-1', 'trace-notify-1', 1, 'Sumber Uji', 'other', ARRAY['system'], 'manual_fixture', ARRAY[]::text[],
               ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
       ON CONFLICT (source_id) DO NOTHING`,
    );
    await db.executor.query(
      `INSERT INTO waspada.report_revisions
         (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text,
          permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
       VALUES ('synthetic', $1, 'trace-notify-1', 'source-notify-1', 'https://synthetic.invalid/notify', $2, $3, $2, 'v1', now(), 'unreviewed', '{}'::jsonb)
       ON CONFLICT (dataset_kind, report_revision_id) DO NOTHING`,
      [revisionId, "0".repeat(64), text],
    );
    await createSqlIncidentRepository(db.executor).enqueueAiJob({
      jobId: "ai-job-notify-1",
      datasetKind: "synthetic",
      reportRevisionId: revisionId,
      traceId: "trace-notify-1",
    });

    const runner = createJobRunner({
      executor: db.executor,
      internalServiceKey: "test-internal-key",
      workerInternalUrl: "http://worker.invalid",
      agentOverrides: {
        interpreter: interpreter({ evidence: [{ chunkId: "chk-x", exactQuote: "Banjir setinggi 40 cm", supports: "tinggi air" }] }),
        correlator: createMockCorrelatorAgent({ decision: "new_incident", candidateIncidentId: null }),
      },
    });

    const notifications: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      if (url.endsWith("/api/v1/internal/proposals")) {
        notifications.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    assert.equal(await runner.processNextJob("synthetic"), true);
    assert.equal(notifications.length, 1, "exactly one notification is sent");
    const sentId = (notifications[0]!.body as { proposal_id: string }).proposal_id;
    assert.notEqual(sentId, `prop-${revisionId}`, "the old revision-keyed ID is no longer sent");

    const persisted = await db.executor.query<{ proposal_id: string }>(
      `SELECT proposal_id FROM waspada.incident_processing_records
       WHERE dataset_kind = 'synthetic' AND report_revision_id = $1`,
      [revisionId],
    );
    assert.equal(persisted.rows[0]?.proposal_id, sentId, "the notified ID is the persisted proposal's ID");
    const proposal = await createEventProposalWriter(db.executor).readProposalById(sentId, "synthetic");
    assert.ok(proposal, "the notified proposal exists in event_proposals");
  });
});
