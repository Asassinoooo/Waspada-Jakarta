import assert from 'node:assert/strict';
import { lineageIdsFor, seedProposalLineage } from './proposal-lineage-fixture.js';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import { createEventProposalWriter, type EventProposalDto } from '../src/event-proposal-writer.js';
import { createPipelineFlowStore } from '../src/pipeline-flow-store.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

/**
 * REVIEW-EXPIRY-01 (ADR-062): the expiry candidate query and the flow view's reads of `expire`
 * decisions. Claim text carries a marker. The candidate rows must never contain it.
 */

const NOW = new Date('2026-11-12T12:00:00.000Z');
const HOUR = 3_600_000;
const hoursBefore = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const TEXT_MARKER = 'EXPIRY-TEXT-MARKER-8820';

function proposal(id: string, proposedAt: string, incidentId = `inc-${id}`): EventProposalDto {
  return {
    schema_version: '2.0',
    ...lineageIdsFor('proposal-expiry'),
    proposal_id: id,
    incident_id: incidentId,
    title: `Judul ${id}`,
    incident_type: 'genangan_air_luapan_saluran',
    primary_category: 'disasters_weather',
    compatibility_category: 'flood',
    severity: 'medium',
    event_time: { precision: 'exact', value: '2026-11-12T08:00:00.000Z' },
    location_label: 'Cawang, Jakarta Timur',
    coordinates: null,
    claims: [{
      claim_id: `claim-${id}`,
      claim_text: `Klaim ${TEXT_MARKER} ${id}`,
      evidence_label: 'attributed_report',
      support_assessment: 'supported',
      quote_text: `Kutipan ${TEXT_MARKER}`,
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

describe('REVIEW-EXPIRY-01 expiry candidates and flow reads', () => {
  let db: TestDatabase;
  const writer = () => createEventProposalWriter(db.executor);

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
    await seedProposalLineage(db.executor, 'proposal-expiry');
  });

  after(async () => db?.close());

  it('returns only undecided proposals older than the cutoff, and not a 47-hour-old one', async () => {
    await writer().persistProposal(proposal('exp-47h', hoursBefore(47)), 'live');
    await writer().persistProposal(proposal('exp-49h', hoursBefore(49)), 'live');

    const rows = await writer().readExpirableProposals({ datasetKind: 'live', cutoff: hoursBefore(48), limit: 50 });
    assert.deepEqual(rows.map((row) => row.proposal_id), ['exp-49h']);
    assert.equal(rows[0]!.proposed_at, hoursBefore(49));
    assert.equal(rows[0]!.incident_id, 'inc-exp-49h');
  });

  it('returns rows with only proposal_id, proposed_at and incident_id, and never claim or quote text', async () => {
    const rows = await writer().readExpirableProposals({ datasetKind: 'live', cutoff: hoursBefore(48), limit: 50 });
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['incident_id', 'proposal_id', 'proposed_at']);
    }
    assert.equal(JSON.stringify(rows).includes(TEXT_MARKER), false);
  });

  it('excludes a proposal that already has a decision, whatever its disposition', async () => {
    await writer().persistProposal(proposal('exp-decided', hoursBefore(60)), 'live');
    await db.executor.query(
      `INSERT INTO waspada.publication_decisions (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, reviewer_id, decided_at, record_json)
       VALUES ('live', 'dec-exp-decided', 'trace-lineage-proposal-expiry', 'exp-decided', 'merge-review-v1', NULL, NULL, 'mod-1', $1::timestamptz, '{"disposition":"reject"}'::jsonb)`,
      [hoursBefore(59)],
    );

    const rows = await writer().readExpirableProposals({ datasetKind: 'live', cutoff: hoursBefore(48), limit: 50 });
    assert.equal(rows.some((row) => row.proposal_id === 'exp-decided'), false);
    assert.deepEqual(rows.map((row) => row.proposal_id), ['exp-49h']);
  });

  it('caps one batch at 50 rows, oldest first, and never returns fewer than one', async () => {
    for (let index = 0; index < 55; index += 1) {
      await writer().persistProposal(proposal(`exp-batch-${String(index).padStart(2, '0')}`, hoursBefore(100 + index)), 'live');
    }

    const capped = await writer().readExpirableProposals({ datasetKind: 'live', cutoff: hoursBefore(48), limit: 500 });
    assert.equal(capped.length, 50);
    assert.equal(capped[0]!.proposal_id, 'exp-batch-54', 'the oldest proposal comes first');

    const one = await writer().readExpirableProposals({ datasetKind: 'live', cutoff: hoursBefore(48), limit: 0 });
    assert.equal(one.length, 1);
  });

  it('rejects an invalid dataset kind or cutoff before it reaches SQL', async () => {
    await assert.rejects(
      writer().readExpirableProposals({ datasetKind: 'demo', cutoff: hoursBefore(48), limit: 10 }),
      TypeError,
    );
    await assert.rejects(
      writer().readExpirableProposals({ datasetKind: 'live', cutoff: 'not-a-time', limit: 10 }),
      TypeError,
    );
  });

  it('a flow read sees an expire decision as expired, not as a publication or a gate decision', async () => {
    await writer().persistProposal(proposal('flow-exp', hoursBefore(2), 'inc-flow-exp'), 'live');
    await db.executor.query(
      `INSERT INTO waspada.publication_decisions (dataset_kind, decision_id, trace_id, proposal_id, policy_version, event_id, event_version, reviewer_id, decided_at, record_json)
       VALUES ('live', 'dec-flow-exp', 'trace-lineage-proposal-expiry', 'flow-exp', 'merge-review-v1', NULL, NULL, 'agent:review-expiry', $1::timestamptz,
               '{"disposition":"expire","actor_kind":"agent","actor_id":"agent:review-expiry","reason":"review_ttl_elapsed","ttl_hours":1}'::jsonb)`,
      [hoursBefore(1)],
    );

    const store = createPipelineFlowStore(db.executor);
    const aggregates = await store.readAggregates({ datasetKind: 'live', now: NOW });
    assert.equal(aggregates.publication.expired_24h, 1);
    assert.equal(Object.keys(aggregates.publication.decisions_24h).some((key) => key.startsWith('expire')), false);
    assert.equal(aggregates.publication.decisions_15m, 0, 'the expiry is 60 minutes old, so it is outside the 15-minute window');

    const gate = await store.readItems({ datasetKind: 'live', node: 'gate', now: NOW, limit: 20 });
    assert.equal(gate.some((row) => row.ref === 'flow-exp'), false, 'expiry is not a gate decision');

    const proposals = await store.readItems({ datasetKind: 'live', node: 'proposal', now: NOW, limit: 20 });
    const flowRow = proposals.find((row) => row.ref === 'flow-exp');
    assert.equal(flowRow?.status, 'kedaluwarsa');

    const review = await store.readItems({ datasetKind: 'live', node: 'review', now: NOW, limit: 20 });
    assert.equal(review.some((row) => row.ref === 'flow-exp'), false, 'an expired proposal leaves the review queue');
  });
});
