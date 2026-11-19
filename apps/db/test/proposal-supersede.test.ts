import assert from 'node:assert/strict';
import { lineageIdsFor, seedProposalLineage } from './proposal-lineage-fixture.js';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  AGENT_PROPOSAL_WRITER_ID,
  createEventProposalWriter,
  SUPERSEDE_REASON,
  type EventProposalDto,
} from '../src/event-proposal-writer.js';
import { createPipelineFlowStore } from '../src/pipeline-flow-store.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

/**
 * POLISH-03 (ADR-062 amendment): a newer proposal for an incident supersedes the older undecided proposals of
 * that incident, one decision row each, in the same transaction. Nothing is published. These tests use PGlite
 * and make no network or model calls.
 */

const NOW = new Date('2026-11-19T12:00:00.000Z');
const HOUR = 3_600_000;
const hoursBefore = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const TRACE_ID = lineageIdsFor('proposal-supersede').trace_id;

function proposal(id: string, proposedAt: string, incidentId: string | null): EventProposalDto {
  return {
    schema_version: '2.0',
    ...lineageIdsFor('proposal-supersede'),
    proposal_id: id,
    incident_id: incidentId,
    title: `Judul ${id}`,
    incident_type: 'genangan_air_luapan_saluran',
    primary_category: 'disasters_weather',
    compatibility_category: 'flood',
    severity: 'medium',
    event_time: { precision: 'exact', value: '2026-11-19T08:00:00.000Z' },
    location_label: 'Cawang, Jakarta Timur',
    coordinates: null,
    claims: [{
      claim_id: `claim-${id}`,
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
    has_discrepancy: false,
    discrepancy_summary: null,
    discrepancies: [],
    caveats: [],
    correlation_relationship: 'primary_initial',
    proposed_at: proposedAt,
  } as unknown as EventProposalDto;
}

interface DecisionRow {
  readonly decision_id: string;
  readonly trace_id: string;
  readonly reviewer_id: string | null;
  readonly event_id: string | null;
  readonly event_version: number | null;
  readonly decided_at: unknown;
  readonly record_json: Record<string, unknown>;
}

describe('POLISH-03 a newer proposal supersedes older undecided proposals of its incident', () => {
  let db: TestDatabase;
  const writer = () => createEventProposalWriter(db.executor);

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
    await seedProposalLineage(db.executor, 'proposal-supersede');
  });

  after(async () => db?.close());

  async function decisionsFor(proposalId: string): Promise<readonly DecisionRow[]> {
    const result = await db.executor.query<DecisionRow>(
      `SELECT decision_id, trace_id, reviewer_id, event_id, event_version, decided_at, record_json
         FROM waspada.publication_decisions
        WHERE dataset_kind = 'live' AND proposal_id = $1
        ORDER BY decided_at ASC, decision_id ASC`,
      [proposalId],
    );
    return result.rows;
  }

  async function versionCount(): Promise<number> {
    const result = await db.executor.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM waspada.event_versions WHERE dataset_kind = 'live'`,
    );
    return result.rows[0]!.n;
  }

  it('a newer proposal supersedes the older undecided proposal of its incident, with one agent row and no publication', async () => {
    await writer().persistProposal(proposal('sup-a', hoursBefore(10), 'inc-sup-x'), 'live');
    await writer().persistProposal(proposal('sup-b', hoursBefore(2), 'inc-sup-x'), 'live');

    const rows = await decisionsFor('sup-a');
    assert.equal(rows.length, 1, 'exactly one decision row for the superseded proposal');
    const [row] = rows;
    assert.equal(row!.record_json.disposition, 'supersede');
    assert.equal(row!.reviewer_id, AGENT_PROPOSAL_WRITER_ID);
    assert.equal(row!.record_json.actor_kind, 'agent');
    assert.equal(row!.record_json.actor_id, AGENT_PROPOSAL_WRITER_ID);
    assert.equal(row!.record_json.reason, SUPERSEDE_REASON);
    assert.equal(row!.record_json.superseded_by, 'sup-b', 'the row names the proposal that replaced it');
    assert.equal(row!.record_json.incident_id, 'inc-sup-x');
    assert.equal(row!.trace_id, TRACE_ID, 'the row carries the superseded proposal trace');
    assert.equal(row!.event_id, null, 'no event is linked');
    assert.equal(row!.event_version, null, 'no event version is linked');
    assert.equal(new Date(row!.decided_at as string).toISOString(), hoursBefore(2), 'decided at the newer proposal time');

    assert.deepEqual(await decisionsFor('sup-b'), [], 'the newer proposal stays undecided');
    assert.equal(await versionCount(), 0, 'superseding publishes no event version');
  });

  it('a decided older proposal of the same incident is untouched', async () => {
    await writer().persistProposal(proposal('sup-c', hoursBefore(20), 'inc-sup-y'), 'live');
    await db.executor.query(
      `INSERT INTO waspada.publication_decisions (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, reviewer_id, decided_at, record_json)
       VALUES ('live', 'dec-sup-c', $1, 'sup-c', 'merge-review-v1', NULL, NULL, 'mod-1', $2::timestamptz,
               '{"disposition":"reject","actor_kind":"moderator","actor_id":"mod-1"}'::jsonb)`,
      [TRACE_ID, hoursBefore(19)],
    );

    await writer().persistProposal(proposal('sup-d', hoursBefore(1), 'inc-sup-y'), 'live');

    const rows = await decisionsFor('sup-c');
    assert.deepEqual(rows.map((row) => row.record_json.disposition), ['reject'], 'the moderator reject is the only row');
  });

  it('a proposal of another incident, and a proposal with no incident_id, are untouched', async () => {
    await writer().persistProposal(proposal('sup-e', hoursBefore(5), 'inc-sup-z'), 'live');
    await writer().persistProposal(proposal('sup-f', hoursBefore(1), 'inc-sup-w'), 'live');
    assert.deepEqual(await decisionsFor('sup-e'), [], 'another incident does not supersede it');

    await writer().persistProposal(proposal('sup-g', hoursBefore(7), 'inc-sup-v'), 'live');
    await writer().persistProposal(proposal('sup-h', hoursBefore(3), null), 'live');
    assert.deepEqual(await decisionsFor('sup-g'), [], 'a proposal without an incident_id supersedes nothing');
  });

  it('an older proposal written later does not supersede the newer undecided one', async () => {
    await writer().persistProposal(proposal('sup-i-new', hoursBefore(4), 'inc-sup-u'), 'live');
    await writer().persistProposal(proposal('sup-i-old', hoursBefore(9), 'inc-sup-u'), 'live');
    assert.deepEqual(await decisionsFor('sup-i-new'), [], 'the newer proposal is not superseded by an older one');
  });

  it('a repeated write adds no second row, and a third proposal supersedes only the one before it', async () => {
    const again = await writer().persistProposal(proposal('sup-b', hoursBefore(2), 'inc-sup-x'), 'live');
    assert.equal(again.outcome, 'already_exists', 'the same proposal is not written twice');
    assert.equal((await decisionsFor('sup-a')).length, 1, 'the superseded proposal still has one row');

    await writer().persistProposal(proposal('sup-k', hoursBefore(1), 'inc-sup-x'), 'live');

    const aRows = await decisionsFor('sup-a');
    assert.deepEqual(aRows.map((row) => row.record_json.superseded_by), ['sup-b'], 'sup-a is not superseded a second time');
    const bRows = await decisionsFor('sup-b');
    assert.deepEqual(bRows.map((row) => row.record_json.superseded_by), ['sup-k'], 'sup-b is superseded by the newest proposal');
    assert.deepEqual(await decisionsFor('sup-k'), [], 'the newest proposal stays undecided');
  });

  it('superseded proposals leave the expiry candidates and the moderator queue, and the flow reads them as supersede', async () => {
    const candidates = await writer().readExpirableProposals({ datasetKind: 'live', cutoff: hoursBefore(0), limit: 50 });
    const candidateIds = candidates.map((row) => row.proposal_id);
    assert.equal(candidateIds.includes('sup-a'), false, 'a superseded proposal is not an expiry candidate');
    assert.equal(candidateIds.includes('sup-b'), false, 'a superseded proposal is not an expiry candidate');
    assert.equal(candidateIds.includes('sup-k'), true, 'the undecided newest proposal is still a candidate');

    const pending = (await writer().readPendingProposals('live')).map((item) => item.proposal_id);
    assert.equal(pending.includes('sup-a'), false);
    assert.equal(pending.includes('sup-b'), false);
    assert.equal(pending.includes('sup-k'), true);

    const store = createPipelineFlowStore(db.executor);
    const aggregates = await store.readAggregates({ datasetKind: 'live', now: NOW });
    assert.equal(aggregates.publication.supersede_24h, 2, 'sup-a and sup-b are counted as superseded');
    assert.equal(
      Object.keys(aggregates.publication.decisions_24h).some((key) => key.startsWith('supersede')),
      false,
      'supersede is not a publication decision',
    );
    assert.equal(aggregates.publication.decisions_15m, 0, 'no decision falls in the 15 minute window');

    const proposals = await store.readItems({ datasetKind: 'live', node: 'proposal', now: NOW, limit: 20 });
    assert.equal(proposals.find((row) => row.ref === 'sup-a')?.status, 'supersede');
    assert.equal(proposals.find((row) => row.ref === 'sup-c')?.status, 'diputuskan', 'a reject is still diputuskan');

    const review = await store.readItems({ datasetKind: 'live', node: 'review', now: NOW, limit: 20 });
    assert.equal(review.some((row) => row.ref === 'sup-a' || row.ref === 'sup-b'), false, 'a superseded proposal leaves the review queue');
    assert.equal(review.some((row) => row.ref === 'sup-k'), true);

    const gate = await store.readItems({ datasetKind: 'live', node: 'gate', now: NOW, limit: 20 });
    assert.equal(gate.some((row) => row.ref === 'sup-a' || row.ref === 'sup-b'), false, 'supersede is not a gate decision');
  });
});
