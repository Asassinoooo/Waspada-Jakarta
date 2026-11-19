/**
 * ST-F-12 on the live intelligence path (SYSTEM-TEST ST-F-12). The workflow runs against PGlite with live-shaped
 * reports: a registry source, one live trace and report revision per report, and its evidence chunks. The interpreter
 * is a mock. The correlator is a stub that records the prompts it receives. No model or network call is made, and the
 * data is fictional.
 *
 * Mock embeddings are not persisted on this path, so retrieval falls back to the lexical match over active incidents
 * (title, description and location words, similarity at least 0.10). Every report below therefore uses its own place
 * and street words, so one test's incident does not become a candidate for another test. The first database test needs
 * an empty live incident table, so it is declared first.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createRepositoryPorts, type NewReportRevision } from "../../db/src/ports.js";
import { createEventProposalWriter } from "../../db/src/event-proposal-writer.js";
import { createSqlIncidentRepository } from "../../db/src/incident-repository.js";
import {
  createIncidentIntelligenceWorkflow,
  type IncidentWorkflowOutput,
} from "../src/workflows/incident-intelligence-workflow.js";
import {
  CorrelationValidationError,
  validateCorrelationDecision,
  type CorrelateIncidentInput,
  type IncidentCorrelation,
} from "../src/agents/incident-correlation-agent.js";
import type { ReportInterpretation } from "../src/agents/report-interpretation-agent.js";
import type { CandidateIncidentMatch } from "../src/services/semantic-retrieval-service.js";
import type { NineRouterConfig } from "../src/providers/ninerouter-adapter.js";
import {
  assessAutoPublication,
  type AutoPublicationGateOptions,
} from "../../worker/src/layers/l4-application-integration/publication-policy.js";
import { createMockInterpreterAgent } from "./mock-agents.js";

const NOW = "2026-11-19T04:00:00.000Z";
const REGISTRY_TRACE = "trace-st12-registry";
const SOURCE_A = "source-st12-a";
const SOURCE_B = "source-st12-b";
const DISPLAY_NAME: Record<string, string> = { [SOURCE_A]: "Outlet Uji A", [SOURCE_B]: "Outlet Uji B" };
const GATE: AutoPublicationGateOptions = { publicDisplaySourceIds: new Set([SOURCE_A, SOURCE_B]) };
const MOCK_CONFIG: NineRouterConfig = {
  baseUrl: "http://127.0.0.1:9090",
  apiKey: "",
  chatModel: "Waspada-Jakarta",
  embeddingModel: "gemini/gemini-embedding-2-preview",
  embeddingDimensions: 768,
  executionMode: "mock",
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Metres between two [longitude, latitude] points. Equirectangular, good enough for a few hundred metres. */
function metresApart(a: [number, number], b: [number, number]): number {
  const metresPerDegreeLat = 110_574;
  const metresPerDegreeLon = 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * metresPerDegreeLon, (b[1] - a[1]) * metresPerDegreeLat);
}

const correlationDefaults: IncidentCorrelation = {
  decision: "new_incident",
  candidateIncidentId: null,
  reasoning: "Keputusan uji untuk ST-F-12.",
  supportingEvidence: [],
  contradictoryEvidence: [],
  distinctions: [],
  unresolvedQuestions: [],
  uncertainty: [],
  has_discrepancy: false,
  discrepancy_summary: null,
};

/** A correlator stub that returns one fixed decision and keeps every prompt it was sent. */
function correlatorStub(decision: Partial<IncidentCorrelation>): { readonly agent: Agent; readonly prompts: string[] } {
  const prompts: string[] = [];
  const agent = {
    generate: async (prompt: string) => {
      prompts.push(prompt);
      return { text: JSON.stringify({ ...correlationDefaults, ...decision }) };
    },
  } as unknown as Agent;
  return { agent, prompts };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure: candidate validation (no database)
// ---------------------------------------------------------------------------------------------------------------------

describe("ST-F-12 live correlation: candidate validation (pure)", () => {
  const interpretation: ReportInterpretation = {
    summary: "Genangan 60 cm di Jalan Rasuna Said",
    incidentType: "genangan_air_luapan_saluran",
    severity: "high",
    primaryCategory: "disasters_weather",
    location: { label: "Jl Rasuna Said", approximateCoordinates: [106.83, -6.22], precision: "exact" },
    eventTime: { precision: "exact", value: "2026-10-31T14:30:00Z" },
    entities: [],
    impacts: [],
    operationalStatus: "active",
    evidence: [],
    conflictingInfo: [],
    uncertaintyNotes: [],
    confidence: "high",
  };
  const retrieved: CandidateIncidentMatch = {
    incident: {
      incidentId: "inc-st12-retrieved-001",
      datasetKind: "synthetic",
      title: "Genangan Kuningan",
      description: "Genangan air di kawasan Kuningan",
      incidentType: "genangan_air_luapan_saluran",
      status: "active",
      severity: "high",
      primaryCategory: "disasters_weather",
      locationLabel: "Kuningan",
      coordinates: [106.83, -6.22],
      eventTime: {},
      firstObservedAt: "2026-10-31T14:00:00Z",
      lastUpdatedAt: "2026-10-31T14:00:00Z",
      discrepancies: [],
      uncertaintyNotes: [],
      recordJson: {},
      createdAt: "2026-10-31T14:00:00Z",
    },
    similarityScore: 0.88,
    matchedChunkId: "chk-st12-retrieved-1",
    matchedText: "Genangan air di kawasan Kuningan setinggi 50cm",
    matchedReportRevisionId: "rev-st12-retrieved-1",
  };
  const input: CorrelateIncidentInput = {
    incomingReportRevisionId: "rev-st12-incoming",
    incomingReportText: "Banjir setinggi 60cm merendam Jalan Rasuna Said.",
    incomingInterpretation: interpretation,
    candidateIncidents: [retrieved],
  };
  const sameIncident = (candidateIncidentId: string): IncidentCorrelation => ({
    ...correlationDefaults,
    decision: "same_incident",
    candidateIncidentId,
    reasoning: "Uji validasi kandidat.",
  });

  it("ST-F-12: validation refuses a same_incident link whose candidate id is not among retrieved candidates", () => {
    assert.throws(
      () => validateCorrelationDecision(sameIncident("inc-st12-not-retrieved"), input),
      (error: unknown) => error instanceof CorrelationValidationError && error.message === "candidate_incident_unknown",
    );
    assert.doesNotThrow(() => validateCorrelationDecision(sameIncident(retrieved.incident.incidentId), input));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Database: the live workflow
// ---------------------------------------------------------------------------------------------------------------------

interface ReportFixture {
  readonly revisionId: string;
  readonly sourceId: string;
  readonly url: string;
  /** The report text: the sentences joined by spaces. Each sentence is one evidence chunk. */
  readonly sentences: readonly string[];
}

interface WorkflowChunk {
  readonly chunkId: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly text: string;
}

function reportText(report: ReportFixture): string {
  return report.sentences.join(" ");
}

function traceFor(report: ReportFixture): string {
  return `trace-${report.revisionId}`;
}

function chunkIdFor(report: ReportFixture, index: number): string {
  return `chk-${report.revisionId}-${index + 1}`;
}

function incidentIdFor(report: ReportFixture): string {
  return `inc-${report.revisionId}`;
}

/**
 * The interpreter's answer for a report. `supports` gives one claim per cited sentence, in order. An empty list means the
 * report cites no evidence.
 */
function interpretationOf(
  report: ReportFixture,
  fields: {
    readonly summary: string;
    readonly incidentType: string;
    readonly location: ReportInterpretation["location"];
    readonly eventTime?: ReportInterpretation["eventTime"];
    readonly supports: readonly string[];
  },
): Partial<ReportInterpretation> {
  return {
    summary: fields.summary,
    incidentType: fields.incidentType,
    severity: "medium",
    primaryCategory: "disasters_weather",
    location: fields.location,
    eventTime: fields.eventTime ?? { value: null, precision: "unknown" },
    evidence: fields.supports.map((supports, index) => ({
      chunkId: chunkIdFor(report, index),
      exactQuote: report.sentences[index]!,
      supports,
    })),
    confidence: "high",
  };
}

const PLACE_NONE: ReportInterpretation["location"] = { label: null, approximateCoordinates: null, precision: "unknown" };

function placeAt(label: string, coordinates: [number, number]): ReportInterpretation["location"] {
  return { label, approximateCoordinates: coordinates, precision: "approximate" };
}

describe("ST-F-12 live correlation: the workflow on the live path (database)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    const ports = createRepositoryPorts(db.executor);
    await ports.tracesAndAudit.createTrace({
      traceId: REGISTRY_TRACE,
      datasetKind: "live",
      startedAt: NOW,
      endedAt: null,
      outcome: "open",
      metadata: { fixture: "authored-synthetic-only" },
    });
    for (const sourceId of [SOURCE_A, SOURCE_B]) {
      await db.executor.query(
        `INSERT INTO waspada.source_registry
           (source_id, trace_id, registry_version, display_name, source_kind, remit, access_method,
            approved_hosts, access_restrictions, reuse_basis, registry_status, approval_status,
            health_status, auto_acquisition_enabled, auto_publication_policy)
         VALUES ($1, $2, 1, $3, 'other', ARRAY['fixture'], 'manual_fixture',
            ARRAY[]::text[], ARRAY['fictional'], ARRAY['public_display'], 'active', 'approved',
            'healthy', true, 'never')`,
        [sourceId, REGISTRY_TRACE, DISPLAY_NAME[sourceId]],
      );
    }
  });

  after(async () => {
    await db?.close();
  });

  async function count(sql: string, params: readonly unknown[]): Promise<number> {
    const result = await db.executor.query<{ n: number }>(sql, [...params]);
    return result.rows[0]?.n ?? -1;
  }

  async function liveIncidentCount(): Promise<number> {
    return count("SELECT COUNT(*)::int AS n FROM waspada.incidents WHERE dataset_kind = 'live'", []);
  }

  /** Writes the trace, the live report revision and one evidence chunk per sentence. Returns the workflow chunks. */
  async function seedReport(report: ReportFixture): Promise<readonly WorkflowChunk[]> {
    const ports = createRepositoryPorts(db.executor);
    const traceId = traceFor(report);
    const text = reportText(report);
    const textHash = sha256(text);
    await ports.tracesAndAudit.createTrace({
      traceId,
      datasetKind: "live",
      startedAt: NOW,
      endedAt: null,
      outcome: "open",
      metadata: { fixture: "authored-synthetic-only" },
    });
    const revision: NewReportRevision = {
      datasetKind: "live",
      reportRevisionId: report.revisionId,
      traceId,
      sourceId: report.sourceId,
      canonicalUrl: report.url,
      sourceRevisionKey: null,
      contentHash: textHash,
      permittedText: text,
      permittedTextHash: textHash,
      normalizationVersion: "st12-live-correlation-v1",
      publishedAt: null,
      observedAt: null,
      retrievedAt: NOW,
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      revisionStatus: "eligible",
      recordJson: { fixture: "authored-synthetic-only" },
    };
    await ports.reportRevisions.create(revision);
    const chunks = report.sentences.map((sentence, index): WorkflowChunk => {
      const spanStart = text.indexOf(sentence);
      assert.ok(spanStart >= 0, "each evidence chunk is a sentence of the report text");
      return { chunkId: chunkIdFor(report, index), spanStart, spanEnd: spanStart + sentence.length, text: sentence };
    });
    for (const chunk of chunks) {
      await db.executor.query(
        `INSERT INTO waspada.evidence_chunks
           (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash,
            span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
         VALUES ('live', $1, $2, $3, $4, $5, $6, 'unicode_code_points', 'v1', $7, 'active')`,
        [chunk.chunkId, traceId, report.revisionId, textHash, chunk.spanStart, chunk.spanEnd, sha256(chunk.text)],
      );
    }
    return chunks;
  }

  async function executeLive(
    report: ReportFixture,
    chunks: readonly WorkflowChunk[],
    interpreter: Partial<ReportInterpretation>,
    correlator: Agent,
    job?: { readonly jobId: string; readonly leaseToken: string },
  ) {
    const workflow = createIncidentIntelligenceWorkflow({
      executor: db.executor,
      config: MOCK_CONFIG,
      agentOverrides: { interpreter: createMockInterpreterAgent(interpreter), correlator },
    });
    return (await workflow.createRun()).start({
      inputData: {
        ...(job ?? {}),
        reportRevisionId: report.revisionId,
        reportText: reportText(report),
        sourceKind: "rss",
        sourceDisplayName: DISPLAY_NAME[report.sourceId]!,
        sourceId: report.sourceId,
        sourceUrl: report.url,
        publishedAt: NOW,
        datasetKind: "live",
        traceId: traceFor(report),
        evidenceChunks: [...chunks],
      },
    });
  }

  async function runLive(
    report: ReportFixture,
    interpreter: Partial<ReportInterpretation>,
    correlator: Agent,
  ) {
    const chunks = await seedReport(report);
    const execution = await executeLive(report, chunks, interpreter, correlator);
    assert.equal(execution.status, "success", JSON.stringify(execution.steps ?? {}));
    return execution.result as unknown as IncidentWorkflowOutput;
  }

  async function claimLabels(proposalId: string): Promise<readonly string[]> {
    const rows = await db.executor.query<{ evidence_label: string }>(
      "SELECT evidence_label FROM waspada.proposal_claims WHERE dataset_kind = 'live' AND proposal_id = $1",
      [proposalId],
    );
    return rows.rows.map((row) => row.evidence_label);
  }

  async function inModeratorQueue(proposalId: string): Promise<boolean> {
    const pending = await createEventProposalWriter(db.executor).readPendingProposals("live");
    return pending.some((proposal) => proposal.proposal_id === proposalId);
  }

  async function assertNothingWritten(report: ReportFixture): Promise<void> {
    assert.equal(
      await count("SELECT COUNT(*)::int AS n FROM waspada.event_proposals WHERE dataset_kind = 'live' AND trace_id = $1", [traceFor(report)]),
      0,
      "no proposal is written for the refused report",
    );
    assert.equal(
      await count("SELECT COUNT(*)::int AS n FROM waspada.incident_reports WHERE dataset_kind = 'live' AND report_revision_id = $1", [report.revisionId]),
      0,
      "no incident link is written for the refused report",
    );
    assert.equal(
      await count("SELECT COUNT(*)::int AS n FROM waspada.incident_correlation_decisions WHERE dataset_kind = 'live' AND report_revision_id = $1", [report.revisionId]),
      0,
      "no correlation decision is written for the refused report",
    );
    assert.equal(
      await count("SELECT COUNT(*)::int AS n FROM waspada.incidents WHERE dataset_kind = 'live' AND incident_id = $1", [incidentIdFor(report)]),
      0,
      "no incident of its own is created for the refused report",
    );
  }

  // Fixtures. Places and street names differ from test to test (see the file header).
  const ZERO_CANDIDATES: ReportFixture = {
    revisionId: "rev-st12-zero-1",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/zero-1",
    sentences: ["Genangan air setinggi 40 cm di Jalan Veteran, Gambir, Jakarta Pusat, Selasa 17 November 2026."],
  };
  const COPY_ORIGINAL: ReportFixture = {
    revisionId: "rev-st12-copy-1",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/copy-1",
    sentences: ["Genangan 50 cm di Jalan DI Panjaitan, Cawang, Jakarta Timur, Senin 16 November 2026 pagi."],
  };
  const COPY_REPOST: ReportFixture = {
    revisionId: "rev-st12-copy-2",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/copy-2",
    sentences: ["Genangan 50 cm di Jalan DI Panjaitan, Cawang, Jakarta Timur, dilaporkan ulang sore hari."],
  };
  const COPY_OTHER_OUTLET: ReportFixture = {
    revisionId: "rev-st12-copy-3",
    sourceId: SOURCE_B,
    url: "https://example.test/st12/copy-3",
    sentences: ["Genangan 50 cm di Jalan DI Panjaitan, Cawang, Jakarta Timur, menurut laporan Outlet B."],
  };
  const ARTICLE_REPEATS: ReportFixture = {
    revisionId: "rev-st12-article-1",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/article-1",
    sentences: [
      "Pohon tumbang menutup lajur kiri Jalan Lapangan Banteng, Sawah Besar, Jakarta Pusat.",
      "Lajur kiri Jalan Lapangan Banteng tertutup pohon tumbang sejak pagi.",
      "Jalur kiri Lapangan Banteng ditutup pohon tumbang menurut petugas.",
    ],
  };
  const NEAR_FLOOD: ReportFixture = {
    revisionId: "rev-st12-near-1",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/near-1",
    sentences: ["Genangan setinggi 40 cm merendam Jalan Pahlawan Revolusi di Pulogadung, Jakarta Timur, Senin 16 November 2026 pagi."],
  };
  const NEAR_TREE: ReportFixture = {
    revisionId: "rev-st12-near-2",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/near-2",
    sentences: ["Pohon tumbang menutup lajur Jalan Penggilingan di Pulogadung, Jakarta Timur, Senin 16 November 2026 siang."],
  };
  const NO_CANDIDATE_ID_FIRST: ReportFixture = {
    revisionId: "rev-st12-kiln-1",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/kiln-1",
    sentences: ["Kebakaran gudang di Jalan Kramat Raya, Senen, Jakarta Pusat, Rabu 18 November 2026."],
  };
  const NO_CANDIDATE_ID_SECOND: ReportFixture = {
    revisionId: "rev-st12-kiln-2",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/kiln-2",
    sentences: ["Kebakaran gudang di Jalan Kramat Raya, Senen, Jakarta Pusat masih berasap, Rabu 18 November 2026 sore."],
  };
  const UNRETRIEVED_FIRST: ReportFixture = {
    revisionId: "rev-st12-market-1",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/market-1",
    sentences: ["Kebakaran pasar di Jalan Bendungan Hilir, Tanah Abang, Jakarta Pusat, Kamis 19 November 2026."],
  };
  const UNRETRIEVED_SECOND: ReportFixture = {
    revisionId: "rev-st12-market-2",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/market-2",
    sentences: ["Kebakaran pasar di Jalan Bendungan Hilir, Tanah Abang, Jakarta Pusat, Kamis 19 November 2026 sore."],
  };
  const NO_LOCATION: ReportFixture = {
    revisionId: "rev-st12-noloc-1",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/noloc-1",
    sentences: ["Penumpang terluka dalam kecelakaan bus pagi tadi."],
  };
  const LOCATED_CONTROL: ReportFixture = {
    revisionId: "rev-st12-control-1",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/control-1",
    sentences: ["Genangan 30 cm di Jalan Mampang Prapatan, Tendean, Jakarta Selatan, Kamis 19 November 2026."],
  };
  const UNRESOLVED_FIRST: ReportFixture = {
    revisionId: "rev-st12-queue-1",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/queue-1",
    sentences: ["Antrean kendaraan panjang di Jalan Gatot Subroto, Kuningan, Jakarta Selatan, Rabu 18 November 2026."],
  };
  const UNRESOLVED_SECOND: ReportFixture = {
    revisionId: "rev-st12-queue-2",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/queue-2",
    sentences: ["Antrean kendaraan panjang di Jalan Gatot Subroto, Kuningan, Jakarta Selatan belum terurai, Rabu 18 November 2026 malam."],
  };
  const NO_EVIDENCE: ReportFixture = {
    revisionId: "rev-st12-noevidence-1",
    sourceId: SOURCE_A,
    url: "https://example.test/st12/noevidence-1",
    sentences: ["Kecelakaan bus di Terminal Kampung Melayu, Jakarta Timur, Kamis 19 November 2026 pagi."],
  };
  const JOB_CITED: ReportFixture = {
    revisionId: "rev-st12-job-1",
    sourceId: SOURCE_B,
    url: "https://example.test/st12/job-1",
    sentences: ["Kecelakaan truk di Jalan Ahmad Yani, Kampung Melayu, Jakarta Timur, Kamis 19 November 2026 siang."],
  };

  it("ST-F-12: a report with no candidate incident becomes its own incident, without a model call", async () => {
    assert.equal(await liveIncidentCount(), 0, "this test runs first, on an empty live incident table");
    const correlator = correlatorStub({ decision: "new_incident" });
    const result = await runLive(
      ZERO_CANDIDATES,
      interpretationOf(ZERO_CANDIDATES, {
        summary: "Genangan air setinggi 40 cm di Jalan Veteran",
        incidentType: "genangan_air_luapan_saluran",
        location: placeAt("Jl. Veteran, Gambir, Jakarta Pusat", [106.829, -6.17]),
        supports: ["Genangan air setinggi 40 cm di Jalan Veteran"],
      }),
      correlator.agent,
    );
    assert.deepEqual(correlator.prompts, [], "with no candidate, the correlator is not called");
    assert.equal(result.correlation.decision, "new_incident");
    assert.equal(result.incident.incidentId, incidentIdFor(ZERO_CANDIDATES));
    assert.equal(result.proposal!.proposal_id, `prop-${incidentIdFor(ZERO_CANDIDATES)}`);
    assert.equal(result.proposal!.correlation_relationship, "primary_initial");
    assert.equal(await liveIncidentCount(), 1);
  });

  it("ST-F-12: a syndicated copy from the same publisher does not raise corroboration", async () => {
    const original = await runLive(
      COPY_ORIGINAL,
      interpretationOf(COPY_ORIGINAL, {
        summary: "Genangan 50 cm di Jalan DI Panjaitan Cawang",
        incidentType: "genangan_air_luapan_saluran",
        location: placeAt("Jl. DI Panjaitan, Cawang, Jakarta Timur", [106.871, -6.244]),
        supports: ["Genangan 50 cm di Jalan DI Panjaitan, Cawang"],
      }),
      correlatorStub({ decision: "new_incident" }).agent,
    );
    const originalIncidentId = original.incident.incidentId;

    const repostStub = correlatorStub({ decision: "same_incident", candidateIncidentId: originalIncidentId });
    const repost = await runLive(
      COPY_REPOST,
      interpretationOf(COPY_REPOST, {
        summary: "Genangan 50 cm di Jalan DI Panjaitan Cawang",
        incidentType: "genangan_air_luapan_saluran",
        location: placeAt("Jl. DI Panjaitan, Cawang, Jakarta Timur", [106.871, -6.244]),
        supports: ["Genangan 50 cm di Jalan DI Panjaitan, Cawang"],
      }),
      repostStub.agent,
    );
    assert.equal(repostStub.prompts.length, 1, "the original is offered to the correlator as a candidate");
    assert.ok(repostStub.prompts[0]!.includes(originalIncidentId));
    assert.equal(repost.proposal!.correlation_relationship, "corroborating");
    assert.equal(repost.proposal!.source_count, 1, "a repost from the same publisher counts once");
    assert.equal(repost.proposal!.is_multi_source, false);
    assert.deepEqual([...new Set(repost.proposal!.claims.map((claim) => claim.source_id))], [SOURCE_A]);
    assert.ok((await claimLabels(repost.proposal!.proposal_id)).every((label) => label === "attributed_report"),
      "a copy never gets independent_corroboration");

    // Control: a different publisher with the same statement is a second publisher, so the count does move.
    const otherOutlet = await runLive(
      COPY_OTHER_OUTLET,
      interpretationOf(COPY_OTHER_OUTLET, {
        summary: "Genangan 50 cm di Jalan DI Panjaitan Cawang",
        incidentType: "genangan_air_luapan_saluran",
        location: placeAt("Jl. DI Panjaitan, Cawang, Jakarta Timur", [106.871, -6.244]),
        supports: ["Genangan 50 cm di Jalan DI Panjaitan, Cawang"],
      }),
      correlatorStub({ decision: "same_incident", candidateIncidentId: originalIncidentId }).agent,
    );
    assert.equal(otherOutlet.proposal!.source_count, 2);
    assert.equal(otherOutlet.proposal!.is_multi_source, true);
  });

  it("ST-F-12: a statement repeated across chunks of one article is one claim and does not raise corroboration", async () => {
    const result = await runLive(
      ARTICLE_REPEATS,
      interpretationOf(ARTICLE_REPEATS, {
        summary: "Pohon tumbang menutup lajur kiri Jalan Lapangan Banteng",
        incidentType: "pohon_tumbang",
        location: placeAt("Jl. Lapangan Banteng, Sawah Besar, Jakarta Pusat", [106.8285, -6.1705]),
        supports: [
          "Pohon tumbang menutup lajur kiri Jalan Lapangan Banteng",
          "Pohon tumbang menutup lajur kiri Jalan Lapangan Banteng",
          "Pohon tumbang menutup lajur kiri Jalan Lapangan Banteng",
        ],
      }),
      correlatorStub({ decision: "new_incident" }).agent,
    );
    assert.equal(result.proposal!.claims.length, 1, "the same statement from one article is one claim");
    assert.equal(result.proposal!.claims[0]!.evidence_ref_id, chunkIdFor(ARTICLE_REPEATS, 0));
    assert.equal(result.proposal!.source_count, 1);
    assert.equal(result.proposal!.is_multi_source, false);
  });

  it("ST-F-12: nearby distinct incidents stay separate when the correlator says new_incident", async () => {
    const floodLocation = placeAt("Jl. Pahlawan Revolusi, Pulogadung, Jakarta Timur", [106.9005, -6.1885]);
    const treeLocation = placeAt("Jl. Penggilingan, Pulogadung, Jakarta Timur", [106.9035, -6.1905]);
    assert.ok(metresApart(floodLocation.approximateCoordinates!, treeLocation.approximateCoordinates!) > 100
      && metresApart(floodLocation.approximateCoordinates!, treeLocation.approximateCoordinates!) < 800,
    "the two places are a few hundred metres apart");

    const eventDay: ReportInterpretation["eventTime"] = { value: "2026-11-16", precision: "date" };
    const flood = await runLive(
      NEAR_FLOOD,
      interpretationOf(NEAR_FLOOD, {
        summary: "Genangan setinggi 40 cm merendam Jalan Pahlawan Revolusi",
        incidentType: "genangan_air_luapan_saluran",
        location: floodLocation,
        eventTime: eventDay,
        supports: ["Genangan setinggi 40 cm merendam Jalan Pahlawan Revolusi"],
      }),
      correlatorStub({ decision: "new_incident" }).agent,
    );

    const treeStub = correlatorStub({ decision: "new_incident", candidateIncidentId: null });
    const tree = await runLive(
      NEAR_TREE,
      interpretationOf(NEAR_TREE, {
        summary: "Pohon tumbang menutup lajur Jalan Penggilingan",
        incidentType: "pohon_tumbang",
        location: treeLocation,
        eventTime: eventDay,
        supports: ["Pohon tumbang menutup lajur Jalan Penggilingan"],
      }),
      treeStub.agent,
    );

    assert.equal(treeStub.prompts.length, 1, "the nearby incident was offered to the correlator as a candidate");
    assert.ok(treeStub.prompts[0]!.includes(incidentIdFor(NEAR_FLOOD)));
    assert.equal(tree.correlation.decision, "new_incident");
    assert.equal(tree.incident.incidentId, incidentIdFor(NEAR_TREE));
    assert.notEqual(tree.incident.incidentId, flood.incident.incidentId);
    assert.equal(tree.proposal!.correlation_relationship, "primary_initial");
    assert.equal(tree.proposal!.event_time.value, "2026-11-16", "both reports state the same day");
    assert.equal(flood.proposal!.event_time.value, "2026-11-16");
    for (const report of [NEAR_FLOOD, NEAR_TREE]) {
      assert.equal(
        await count("SELECT COUNT(*)::int AS n FROM waspada.incident_reports WHERE dataset_kind = 'live' AND report_revision_id = $1 AND incident_id = $2", [report.revisionId, incidentIdFor(report)]),
        1,
        "each report is linked to its own incident only",
      );
    }
  });

  it("ST-F-12: a same_incident link without a candidate id is refused and writes nothing", async () => {
    await runLive(
      NO_CANDIDATE_ID_FIRST,
      interpretationOf(NO_CANDIDATE_ID_FIRST, {
        summary: "Kebakaran gudang di Jalan Kramat Raya",
        incidentType: "kebakaran_gedung",
        location: placeAt("Jl. Kramat Raya, Senen, Jakarta Pusat", [106.8430, -6.1790]),
        supports: ["Kebakaran gudang di Jalan Kramat Raya"],
      }),
      correlatorStub({ decision: "new_incident" }).agent,
    );
    const incidentsBefore = await liveIncidentCount();

    const linked = correlatorStub({ decision: "same_incident", candidateIncidentId: null });
    const execution = await seedReport(NO_CANDIDATE_ID_SECOND).then((chunks) =>
      executeLive(
        NO_CANDIDATE_ID_SECOND,
        chunks,
        interpretationOf(NO_CANDIDATE_ID_SECOND, {
          summary: "Kebakaran gudang di Jalan Kramat Raya masih berasap",
          incidentType: "kebakaran_gedung",
          location: placeAt("Jl. Kramat Raya, Senen, Jakarta Pusat", [106.8430, -6.1790]),
          supports: ["Kebakaran gudang di Jalan Kramat Raya masih berasap"],
        }),
        linked.agent,
      ),
    );
    assert.equal(linked.prompts.length, 1, "a candidate was offered, so the refusal comes from the validation of the link");
    assert.notEqual(execution.status, "success", "a same_incident link must name a candidate");
    await assertNothingWritten(NO_CANDIDATE_ID_SECOND);
    assert.equal(await liveIncidentCount(), incidentsBefore);
  });

  it("ST-F-12: a same_incident link to a candidate that was not retrieved writes nothing", async () => {
    await runLive(
      UNRETRIEVED_FIRST,
      interpretationOf(UNRETRIEVED_FIRST, {
        summary: "Kebakaran pasar di Jalan Bendungan Hilir",
        incidentType: "kebakaran_pasar",
        location: placeAt("Jl. Bendungan Hilir, Tanah Abang, Jakarta Pusat", [106.8165, -6.2085]),
        supports: ["Kebakaran pasar di Jalan Bendungan Hilir"],
      }),
      correlatorStub({ decision: "new_incident" }).agent,
    );
    const incidentsBefore = await liveIncidentCount();

    const linked = correlatorStub({ decision: "same_incident", candidateIncidentId: "inc-st12-not-retrieved-999" });
    const chunks = await seedReport(UNRETRIEVED_SECOND);
    const execution = await executeLive(
      UNRETRIEVED_SECOND,
      chunks,
      interpretationOf(UNRETRIEVED_SECOND, {
        summary: "Kebakaran pasar di Jalan Bendungan Hilir sore hari",
        incidentType: "kebakaran_pasar",
        location: placeAt("Jl. Bendungan Hilir, Tanah Abang, Jakarta Pusat", [106.8165, -6.2085]),
        supports: ["Kebakaran pasar di Jalan Bendungan Hilir sore hari"],
      }),
      linked.agent,
    );
    assert.equal(linked.prompts.length, 1, "the retrieved candidate was offered before the link was checked");
    assert.notEqual(execution.status, "success", "a same_incident link must pass validation against the retrieved candidates");
    await assertNothingWritten(UNRETRIEVED_SECOND);
    assert.equal(
      await count("SELECT COUNT(*)::int AS n FROM waspada.incident_reports WHERE dataset_kind = 'live' AND incident_id = 'inc-st12-not-retrieved-999'", []),
      0,
      "the unretrieved candidate id gets no link",
    );
    assert.equal(await liveIncidentCount(), incidentsBefore);
  });

  it("ST-F-12: a report with no usable location is held for a moderator and is never labelled corroborated", async () => {
    // Control first: a located report from a permitted source passes the automatic gate, so the hold below is due to the location.
    const control = await runLive(
      LOCATED_CONTROL,
      interpretationOf(LOCATED_CONTROL, {
        summary: "Genangan 30 cm di Jalan Mampang Prapatan",
        incidentType: "genangan_air_luapan_saluran",
        location: placeAt("Jl. Mampang Prapatan, Tendean, Jakarta Selatan", [106.8160, -6.2550]),
        eventTime: { value: "2026-11-19", precision: "date" },
        supports: ["Genangan 30 cm di Jalan Mampang Prapatan"],
      }),
      correlatorStub({ decision: "new_incident" }).agent,
    );
    assert.deepEqual(assessAutoPublication(control.proposal, GATE), [], "control: a located, supported report is not held");

    const unlocated = correlatorStub({
      decision: "unresolved",
      candidateIncidentId: null,
      unresolvedQuestions: ["Lokasi kejadian tidak dinyatakan dalam laporan."],
    });
    const result = await runLive(
      NO_LOCATION,
      interpretationOf(NO_LOCATION, {
        summary: "Penumpang terluka dalam kecelakaan bus",
        incidentType: "kecelakaan_bus",
        location: PLACE_NONE,
        supports: ["Penumpang terluka dalam kecelakaan bus"],
      }),
      unlocated.agent,
    );
    const proposal = result.proposal!;
    assert.equal(proposal.location_label, null);
    assert.equal(proposal.coordinates, null);
    const reasons = assessAutoPublication(proposal, GATE);
    assert.ok(reasons.includes("location_missing"), `held for a moderator, reasons: ${reasons.join(", ")}`);
    assert.ok(await inModeratorQueue(proposal.proposal_id), "the held proposal waits in the moderator queue");
    assert.ok((await claimLabels(proposal.proposal_id)).every((label) => label === "attributed_report"),
      "the claim is not labelled corroborated");
    assert.ok(proposal.claims.every((claim) => claim.evidence_label !== "independent_corroboration"));
  });

  it("ST-F-12: an unresolved correlation is held for a moderator and is never labelled corroborated", async () => {
    const first = await runLive(
      UNRESOLVED_FIRST,
      interpretationOf(UNRESOLVED_FIRST, {
        summary: "Antrean kendaraan panjang di Jalan Gatot Subroto",
        incidentType: "kemacetan_lalu_lintas",
        location: placeAt("Jl. Gatot Subroto, Kuningan, Jakarta Selatan", [106.8290, -6.2290]),
        supports: ["Antrean kendaraan panjang di Jalan Gatot Subroto"],
      }),
      correlatorStub({ decision: "new_incident" }).agent,
    );
    const candidateId = first.incident.incidentId;

    const unresolved = correlatorStub({ decision: "unresolved", candidateIncidentId: candidateId });
    const chunks = await seedReport(UNRESOLVED_SECOND);
    const execution = await executeLive(
      UNRESOLVED_SECOND,
      chunks,
      interpretationOf(UNRESOLVED_SECOND, {
        summary: "Antrean kendaraan panjang di Jalan Gatot Subroto belum terurai",
        incidentType: "kemacetan_lalu_lintas",
        location: placeAt("Jl. Gatot Subroto, Kuningan, Jakarta Selatan", [106.8290, -6.2290]),
        supports: ["Antrean kendaraan panjang di Jalan Gatot Subroto belum terurai"],
      }),
      unresolved.agent,
    );
    assert.equal(execution.status, "success", JSON.stringify(execution.steps ?? {}));
    assert.equal(unresolved.prompts.length, 1, "the earlier incident was offered as the candidate");
    const result = execution.result as unknown as IncidentWorkflowOutput;
    const proposal = result.proposal!;
    assert.equal(proposal.correlation_relationship, "unresolved");
    assert.equal(proposal.proposal_id, `prop-${candidateId}-${UNRESOLVED_SECOND.revisionId}`);
    const reasons = assessAutoPublication(proposal, GATE);
    assert.ok(reasons.includes("correlation_unresolved"), `held for a moderator, reasons: ${reasons.join(", ")}`);
    assert.ok(await inModeratorQueue(proposal.proposal_id), "the unresolved proposal waits in the moderator queue");
    assert.ok((await claimLabels(proposal.proposal_id)).every((label) => label === "attributed_report"),
      "the claim is not labelled corroborated");
    assert.ok(proposal.claims.every((claim) => claim.evidence_label !== "independent_corroboration"));
  });

  it("ST-F-12: the live path persists no investigation case, with or without cited evidence", async () => {
    async function investigationCounts(): Promise<Record<string, number>> {
      const tables = await db.executor.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'waspada' AND table_name LIKE 'investigation%' ORDER BY table_name",
      );
      const counts: Record<string, number> = {};
      for (const row of tables.rows) {
        counts[row.table_name] = await count(`SELECT COUNT(*)::int AS n FROM waspada.${row.table_name}`, []);
      }
      return counts;
    }

    const before = await investigationCounts();
    assert.ok(Object.keys(before).length >= 5, "the L3 investigation tables exist in the migrated schema");

    // A report with no cited evidence is the case an L3 investigation would take on in the Worker.
    const uncited = await runLive(
      NO_EVIDENCE,
      interpretationOf(NO_EVIDENCE, {
        summary: "Kecelakaan bus di Terminal Kampung Melayu",
        incidentType: "kecelakaan_bus",
        location: placeAt("Terminal Kampung Melayu, Jakarta Timur", [106.8660, -6.2180]),
        supports: [],
      }),
      correlatorStub({ decision: "new_incident" }).agent,
    );
    assert.ok(assessAutoPublication(uncited.proposal, GATE).includes("claim_unsupported"),
      "the uncited claim is held for a moderator, not investigated");

    // The same live path through a durable job lease, as the job runner calls it.
    const jobChunks = await seedReport(JOB_CITED);
    const jobId = "ai-job-st12-job-1";
    const incidentRepo = createSqlIncidentRepository(db.executor);
    await incidentRepo.enqueueAiJob({ jobId, datasetKind: "live", reportRevisionId: JOB_CITED.revisionId, traceId: traceFor(JOB_CITED) });
    const claim = await incidentRepo.claimAiJob({ datasetKind: "live", leaseDurationMs: 300_000 });
    assert.equal(claim?.job.jobId, jobId, "the job runner would claim this job");
    const job = await executeLive(
      JOB_CITED,
      jobChunks,
      interpretationOf(JOB_CITED, {
        summary: "Kecelakaan truk di Jalan Ahmad Yani",
        incidentType: "kecelakaan_lalu_lintas",
        location: placeAt("Jl. Ahmad Yani, Kampung Melayu, Jakarta Timur", [106.8660, -6.2240]),
        supports: ["Kecelakaan truk di Jalan Ahmad Yani"],
      }),
      correlatorStub({ decision: "new_incident" }).agent,
      { jobId, leaseToken: claim!.leaseToken },
    );
    assert.equal(job.status, "success", JSON.stringify(job.steps ?? {}));

    const after = await investigationCounts();
    assert.deepEqual(after, before, "no investigation row is written by either live branch");
    assert.ok(Object.values(after).every((n) => n === 0), "no investigation case exists after the live runs");
    assert.equal(
      await count("SELECT COUNT(*)::int AS n FROM waspada.event_proposals WHERE dataset_kind = 'live' AND investigation_id IS NOT NULL", []),
      0,
      "no proposal is linked to an investigation",
    );
  });

});
