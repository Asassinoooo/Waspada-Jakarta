import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import worker from "../src/index.js";
import { createAccountRuntime } from "../src/runtime/account-runtime.js";
import { PIPELINE_FLOW_NODE_IDS } from "../src/contracts/pipeline-flow.js";
import {
  AGENT_AUTO_PUBLISHER_ID,
  decideProposal,
  type ProposalDecisionDependencies,
} from "../src/layers/l4-application-integration/proposal-publication.js";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { seedProposalLineage, type ProposalLineage } from "../../db/test/proposal-lineage-fixture.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";
import { createEventProposalWriter, type EventProposalDto } from "../../db/src/event-proposal-writer.js";
import { PIPELINE_FLOW_DB_ITEM_NODES } from "../../db/src/pipeline-flow-store.js";
import { createRepositoryPorts } from "../../db/src/ports.js";

/**
 * ST-F-08 (docs/testing/SYSTEM-TEST.md): the moderator flow and the embedding view are read-only and show counts,
 * labels and timestamps. No body, claim, prompt or checkpoint text is returned.
 *
 * Each marker is written into one persisted store, then every serialized response is searched for it. The data is
 * authored and synthetic, on PGlite, through the real Worker fetch handler with real moderator and user sessions.
 *
 * The flow reader never selects report text, claim text or checkpoint JSON (migration 047 exposes only titles and a
 * has_interpretation flag). The embedding view does select the first 100 characters of the report text, as its
 * `title`. The embedding test below pins that exposure. It is an open owner decision, not a silent pass.
 */

const origin = "http://127.0.0.1:5173";
const password = "kata-sandi-2026";
const LINEAGE_KEY = "st-f-08";

const MARKER_BODY = "MARKER_BODY_7f3";
const MARKER_CLAIM = "MARKER_CLAIM_7f3";
const MARKER_PROMPT = "MARKER_PROMPT_7f3";
const MARKER_CKPT = "MARKER_CKPT_7f3";
const MARKERS = [MARKER_BODY, MARKER_CLAIM, MARKER_PROMPT, MARKER_CKPT] as const;

/** Longer than the 100-code-point title prefix, so the body marker sits after the part the embedding view shows. */
const BODY_HEAD = "Laporan warga dari Cawang: genangan air setinggi 60 cm menutup jalur kendaraan sejak dini hari, arus lalu lintas tersendat panjang.";
const BODY = `${BODY_HEAD} ${MARKER_BODY} sisa isi laporan.`;
const BODY_REVISION_ID = "rev-st-f-08-body";
const EMBEDDING_RUN_ID = "emb-st-f-08-body";
const CHUNK_ID = "chk-st-f-08-body";
const VECTOR_DIMENSIONS = 768;

const SNAPSHOT_KEYS = ["dataset_mode", "edges", "generated_at", "nodes", "runtime", "schema_version", "window", "window_hours"];
const NODE_KEYS = ["counts", "health", "id", "lane", "throughput_15m"];
const EDGE_KEYS = ["from", "throughput_15m", "to"];
const ITEMS_KEYS = ["dataset_mode", "generated_at", "items", "limit", "node_id", "schema_version", "unavailable_reason", "window"];
const ITEM_KEYS = ["at", "failure_code", "ref", "status", "title"];
/** The only drill-downs with a title. Every other node's titles must be null. */
const TITLED_NODES = new Set(["proposal", "review", "published"]);

interface SnapshotBody {
  readonly schema_version: string;
  readonly nodes: ReadonlyArray<{ readonly id: string; readonly counts: Record<string, unknown>; readonly [key: string]: unknown }>;
  readonly edges: ReadonlyArray<Record<string, unknown>>;
  readonly runtime: unknown;
  readonly [key: string]: unknown;
}

interface ItemsBody {
  readonly items: ReadonlyArray<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function vectorLiteral(): string {
  return `[${Array.from({ length: VECTOR_DIMENSIONS }, (_, index) => ((index % 7) - 3) / 10).join(",")}]`;
}

function assertNoMarkers(text: string, label: string): void {
  for (const marker of MARKERS) {
    assert.equal(text.includes(marker), false, `${label} must not carry ${marker}`);
  }
}

function proposalFor(incidentId: string, lineage: ProposalLineage, fields: Record<string, unknown> = {}): EventProposalDto {
  return {
    schema_version: "2.0",
    ...lineage,
    proposal_id: `prop-${incidentId}`,
    incident_id: incidentId,
    title: `Genangan di ${incidentId}`,
    incident_type: "genangan_air_luapan_saluran",
    primary_category: "disasters_weather",
    severity: "medium",
    event_time: { precision: "exact", value: "2026-11-10T08:00:00.000Z" },
    location_label: "Cawang, Jakarta Timur",
    coordinates: null,
    claims: [{
      claim_id: "claim-1",
      claim_text: `Genangan 50 cm di Cawang ${MARKER_CLAIM}`,
      evidence_label: "attributed_report",
      support_assessment: "supported",
      quote_text: "Genangan setinggi 50 cm",
      evidence_ref_id: `chk-${incidentId}`,
      source_id: "source-detik",
      outlet: "Detik News",
      source_url: "https://news.example/cawang",
    }],
    impacts: [],
    caveats: [],
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    correlation_relationship: "primary_initial",
    is_multi_source: false,
    source_count: 1,
    source_id: "source-detik",
    proposed_at: new Date().toISOString(),
    ...fields,
  } as unknown as EventProposalDto;
}

describe("ST-F-08 moderator flow and embedding view return no body, claim, prompt or checkpoint text", () => {
  let db: TestDatabase;
  let deps: ProposalDecisionDependencies;
  const cookies: Record<"user" | "moderator", string> = { user: "", moderator: "" };

  function env(): never {
    return {
      DATASET_MODE: "live",
      AUTH_ENABLED: "true",
      AUTH_APP_ORIGIN: origin,
      SQL_EXECUTOR: db.executor,
    } as never;
  }

  const get = (path: string, cookie?: string) => worker.fetch(new Request(`${origin}${path}`, {
    headers: cookie ? { cookie } : {},
  }), env());

  before(async () => {
    db = await createTestDatabase();
    await applyMigrations(db.executor, await readMigrations(new URL("../../db/migrations/", import.meta.url)));
    assert.ok(codePoints(BODY_HEAD) > 100, "the body head is longer than the 100-character title prefix");

    const lineage = await seedProposalLineage(db.executor, LINEAGE_KEY);
    const ports = createRepositoryPorts(db.executor);
    const now = new Date().toISOString();

    // Report body with the body marker: permitted text is the one column the embedding view reads.
    await ports.reportRevisions.create({
      datasetKind: "live",
      reportRevisionId: BODY_REVISION_ID,
      traceId: lineage.trace_id,
      sourceId: `source-lineage-${LINEAGE_KEY}`,
      canonicalUrl: "https://lineage.invalid/st-f-08-body",
      sourceRevisionKey: null,
      contentHash: sha256("st-f-08 payload"),
      permittedText: BODY,
      permittedTextHash: sha256(BODY),
      normalizationVersion: "st-f-08-fixture-v1",
      publishedAt: null,
      observedAt: null,
      retrievedAt: now,
      validFrom: null,
      validUntil: null,
      supersedesId: null,
      revisionStatus: "eligible",
      recordJson: { fixture: "authored-synthetic-only" },
    });

    // AI job with a checkpoint payload. The payload carries the checkpoint marker and a model-input marker. The schema
    // has no prompt column, so the model-input marker stands in for any prompt text a payload might hold.
    await db.executor.query(
      `INSERT INTO waspada.ai_jobs
         (job_id, dataset_kind, report_revision_id, status, attempt_count, max_attempts, available_at,
          trace_id, created_at, updated_at, checkpoint_json)
       VALUES ('job-st-f-08', 'live', $1, 'pending', 0, 5, $2::timestamptz, $3, $2::timestamptz, $2::timestamptz, $4::jsonb)`,
      [
        BODY_REVISION_ID,
        now,
        lineage.trace_id,
        JSON.stringify({ interpretation: { summary: `${MARKER_CKPT} ringkasan model`, model_input: `${MARKER_PROMPT} teks prompt` } }),
      ],
    );

    // One active chunk and one available embedding run with a 768-dimension vector, as the visualization reads them.
    // Chunk text is never stored (only its hash), so the chunk carries no marker of its own.
    const chunkHash = sha256(BODY);
    await db.executor.query(
      `INSERT INTO waspada.evidence_chunks
         (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash, span_start, span_end,
          offset_unit, chunker_version, chunk_text_hash, status)
       VALUES ('live', $1, $2, $3, $4, 0, $5, 'unicode_code_points', 'st-f-08-chunker-v1', $6, 'active')`,
      [CHUNK_ID, lineage.trace_id, BODY_REVISION_ID, sha256(BODY), codePoints(BODY), chunkHash],
    );
    await db.executor.query(
      `INSERT INTO waspada.embedding_runs
         (dataset_kind, embedding_run_id, trace_id, chunk_id, capability, provider, model_version, dimensions,
          distance_metric, vector_index_version, input_text_hash, status, created_at)
       VALUES ('live', $1, $2, $3, 'embedding', 'st-f-08-provider', 'st-f-08-model-v1', $4, 'cosine',
               'st-f-08-index-v1', $5, 'available', $6::timestamptz)`,
      [EMBEDDING_RUN_ID, lineage.trace_id, CHUNK_ID, VECTOR_DIMENSIONS, chunkHash, now],
    );
    await db.executor.query(
      `INSERT INTO waspada.embedding_vectors (dataset_kind, embedding_run_id, dimensions, embedding)
       VALUES ('live', $1, $2, $3::vector)`,
      [EMBEDDING_RUN_ID, VECTOR_DIMENSIONS, vectorLiteral()],
    );

    // A proposal waiting for a moderator (claim marker in its claim text), and one published by the automatic gate.
    deps = {
      executor: db.executor,
      datasetKind: "live",
      checkPublicDisplay: async () => true,
    };
    const writer = createEventProposalWriter(db.executor);
    await writer.persistProposal(
      proposalFor("inc-st08-pending", lineage, {
        has_discrepancy: true,
        discrepancies: [{ kind: "water_height", description: "50 cm vs 30 cm" }],
      }),
      "live",
    );
    await writer.persistProposal(proposalFor("inc-st08-published", lineage), "live");
    const published = await decideProposal(deps, {
      proposalId: "prop-inc-st08-published",
      action: "auto_publish",
      actor: { kind: "agent", actorId: AGENT_AUTO_PUBLISHER_ID },
    });
    assert.equal(published.status, "published", "the seeded automatic publication is public");

    // Accounts: a moderator and a registered user, both real sessions.
    const accounts = await createAccountRuntime(
      { DATASET_MODE: "live", AUTH_ENABLED: "true", AUTH_APP_ORIGIN: origin, SQL_EXECUTOR: db.executor },
      { trustedClientKey: () => "st-f-08-test" },
    );
    const post = (path: string, body: unknown) => accounts!(new Request(`${origin}${path}`, {
      method: "POST",
      headers: { origin, "x-waspada-request": "1", "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    for (const name of ["st08.user", "st08.moderator"]) {
      const res = await post("/api/v1/auth/register", { username: name, password });
      assert.equal(res?.status, 200, `${name} registers`);
    }
    await db.executor.query("UPDATE waspada.accounts SET role = 'moderator' WHERE username = 'st08.moderator'");
    for (const [key, name] of [["user", "st08.user"], ["moderator", "st08.moderator"]] as const) {
      const res = await post("/api/v1/auth/login", { username: name, password });
      assert.equal(res?.status, 200, `${name} signs in`);
      cookies[key] = (res?.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      assert.match(cookies[key], /^waspada_session_dev=/u);
    }
  });

  after(async () => db?.close());

  it("ST-F-08: control, each marker is stored in its table, so its absence from a response means something", async () => {
    const stored = async (statement: string, parameters: readonly unknown[] = []) => {
      const result = await db.executor.query<{ text: string }>(statement, parameters);
      return result.rows.map((row) => row.text).join("\n");
    };
    assert.ok((await stored("SELECT permitted_text AS text FROM waspada.report_revisions WHERE report_revision_id = $1", [BODY_REVISION_ID])).includes(MARKER_BODY), "body marker");
    const checkpoint = await stored("SELECT checkpoint_json::text AS text FROM waspada.ai_jobs WHERE job_id = 'job-st-f-08'");
    assert.ok(checkpoint.includes(MARKER_CKPT), "checkpoint marker");
    assert.ok(checkpoint.includes(MARKER_PROMPT), "model-input marker inside the checkpoint payload");
    assert.ok((await stored("SELECT record_json::text AS text FROM waspada.event_proposals WHERE proposal_id = 'prop-inc-st08-pending'")).includes(MARKER_CLAIM), "claim marker in a proposal");
    assert.ok((await stored("SELECT claim_text AS text FROM waspada.event_claims WHERE event_id = 'inc-st08-published'")).includes(MARKER_CLAIM), "claim marker in a published claim");
  });

  it("ST-F-08: the moderator flow snapshot carries counts, labels and timestamps, and no marker text", async () => {
    const res = await get("/api/v1/pipeline/flow", cookies.moderator);
    assert.equal(res.status, 200);
    const text = await res.text();
    assertNoMarkers(text, "the flow snapshot");

    const body = JSON.parse(text) as SnapshotBody;
    assert.deepEqual(Object.keys(body).sort(), SNAPSHOT_KEYS);
    assert.deepEqual(body.nodes.map((node) => node.id), [...PIPELINE_FLOW_NODE_IDS]);
    for (const node of body.nodes) {
      assert.deepEqual(Object.keys(node).sort(), NODE_KEYS, `${node.id} carries only its counts and labels`);
      for (const [key, value] of Object.entries(node.counts)) {
        assert.equal(typeof value, "number", `${node.id}.${key} is a number`);
      }
    }
    for (const edge of body.edges) assert.deepEqual(Object.keys(edge).sort(), EDGE_KEYS);
    assert.equal(body.runtime, null, "no runtime status is attached on the Worker path");

    // The seeded rows are visible as counts, so the snapshot is not empty by accident.
    const count = (id: string, key: string) => body.nodes.find((node) => node.id === id)?.counts[key];
    assert.ok((count("revisions", "eligible_24h") as number) >= 1, "the eligible report is counted");
    assert.ok((count("ai_queue", "pending") as number) >= 1, "the pending AI job is counted");
    assert.ok((count("interpret", "checkpointed_open") as number) >= 1, "the checkpoint is counted, never read");
    assert.ok((count("proposal", "proposed_24h") as number) >= 2, "both seeded proposals are counted");
    assert.ok((count("review", "waiting_discrepancy") as number) >= 1, "the discrepancy waiting for a moderator is counted");
    assert.ok((count("published", "events_published") as number) >= 1, "the automatic publication is counted");
  });

  it("ST-F-08: the flow answers only GET, so the view cannot write", async () => {
    const res = await worker.fetch(new Request(`${origin}/api/v1/pipeline/flow`, {
      method: "POST",
      headers: { cookie: cookies.moderator },
    }), env());
    assert.equal(res.status, 405);
    assertNoMarkers(await res.text(), "the refused write");
  });

  it("ST-F-08: every drill-down returns metadata rows only, and a title only on the proposal, review and published nodes", async () => {
    for (const nodeId of PIPELINE_FLOW_DB_ITEM_NODES) {
      const res = await get(`/api/v1/pipeline/flow/nodes/${nodeId}/items?limit=20`, cookies.moderator);
      assert.equal(res.status, 200, `${nodeId} answers`);
      const text = await res.text();
      assertNoMarkers(text, `the ${nodeId} drill-down`);

      const body = JSON.parse(text) as ItemsBody;
      assert.deepEqual(Object.keys(body).sort(), ITEMS_KEYS, `${nodeId} response keys`);
      for (const item of body.items) {
        assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS, `${nodeId} item keys`);
        if (!TITLED_NODES.has(nodeId)) assert.equal(item.title, null, `${nodeId} carries no title`);
        assert.ok(item.at === null || Number.isFinite(Date.parse(String(item.at))), `${nodeId} timestamp is ISO or null`);
      }
    }

    const proposals = await get("/api/v1/pipeline/flow/nodes/proposal/items?limit=20", cookies.moderator);
    const proposalBody = await proposals.json() as ItemsBody;
    const refs = proposalBody.items.map((item) => item.ref);
    assert.ok(refs.includes("prop-inc-st08-pending"), "the pending proposal is listed by ref");
    assert.ok(refs.includes("prop-inc-st08-published"), "the published proposal is listed by ref");
  });

  it("ST-F-08: the embedding view returns no chunk text and no body text past its 100-character title prefix", async () => {
    const res = await get("/api/v1/embeddings/visualization", cookies.moderator);
    assert.equal(res.status, 200);
    const text = await res.text();
    assertNoMarkers(text, "the embedding view");

    const body = JSON.parse(text) as { readonly datasetKind: string; readonly items: ReadonlyArray<Record<string, unknown>> };
    assert.equal(body.datasetKind, "live");
    const item = body.items.find((candidate) => candidate.embeddingRunId === EMBEDDING_RUN_ID);
    assert.ok(item, "the seeded embedding run is listed");
    assert.deepEqual(Object.keys(item).sort(), ["canonicalUrl", "chunkId", "createdAt", "embeddingRunId", "reportRevisionId", "sourceId", "title", "vector"]);
    assert.equal("chunkText" in item, false, "the chunk text is never returned");
    // Pinned current contract (not an approval): the title is the first 100 code points of the report text.
    assert.equal(item.title, Array.from(BODY).slice(0, 100).join("").trim());
    assert.equal((item.vector as number[]).length, VECTOR_DIMENSIONS, "the vector is returned to moderators by design");
  });

  it("ST-F-08: a non-moderator gets 401 or 403, and the refusal carries no text", async () => {
    for (const path of ["/api/v1/pipeline/flow", "/api/v1/pipeline/flow/nodes/proposal/items", "/api/v1/embeddings/visualization"]) {
      const anonymous = await get(path);
      assert.equal(anonymous.status, 401, `${path} refuses an anonymous caller`);
      assertNoMarkers(await anonymous.text(), `the ${path} refusal to an anonymous caller`);

      const user = await get(path, cookies.user);
      assert.equal(user.status, 403, `${path} refuses a registered user`);
      assertNoMarkers(await user.text(), `the ${path} refusal to a registered user`);
    }
  });
});
