import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import worker from "../src/index.js";
import type { WorkerEnvironment } from "../src/layers/l4-application-integration/api.js";
import { createTestDatabase, type TestDatabase } from "../../db/test/harness.js";
import { applyMigrations, readMigrations } from "../../db/src/migrations.js";

/**
 * F-05 (ST-F-11, FR-02 to FR-04): the webhook route storage path, database level. The request goes through the
 * Worker's real fetch handler to the inline storage block in apps/worker/src/index.ts, which runs after the
 * route answers 201. Its work is awaited through the waitUntil hook. The tests read the rows back from a migrated
 * PGlite database. The payloads are authored fixtures, and no network is used.
 */

const KEY = "webhook-db-fixture-key-000000000000";
const ROUTE = "http://localhost/api/v1/ingestion/events";
const SOURCE = "source-dishub-db";
const CAP_PUBLISHED = "2026-11-10T08:30:00+07:00";

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_id: SOURCE,
    title: "Genangan air di Kemang Raya",
    text: "Genangan setinggi lutut terlihat di Jalan Kemang Raya, lalu lintas melambat.",
    location_hint: "Cawang, Jakarta Timur",
    timestamp: CAP_PUBLISHED,
    ...overrides,
  };
}

describe("F-05 / ST-F-11: webhook route storage path (database)", () => {
  let db: TestDatabase;
  const env = (): WorkerEnvironment => ({
    WEBHOOK_SERVICE_KEY: KEY,
    DATASET_MODE: "live",
    SQL_EXECUTOR: db.executor,
  }) as unknown as WorkerEnvironment;

  /** Sends one request and waits for the storage work the route hands to waitUntil. */
  async function deliver(body: unknown, key: string | null = KEY): Promise<Response> {
    const pending: Promise<unknown>[] = [];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key !== null) headers["x-service-key"] = key;
    const response = await worker.fetch(
      new Request(ROUTE, { method: "POST", headers, body: JSON.stringify(body) }),
      env(),
      { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } },
    );
    await Promise.all(pending);
    return response;
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const result = await db.executor.query<{ n: number }>(sql, params);
    return result.rows[0]?.n ?? 0;
  }

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL("../../db/migrations/", import.meta.url));
    await applyMigrations(db.executor, migrations);
  });

  after(async () => {
    await db?.close();
  });

  it("a refused key answers 401 and writes no revision, chunk or AI job", async () => {
    const response = await deliver(event({ title: "Kunci salah" }), "kunci-salah");
    assert.equal(response.status, 401);
    assert.equal(await count(`SELECT COUNT(*)::int AS n FROM waspada.report_revisions WHERE dataset_kind = 'live' AND source_id = $1`, [SOURCE]), 0);
    assert.equal(await count(`SELECT COUNT(*)::int AS n FROM waspada.ai_jobs WHERE dataset_kind = 'live'`), 0);
  });

  it("a malformed event answers 400 and writes nothing, even though the same batch has a valid item", async () => {
    const response = await deliver({ events: [event({ title: "Valid dulu" }), event({ title: "" })] });
    assert.equal(response.status, 400);
    assert.equal(await count(`SELECT COUNT(*)::int AS n FROM waspada.report_revisions WHERE dataset_kind = 'live' AND source_id = $1`, [SOURCE]), 0);
    assert.equal(await count(`SELECT COUNT(*)::int AS n FROM waspada.ai_jobs WHERE dataset_kind = 'live'`), 0);
  });

  it("a valid event stores one revision with its chunks and queues exactly one AI job", async () => {
    const response = await deliver(event());
    assert.equal(response.status, 201);
    const body = (await response.json()) as { report_revision_id: string; proposal_id: string };
    const revisionId = body.report_revision_id;
    assert.match(revisionId, /^webhook-source-dishub-db-[0-9a-f]{16}$/u);

    const revision = await db.executor.query<{
      source_id: string;
      canonical_url: string;
      permitted_text: string;
      permitted_text_hash: string;
      published_at: string | null;
      revision_status: string;
      trace_id: string;
    }>(
      `SELECT source_id, canonical_url, permitted_text, permitted_text_hash, published_at::text AS published_at,
              revision_status, trace_id
       FROM waspada.report_revisions WHERE dataset_kind = 'live' AND report_revision_id = $1`,
      [revisionId],
    );
    assert.equal(revision.rows.length, 1, "one report revision is stored");
    const stored = revision.rows[0]!;
    assert.equal(stored.source_id, SOURCE);
    assert.match(stored.canonical_url, /^webhook:\/\/source-dishub-db\/[0-9a-f]{16}$/u);
    assert.match(stored.permitted_text, /Genangan air di Kemang Raya/u, "the title is part of the stored text");
    assert.match(stored.permitted_text, /Lokasi: Cawang, Jakarta Timur/u, "a location hint that the text does not name is appended to the stored text");
    assert.match(stored.permitted_text_hash, /^[0-9a-f]{64}$/u);
    assert.equal(stored.revision_status, "unreviewed", "a webhook revision starts unreviewed");
    assert.ok(stored.published_at && Date.parse(stored.published_at) === Date.parse(CAP_PUBLISHED),
      "the event's own timestamp is the publish time, as the same instant");
    assert.equal(stored.trace_id, `trace-${revisionId}`);

    const chunks = await db.executor.query<{ chunk_id: string; span_start: number; span_end: number; status: string }>(
      `SELECT chunk_id, span_start, span_end, status FROM waspada.evidence_chunks
       WHERE dataset_kind = 'live' AND report_revision_id = $1 ORDER BY span_start ASC`,
      [revisionId],
    );
    assert.ok(chunks.rows.length >= 1, "at least one evidence chunk is stored");
    assert.equal(chunks.rows[0]?.chunk_id, `chk-${revisionId}-0`);
    assert.equal(chunks.rows[0]?.span_start, 0);
    assert.ok(chunks.rows.every((row) => row.status === "active" && row.span_end > row.span_start));

    const jobs = await db.executor.query<{ status: string; max_attempts: number }>(
      `SELECT status, max_attempts FROM waspada.ai_jobs
       WHERE dataset_kind = 'live' AND report_revision_id = $1`,
      [revisionId],
    );
    assert.deepEqual(jobs.rows, [{ status: "pending", max_attempts: 5 }]);
    assert.ok(body.proposal_id.length > 0);
  });

  it("the webhook AI job carries the same trace id as its revision (FR-14)", async () => {
    const response = await deliver(event({
      title: "Jalur sepeda tergenang di Sudirman",
      text: "Jalur sepeda di Jalan Sudirman tergenang air setinggi mata kaki.",
      location_hint: "Sudirman",
      timestamp: "2026-11-10T10:00:00+07:00",
    }));
    const revisionId = ((await response.json()) as { report_revision_id: string }).report_revision_id;
    const linked = await db.executor.query<{ revision_trace: string; job_trace: string | null }>(
      `SELECT r.trace_id AS revision_trace, j.trace_id AS job_trace
       FROM waspada.report_revisions r JOIN waspada.ai_jobs j
         ON j.dataset_kind = r.dataset_kind AND j.report_revision_id = r.report_revision_id
       WHERE r.dataset_kind = 'live' AND r.report_revision_id = $1`,
      [revisionId],
    );
    assert.equal(linked.rows[0]?.job_trace, linked.rows[0]?.revision_trace);
  });

  it("the same event delivered again keeps one revision and one AI job, with the same identity", async () => {
    const first = (await (await deliver(event())).json()) as { report_revision_id: string };
    const second = await deliver(event());
    assert.equal(second.status, 201);
    const again = (await second.json()) as { report_revision_id: string };
    assert.equal(again.report_revision_id, first.report_revision_id, "identity comes from the source and the content");

    assert.equal(await count(`SELECT COUNT(*)::int AS n FROM waspada.report_revisions WHERE dataset_kind = 'live' AND report_revision_id = $1`, [first.report_revision_id]), 1);
    assert.equal(await count(`SELECT COUNT(*)::int AS n FROM waspada.ai_jobs WHERE dataset_kind = 'live' AND report_revision_id = $1`, [first.report_revision_id]), 1);
  });

  it("a valid batch stores each event as its own revision and AI job", async () => {
    const response = await deliver({
      events: [
        event({ title: "Pohon tumbang di Jalan Gatot Subroto", text: "Pohon tumbang menimpa satu mobil di Jalan Gatot Subroto.", location_hint: "Gatot Subroto", timestamp: "2026-11-10T09:10:00+07:00" }),
        event({ title: "Antrean panjang di Tol Dalam Kota", text: "Antrean kendaraan panjang di Tol Dalam Kota arah timur.", location_hint: "Tol Dalam Kota", timestamp: "2026-11-10T09:20:00+07:00" }),
      ],
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { report_revisions: string[]; count: number };
    assert.equal(body.count, 2);
    assert.equal(new Set(body.report_revisions).size, 2);
    for (const revisionId of body.report_revisions) {
      assert.equal(await count(`SELECT COUNT(*)::int AS n FROM waspada.report_revisions WHERE dataset_kind = 'live' AND report_revision_id = $1`, [revisionId]), 1);
      assert.equal(await count(`SELECT COUNT(*)::int AS n FROM waspada.ai_jobs WHERE dataset_kind = 'live' AND report_revision_id = $1`, [revisionId]), 1);
    }
  });
});
