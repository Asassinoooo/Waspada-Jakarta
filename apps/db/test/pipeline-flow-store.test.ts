import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createEventProposalWriter, type EventProposalDto } from '../src/event-proposal-writer.js';
import { createPipelineFlowStore, PIPELINE_FLOW_ITEM_CAP } from '../src/pipeline-flow-store.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

/**
 * FLOW-VIS-01: the moderator flow view reads counts and metadata through the read-only role
 * (migration 047). The fixtures below are synthetic. The permitted text, the model output and the
 * checkpoint body carry marker strings, and no drill-down may return them.
 */

const NOW = new Date('2026-11-11T09:00:00.000Z');
const MIN = 60_000;
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN).toISOString();
const hex = (char: string) => char.repeat(64);
const BODY_MARKER = 'SECRET-BODY-MARKER-7731';
const OUTPUT_MARKER = 'MODEL-OUTPUT-MARKER-4419';

function proposal(id: string, options: { title: string; discrepancy?: boolean; proposedAt: string }): EventProposalDto {
  const claimId = `claim-${id}`;
  return {
    schema_version: '2.0',
    proposal_id: id,
    incident_id: `inc-${id}`,
    title: options.title,
    incident_type: 'genangan_air_luapan_saluran',
    primary_category: 'disasters_weather',
    compatibility_category: 'flood',
    severity: 'medium',
    event_time: { precision: 'exact', value: '2026-11-11T08:00:00.000Z' },
    location_label: 'Cawang, Jakarta Timur',
    coordinates: null,
    claims: [{
      claim_id: claimId,
      claim_text: `Klaim ${id}`,
      evidence_label: 'attributed_report',
      support_assessment: 'supported',
      quote_text: `Kutipan ${id}`,
      evidence_ref_id: `chk-${id}`,
      source_id: 'source-antara-metro',
      outlet: 'ANTARA',
      source_url: `https://news.example/${id}`,
    }],
    impacts: [],
    interpretation_category: null,
    source_id: 'source-antara-metro',
    is_multi_source: false,
    source_count: 1,
    has_discrepancy: options.discrepancy ?? false,
    discrepancy_summary: options.discrepancy ? 'Dua laporan berbeda soal jumlah korban.' : null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: 'primary_initial',
    proposed_at: options.proposedAt,
  } as unknown as EventProposalDto;
}

describe('FLOW-VIS-01 pipeline flow store', () => {
  let db: TestDatabase;
  const store = () => createPipelineFlowStore(db.executor);

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
    await seed();
  });

  after(async () => db?.close());

  async function seed(): Promise<void> {
    const exec = db.executor;
    const trace = (id: string) => exec.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, 'live', $2::timestamptz, 'succeeded', '{}'::jsonb)`,
      [id, ago(600)],
    );
    await trace('trace-seed');
    await exec.query(
      `INSERT INTO waspada.source_registry (
         source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy, polling_interval_seconds)
       VALUES
         ('petabencana', 'trace-seed', 1, 'PetaBencana', 'crowdsourced_platform', ARRAY['disasters'], 'api', ARRAY['petabencana.id'], ARRAY[]::text[], ARRAY['public_display'], 'active', 'approved', 'healthy', true, 'never', 300),
         ('source-bmkg-gempa', 'trace-seed', 1, 'BMKG', 'authority', ARRAY['disasters'], 'api', ARRAY['bmkg.go.id'], ARRAY[]::text[], ARRAY['public_display'], 'active', 'approved', 'degraded', true, 'never', 300),
         ('source-antara-metro', 'trace-seed', 1, 'ANTARA Metro', 'newsroom', ARRAY['news'], 'rss', ARRAY['www.antaranews.com'], ARRAY[]::text[], ARRAY['model_triage'], 'active', 'approved', 'healthy', true, 'never', 600)`,
    );

    // Report revisions: one recent with a body marker, one older, and a burst for the 20-row cap.
    const revision = (id: string, source: string, status: string, retrievedAt: string, hashChar: string, text: string) => exec.query(
      `INSERT INTO waspada.report_revisions (
         dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash,
         permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json, triage_required)
       VALUES ('live', $1, 'trace-seed', $2, 'https://news.example/a', $3, $4, $3, 'v1', $5::timestamptz, $6, '{}'::jsonb, false)`,
      [id, source, hex(hashChar), text, retrievedAt, status],
    );
    await revision('rev-pb-1', 'petabencana', 'eligible', ago(5), 'a', `Banjir di Cawang ${BODY_MARKER}`);
    await revision('rev-rss-old', 'source-antara-metro', 'unreviewed', ago(120), 'b', `Lama ${BODY_MARKER}`);
    // FLOW-RANGE-01: older than 24 h but inside 7 days, so only a 7 day window counts it.
    await revision('rev-rss-48h', 'source-antara-metro', 'eligible', ago(48 * 60), 'e', `Dua hari lalu ${BODY_MARKER}`);
    for (let index = 0; index < 25; index++) {
      await revision(`rev-rss-${String(index).padStart(2, '0')}`, 'source-antara-metro', 'eligible', ago(2 + index), 'c', `Burst ${index} ${BODY_MARKER}`);
    }
    await exec.query(
      `INSERT INTO waspada.evidence_chunks (dataset_kind, chunk_id, trace_id, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, chunker_version, chunk_text_hash, status)
       VALUES ('live', 'chk-rev-pb-1', 'trace-seed', 'rev-pb-1', $1, 0, 12, 'unicode_code_points', 'v1', $2, 'active')`,
      [hex('a'), hex('d')],
    );
    await exec.query(
      `INSERT INTO waspada.embedding_runs (dataset_kind, embedding_run_id, trace_id, chunk_id, capability, provider, model_version, dimensions, distance_metric, vector_index_version, input_text_hash, status, created_at)
       VALUES
         ('live', 'emb-ok', 'trace-seed', 'chk-rev-pb-1', 'embedding', 'nr', 'm1', 3, 'cosine', 'v1', $1, 'available', $2::timestamptz),
         ('live', 'emb-bad', 'trace-seed', 'chk-rev-pb-1', 'embedding', 'nr', 'm1', 3, 'cosine', 'v1', $1, 'failed', $3::timestamptz)`,
      [hex('d'), ago(4), ago(40)],
    );

    // Triage: a deterministic skip 3 min ago, an accepted Stage B item, and a rate-limited one.
    const triage = (hash: string, disposition: string, modelStatus: string, at: string) => exec.query(
      `INSERT INTO waspada.news_triage_decisions (dataset_kind, item_identity_hash, source_id, trace_id, disposition, jakarta_scope, actionability, confidence, reason_codes, policy_version, model_status, evaluated_at)
       VALUES ('live', $1, 'source-antara-metro', 'trace-seed', $2, 'dki_jakarta', 'actionable', 'high', ARRAY['x']::text[], 'wj-int-02-v1', $3, $4::timestamptz)`,
      [hash, disposition, modelStatus, at],
    );
    await triage(hex('1'), 'drop', 'skipped_stage_a', ago(3));
    await triage(hex('2'), 'ingest', 'ok', ago(8));
    await triage(hex('3'), 'uncertain', 'rate_limited', ago(9));
    // FLOW-RANGE-01: a deterministic skip from two days ago, outside 24 h and inside 7 days.
    await triage(hex('4'), 'drop', 'skipped_stage_a', ago(48 * 60));

    // AI jobs: one of each status. The leased job carries an interpretation checkpoint.
    const job = (id: string, status: string, revisionId: string, extra: string, checkpoint: string | null) => exec.query(
      `INSERT INTO waspada.ai_jobs (
         job_id, dataset_kind, report_revision_id, status, attempt_count, max_attempts, available_at, lease_token,
         lease_started_at, lease_expires_at, last_failure_code, trace_id, created_at, updated_at, finished_at, checkpoint_json)
       VALUES ($1, 'live', $2, $3, ${extra}, 5, $4::timestamptz, $5, $6, $7, $8, 'trace-seed', $9::timestamptz, $10::timestamptz, $11, $12::jsonb)`,
      [
        id, revisionId, status,
        ago(30),
        status === 'leased' ? '11111111-2222-3333-4444-555555555555' : null,
        status === 'leased' ? ago(2) : null,
        status === 'leased' ? ago(-3) : null,
        ['needs_review', 'terminal', 'retry'].includes(status) ? (status === 'retry' ? 'rate_limited' : 'model_failed') : null,
        ago(30),
        status === 'completed' || status === 'terminal' || status === 'needs_review' ? ago(status === 'terminal' ? 300 : 2) : (status === 'leased' ? ago(2) : ago(30)),
        status === 'completed' || status === 'terminal' || status === 'needs_review' ? ago(status === 'terminal' ? 300 : 2) : null,
        checkpoint,
      ],
    );
    await job('job-pending', 'pending', 'rev-j-1', '0', null);
    await job('job-leased', 'leased', 'rev-j-2', '1', JSON.stringify({ interpretation: { body: OUTPUT_MARKER } }));
    await job('job-retry', 'retry', 'rev-j-3', '0', null);
    await job('job-review', 'needs_review', 'rev-j-4', '2', null);
    await job('job-done', 'completed', 'rev-j-5', '1', null);

    await exec.query(
      `INSERT INTO waspada.incident_correlation_decisions (decision_id, dataset_kind, report_revision_id, decision, target_incident_id, reasoning, created_at)
       VALUES ('corr-1', 'live', 'rev-pb-1', 'new_incident', NULL, 'alasan', $1::timestamptz),
              ('corr-2', 'live', 'rev-rss-old', 'same_incident', 'inc-1', 'alasan', $2::timestamptz)`,
      [ago(4), ago(30)],
    );
    await exec.query(
      `INSERT INTO waspada.incidents (incident_id, dataset_kind, title, description, incident_type, status, severity, first_observed_at, last_updated_at, created_at)
       VALUES ('inc-1', 'live', 'Genangan Cawang', 'deskripsi', 'genangan', 'active', 'medium', $1::timestamptz, $1::timestamptz, $1::timestamptz)`,
      [ago(60)],
    );

    // Proposals through the real writer: p-1 decided by the agent, p-2 with a discrepancy waiting, p-3 waiting.
    const writer = createEventProposalWriter(exec);
    await writer.persistProposal(proposal('p-1', { title: 'Genangan Cawang', proposedAt: ago(20) }), 'live');
    await writer.persistProposal(proposal('p-2', { title: 'Pemadaman listrik Cengkareng', discrepancy: true, proposedAt: ago(6) }), 'live');
    await writer.persistProposal(proposal('p-3', { title: 'Kemacetan Tol Dalam Kota', proposedAt: ago(1) }), 'live');

    // A rejected proposal and an agent publication, both recorded as decisions.
    await exec.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO waspada.publication_decisions (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, reviewer_id, decided_at, record_json)
         VALUES ('live', 'dec-p1', 'trace-p-1', 'p-1', 'merge-review-v1', 'evt-p-1', 1, 'agent:auto-publisher', $1::timestamptz,
                 '{"disposition":"publish","actor_kind":"agent","actor_id":"agent:auto-publisher","publication_mode":"agent_auto","gate":"agent_auto_publication"}'::jsonb)`,
        [ago(16)],
      );
      await tx.query(
        `INSERT INTO waspada.event_versions (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary, category, lifecycle, publication_status, publication_decision_id, published_at, record_json)
         VALUES ('live', 'evt-p-1', 1, 'trace-p-1', NULL, 'Genangan Cawang', 'Ringkasan', 'disasters_weather', 'ongoing', 'published', 'dec-p1', $1::timestamptz,
                 '{"claims":[{"claim_id":"claim-p-1"}],"impact_refs":[],"publication_mode":"agent_auto"}'::jsonb)`,
        [ago(16)],
      );
      await tx.query(
        `INSERT INTO waspada.event_claims (dataset_kind, event_id, event_version, claim_id, publication_status, claim_text, evidence_label, record_json)
         VALUES ('live', 'evt-p-1', 1, 'claim-p-1', 'published', 'Klaim p-1', 'attributed_report', '{"claim_id":"claim-p-1"}'::jsonb)`,
      );
      await tx.query(
        `INSERT INTO waspada.publication_decisions (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, reviewer_id, decided_at, record_json)
         VALUES ('live', 'dec-p3', 'trace-p-3', 'p-3', 'merge-review-v1', NULL, NULL, 'mod-1', $1::timestamptz,
                 '{"disposition":"reject","actor_kind":"moderator","actor_id":"mod-1","reason":"tidak relevan"}'::jsonb)`,
        [ago(2)],
      );
    });
  }

  it('counts each stage over the 24 hour window and the 15 minute throughput', async () => {
    const aggregates = await store().readAggregates({ datasetKind: 'live', now: NOW });

    const byFamily = Object.fromEntries(aggregates.sources.map((row) => [row.family, row]));
    assert.equal(byFamily.petabencana?.sources, 1);
    assert.equal(byFamily.petabencana?.healthy, 1);
    assert.equal(byFamily.bmkg?.unhealthy, 1, 'a degraded registry source counts as unhealthy');
    assert.equal(byFamily.rss?.sources, 1);
    assert.equal(byFamily.rss?.revisions_24h, 26, 'the 25 burst revisions plus the older one');
    assert.equal(byFamily.rss?.revisions_15m, 14, 'revisions retrieved in the last 15 minutes');
    assert.equal(byFamily.petabencana?.revisions_15m, 1);

    assert.equal(aggregates.triage.skipped_stage_a_24h, 1);
    assert.equal(aggregates.triage.skipped_stage_a_15m, 1);
    assert.equal(aggregates.triage.dispositions_24h.ingest, 1);
    assert.equal(aggregates.triage.model_status_24h.rate_limited, 1);
    assert.equal(aggregates.triage.rate_limited_15m, 1, 'the rate-limited row is 9 minutes old, inside the window');
    assert.equal(aggregates.triage.failures_15m, 0);

    assert.equal(aggregates.ai_jobs.pending, 1);
    assert.equal(aggregates.ai_jobs.leased, 1);
    assert.equal(aggregates.ai_jobs.retry, 1);
    assert.equal(aggregates.ai_jobs.needs_review, 1);
    assert.equal(aggregates.ai_jobs.completed_24h, 1);
    assert.equal(aggregates.ai_jobs.terminal_24h, 0);
    assert.equal(aggregates.ai_jobs.checkpointed_open, 1, 'only the open job with an interpretation checkpoint');

    assert.equal(aggregates.embeddings.available_24h, 1);
    assert.equal(aggregates.embeddings.failed_24h, 1);
    assert.equal(aggregates.embeddings.failed_15m, 0, 'the failure is 40 minutes old');
    assert.equal(aggregates.revisions.active_chunks, 1);

    assert.equal(aggregates.correlation.by_decision_24h.new_incident, 1);
    assert.equal(aggregates.correlation.by_decision_24h.same_incident, 1);
    assert.equal(aggregates.correlation.incidents_open, 1);

    assert.equal(aggregates.proposals.proposed_24h, 3);
    assert.equal(aggregates.proposals.pending, 1, 'p-2 has no decision; p-3 was rejected and p-1 published');
    assert.equal(aggregates.proposals.pending_discrepancy, 1, 'only p-2 carries a discrepancy and waits');

    assert.equal(aggregates.publication.decisions_24h.publish_agent, 1);
    assert.equal(aggregates.publication.decisions_24h.reject_moderator, 1);
    assert.equal(aggregates.publication.events_published, 1);
    assert.equal(aggregates.publication.versions_agent_24h, 1);
    assert.equal(aggregates.publication.versions_15m, 0, 'the agent publication is 16 minutes old, outside the window');
    assert.equal(aggregates.publication.moderator_decisions_15m, 1);
  });

  it('FLOW-RANGE-01: every *_24h count and drill-down follows the selected window, and the 15 minute counts do not', async () => {
    const HOUR = 3_600_000;
    const day = await store().readAggregates({ datasetKind: 'live', now: NOW });
    const hour = await store().readAggregates({ datasetKind: 'live', now: NOW, windowMs: HOUR });
    const week = await store().readAggregates({ datasetKind: 'live', now: NOW, windowMs: 7 * 24 * HOUR });
    const rss = (aggregates: typeof day) => aggregates.sources.find((row) => row.family === 'rss')!;

    assert.equal(rss(day).revisions_24h, 26, 'a revision 48 hours old is outside the default 24 hour window');
    assert.equal(rss(hour).revisions_24h, 25, 'only the burst is inside the last hour');
    assert.equal(rss(week).revisions_24h, 27, 'the revision 48 hours old is counted inside 7 days');
    assert.equal(rss(hour).revisions_15m, 14, 'the 15 minute throughput is the same in every window');
    assert.equal(rss(week).revisions_15m, 14);
    assert.equal(week.revisions.by_status_24h.eligible, day.revisions.by_status_24h.eligible + 1);
    assert.equal(hour.embeddings.failed_24h, 1, 'the failure 40 minutes ago is inside the hour');
    assert.equal(day.triage.skipped_stage_a_24h, 1);
    assert.equal(week.triage.skipped_stage_a_24h, 2, 'the deterministic skip from 48 hours ago is counted inside 7 days');
    assert.equal(week.triage.skipped_stage_a_15m, 1, 'the 15 minute skip count is unchanged');

    const dayItems = await store().readItems({ datasetKind: 'live', node: 'det_filter', now: NOW, limit: 20 });
    const weekItems = await store().readItems({ datasetKind: 'live', node: 'det_filter', now: NOW, limit: 20, windowMs: 7 * 24 * HOUR });
    assert.deepEqual(dayItems.map((row) => row.ref), ['111111111111']);
    assert.deepEqual(weekItems.map((row) => row.ref), ['111111111111', '444444444444'], 'the drill-down follows the same window');
  });

  it('returns at most 20 metadata rows per node and never the body, output or checkpoint text', async () => {
    const items = await store().readItems({ datasetKind: 'live', node: 'src_rss', now: NOW, limit: 50 });
    assert.equal(items.length, PIPELINE_FLOW_ITEM_CAP);
    const serialized = JSON.stringify(items);
    assert.equal(serialized.includes(BODY_MARKER), false);
    assert.deepEqual(Object.keys(items[0]!).sort(), ['at', 'failure_code', 'ref', 'status', 'title']);

    const interpret = await store().readItems({ datasetKind: 'live', node: 'interpret', now: NOW, limit: 20 });
    assert.deepEqual(interpret.map((row) => row.ref), ['job-leased']);
    assert.equal(JSON.stringify(interpret).includes(OUTPUT_MARKER), false);

    const detFilter = await store().readItems({ datasetKind: 'live', node: 'det_filter', now: NOW, limit: 20 });
    const triage = await store().readItems({ datasetKind: 'live', node: 'triage', now: NOW, limit: 20 });
    assert.deepEqual(detFilter.map((row) => row.ref), ['111111111111']);
    assert.deepEqual(triage.map((row) => [row.ref, row.failure_code]), [['222222222222', null], ['333333333333', 'rate_limited']]);
  });

  it('shows proposal titles only in moderator drill-downs and lists pending review items', async () => {
    const proposals = await store().readItems({ datasetKind: 'live', node: 'proposal', now: NOW, limit: 20 });
    assert.ok(proposals.some((row) => row.ref === 'p-2' && row.title === 'Pemadaman listrik Cengkareng'));

    const review = await store().readItems({ datasetKind: 'live', node: 'review', now: NOW, limit: 20 });
    assert.deepEqual(review.map((row) => [row.ref, row.status]), [['p-2', 'diskrepansi']], 'rejected and published proposals leave the queue');

    const gate = await store().readItems({ datasetKind: 'live', node: 'gate', now: NOW, limit: 20 });
    assert.deepEqual(gate.map((row) => row.status).sort(), ['publish_agent', 'reject_moderator']);

    const published = await store().readItems({ datasetKind: 'live', node: 'published', now: NOW, limit: 20 });
    assert.equal(published[0]?.ref, 'evt-p-1');
    assert.equal(published[0]?.status, 'versi 1');
  });

  it('runs as a read-only role that cannot read bodies, JSON payloads or checkpoints', async () => {
    const reader = async (statement: string) => {
      await db.executor.transaction(async (tx) => {
        await tx.execute('SET TRANSACTION READ ONLY');
        await tx.execute('SET LOCAL ROLE waspada_l4_pipeline_flow_reader');
        await tx.query(statement);
      });
    };
    await assert.rejects(reader('SELECT permitted_text FROM waspada.report_revisions'), /permission denied/u);
    await assert.rejects(reader('SELECT checkpoint_json FROM waspada.ai_jobs'), /permission denied/u);
    await assert.rejects(reader('SELECT record_json FROM waspada.event_proposals'), /permission denied/u);
    await assert.rejects(reader('SELECT claim_text FROM waspada.event_claims'), /permission denied/u);
    await assert.rejects(reader("UPDATE waspada.incidents SET status = 'closed'"), /permission denied|read-only/u);
  });
});
