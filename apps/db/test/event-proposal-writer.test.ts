import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import {
  createEventProposalWriter,
  type EventProposalDto,
  type EventProposalWriter,
} from '../src/event-proposal-writer.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

describe('EVENT-PROPOSAL-WRITER: durable proposal persistence and pending queries', () => {
  let db: TestDatabase;
  let writer: EventProposalWriter;

  const sampleProposal1: EventProposalDto = {
    schema_version: '2.0',
    proposal_id: 'proposal-flood-kemang-001',
    title: 'Banjir 50cm di Jalan Kemang Raya',
    incident_type: 'flood',
    severity: 'medium',
    event_time: {
      precision: 'exact',
      value: '2026-10-26T08:30:00.000Z',
    },
    location_label: 'Jl. Kemang Raya, Mampang Prapatan, Jakarta Selatan',
    coordinates: [106.8156, -6.2608],
    claims: [
      {
        claim_id: 'claim-flood-depth-001',
        claim_text: 'Genangan air setinggi 50 cm merendam ruas jalan utama Kemang Raya.',
        evidence_label: 'under_review',
        support_assessment: 'supported',
        quote_text: 'air setinggi 50 cm merendam ruas jalan utama',
        evidence_ref_id: 'ref-chunk-101',
      },
      {
        claim_id: 'claim-flood-traffic-002',
        claim_text: 'Lalu lintas dialihkan ke arah Jalan Bangka Raya.',
        evidence_label: 'under_review',
        support_assessment: 'supported',
        quote_text: 'arus lalu lintas dialihkan ke Jalan Bangka',
        evidence_ref_id: 'ref-chunk-102',
      },
    ],
    proposed_at: '2026-10-26T08:35:00.000Z',
  };

  const sampleProposal2: EventProposalDto = {
    schema_version: '2.0',
    proposal_id: 'proposal-fire-tambora-002',
    title: 'Kebakaran Rumah Tinggal di Tambora',
    incident_type: 'fire',
    severity: 'high',
    event_time: {
      precision: 'exact',
      value: '2026-10-26T09:00:00.000Z',
    },
    location_label: 'Tambora, Jakarta Barat',
    coordinates: [106.8012, -6.1489],
    claims: [
      {
        claim_id: 'claim-fire-houses-001',
        claim_text: 'Sebanyak 4 rumah semi-permanen terbakar di kawasan padat Tambora.',
        evidence_label: 'under_review',
        support_assessment: 'supported',
        quote_text: 'empat rumah semi permanen hangus terbakar',
        evidence_ref_id: 'ref-chunk-201',
      },
    ],
    proposed_at: '2026-10-26T09:10:00.000Z',
  };

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
    writer = createEventProposalWriter(db.executor);
  });

  after(async () => {
    await db.close();
  });

  it('persists a new proposal and claims atomically into the database', async () => {
    const result = await writer.persistProposal(sampleProposal1, 'live');
    assert.equal(result.proposalId, sampleProposal1.proposal_id);
    assert.equal(result.outcome, 'created');

    // Verify row in waspada.event_proposals
    const proposalRows = await db.executor.query<{
      proposal_id: string;
      dataset_kind: string;
      record_json: unknown;
    }>(
      'SELECT proposal_id, dataset_kind, record_json FROM waspada.event_proposals WHERE dataset_kind = $1 AND proposal_id = $2',
      ['live', sampleProposal1.proposal_id],
    );
    assert.equal(proposalRows.rows.length, 1);
    const storedRow = proposalRows.rows[0]!;
    assert.equal(storedRow.proposal_id, sampleProposal1.proposal_id);
    assert.equal(storedRow.dataset_kind, 'live');

    // Verify claims in waspada.proposal_claims
    const claimRows = await db.executor.query<{
      claim_id: string;
      claim_text: string;
      evidence_label: string;
      support_assessment: string;
    }>(
      'SELECT claim_id, claim_text, evidence_label, support_assessment FROM waspada.proposal_claims WHERE dataset_kind = $1 AND proposal_id = $2 ORDER BY claim_id ASC',
      ['live', sampleProposal1.proposal_id],
    );
    assert.equal(claimRows.rows.length, 2);
    assert.equal(claimRows.rows[0]?.claim_id, 'claim-flood-depth-001');
    assert.equal(claimRows.rows[0]?.evidence_label, 'under_review');
    assert.equal(claimRows.rows[0]?.support_assessment, 'supported');
    assert.equal(claimRows.rows[1]?.claim_id, 'claim-flood-traffic-002');
  });

  it('handles duplicate replay idempotently without firing append-only triggers', async () => {
    // Replay the exact same proposal
    const replayResult = await writer.persistProposal(sampleProposal1, 'live');
    assert.equal(replayResult.proposalId, sampleProposal1.proposal_id);
    assert.equal(replayResult.outcome, 'already_exists');

    // Ensure proposal row count is still exactly 1
    const proposalCount = await db.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.event_proposals WHERE dataset_kind = $1 AND proposal_id = $2',
      ['live', sampleProposal1.proposal_id],
    );
    assert.equal(proposalCount.rows[0]?.count, '1');

    // Ensure claims count is still 2
    const claimCount = await db.executor.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waspada.proposal_claims WHERE dataset_kind = $1 AND proposal_id = $2',
      ['live', sampleProposal1.proposal_id],
    );
    assert.equal(claimCount.rows[0]?.count, '2');
  });

  it('reads a proposal by id matching the Schema 2.0 contract', async () => {
    const fetched = await writer.readProposalById(sampleProposal1.proposal_id, 'live');
    assert.ok(fetched);
    assert.equal(fetched.schema_version, '2.0');
    assert.equal(fetched.proposal_id, sampleProposal1.proposal_id);
    assert.equal(fetched.title, sampleProposal1.title);
    assert.equal(fetched.incident_type, 'flood');
    assert.equal(fetched.severity, 'medium');
    assert.deepEqual(fetched.coordinates, [106.8156, -6.2608]);
    assert.equal(fetched.location_label, sampleProposal1.location_label);
    assert.equal(fetched.claims.length, 2);
    assert.equal(fetched.claims[0]?.quote_text, 'air setinggi 50 cm merendam ruas jalan utama');
    assert.equal(fetched.claims[0]?.evidence_ref_id, 'ref-chunk-101');
  });

  it('returns null when reading non-existent proposal id', async () => {
    const missing = await writer.readProposalById('non-existent-proposal-id', 'live');
    assert.equal(missing, null);
  });

  it('reads pending proposals in descending proposed_at order and filters decided proposals', async () => {
    // Persist second proposal
    const result2 = await writer.persistProposal(sampleProposal2, 'live');
    assert.equal(result2.outcome, 'created');

    // Both proposals should be pending
    const pendingBefore = await writer.readPendingProposals('live');
    assert.equal(pendingBefore.length, 2);
    // proposal2 proposed_at (09:10) is newer than proposal1 (08:35) -> should appear first
    assert.equal(pendingBefore[0]?.proposal_id, sampleProposal2.proposal_id);
    assert.equal(pendingBefore[1]?.proposal_id, sampleProposal1.proposal_id);

    // Record a publication decision for proposal1
    const traceRow = await db.executor.query<{ trace_id: string }>(
      'SELECT trace_id FROM waspada.event_proposals WHERE dataset_kind = $1 AND proposal_id = $2',
      ['live', sampleProposal1.proposal_id],
    );
    const traceId = traceRow.rows[0]!.trace_id;

    await db.executor.query(
      `INSERT INTO waspada.publication_decisions
       (dataset_kind, decision_id, trace_id, proposal_id, policy_version, decided_at, record_json)
       VALUES ($1, $2, $3, $4, 'policy-v1', now(), '{"disposition":"publish"}'::jsonb)`,
      ['live', 'decision-pub-001', traceId, sampleProposal1.proposal_id],
    );

    // Now proposal1 should no longer be pending, only proposal2 should be pending
    const pendingAfter = await writer.readPendingProposals('live');
    assert.equal(pendingAfter.length, 1);
    assert.equal(pendingAfter[0]?.proposal_id, sampleProposal2.proposal_id);
  });

  it('supports synthetic dataset kind persistence and queries', async () => {
    const syntheticProposal: EventProposalDto = {
      ...sampleProposal1,
      proposal_id: 'proposal-synthetic-tree-003',
      incident_type: 'tree_fall',
      title: 'Pohon Tumbang Menimpa Tiang Listrik',
      claims: [
        {
          claim_id: 'claim-tree-001',
          claim_text: 'Pohon angsana berdiameter 60cm tumbang menutup jalan.',
          evidence_label: 'under_review',
          support_assessment: 'supported',
          quote_text: 'pohon angsana tumbang',
          evidence_ref_id: 'ref-tree-001',
        },
      ],
      proposed_at: '2026-10-26T10:00:00.000Z',
    };

    const result = await writer.persistProposal(syntheticProposal, 'synthetic');
    assert.equal(result.outcome, 'created');

    const read = await writer.readProposalById(syntheticProposal.proposal_id, 'synthetic');
    assert.ok(read);
    assert.equal(read.proposal_id, syntheticProposal.proposal_id);
    assert.equal(read.incident_type, 'tree_fall');

    const pendingSynthetic = await writer.readPendingProposals('synthetic');
    assert.equal(pendingSynthetic.length, 1);
    assert.equal(pendingSynthetic[0]?.proposal_id, syntheticProposal.proposal_id);
  });

  it('links to waspada.proposal_claim_evidence when evidence_ref_id exists in evidence_references', async () => {
    const traceId = 'trace-evidence-link-fixture';
    const sourceId = 'source-evidence-link-fixture';
    const revisionId = 'rev-evidence-link-fixture';
    const textHash = 'a'.repeat(64);

    // Seed lineage and an evidence reference
    await db.executor.query(
      `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
       VALUES ($1, 'live', now(), 'succeeded', '{}'::jsonb) ON CONFLICT DO NOTHING`,
      [traceId],
    );
    await db.executor.query(
      `INSERT INTO waspada.source_registry
         (source_id, trace_id, registry_version, display_name, source_kind, remit,
          access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
          approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
       VALUES ($1, $2, 1, 'Source Fixture', 'newsroom', ARRAY['news'], 'manual_fixture',
               ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', false, 'never')
       ON CONFLICT (source_id) DO NOTHING`,
      [sourceId, traceId],
    );
    await db.executor.query(
      `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url, content_hash, permitted_text, permitted_text_hash, normalization_version, retrieved_at, revision_status, record_json)
       VALUES ('live', $1, $2, $3, 'https://example.invalid', $4, 'Banjir merendam jalan', $4, 'v1', now(), 'unreviewed', '{}'::jsonb)
       ON CONFLICT DO NOTHING`,
      [revisionId, traceId, sourceId, textHash],
    );

    const refInsert = await db.executor.query<{ evidence_ref_id: string }>(
      `INSERT INTO waspada.evidence_references
       (dataset_kind, trace_id, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, relation)
       VALUES ('live', $1, $2, $3, 0, 10, 'unicode_code_points', 'supports')
       RETURNING evidence_ref_id::text`,
      [traceId, revisionId, textHash],
    );
    const evidenceRefId = refInsert.rows[0]!.evidence_ref_id;

    const proposalWithEvidence: EventProposalDto = {
      schema_version: '2.0',
      proposal_id: 'proposal-with-linked-evidence',
      title: 'Uji Penautan Bukti',
      incident_type: 'flood',
      severity: 'low',
      event_time: { precision: 'date', value: '2026-10-26' },
      location_label: 'Jakarta Pusat',
      coordinates: null,
      claims: [
        {
          claim_id: 'claim-with-ref-1',
          claim_text: 'Bukti terhubung langsung ke ref id.',
          evidence_label: 'under_review',
          support_assessment: 'supported',
          quote_text: 'Banjir merendam',
          evidence_ref_id: evidenceRefId,
        },
      ],
      proposed_at: '2026-10-26T11:00:00.000Z',
    };

    const res = await writer.persistProposal(proposalWithEvidence, 'live');
    assert.equal(res.outcome, 'created');

    // Verify entry in waspada.proposal_claim_evidence
    const linked = await db.executor.query<{ evidence_ref_id: string }>(
      `SELECT evidence_ref_id::text FROM waspada.proposal_claim_evidence
       WHERE dataset_kind = 'live' AND proposal_id = $1 AND claim_id = 'claim-with-ref-1'`,
      [proposalWithEvidence.proposal_id],
    );
    assert.equal(linked.rows.length, 1);
    assert.equal(linked.rows[0]?.evidence_ref_id, evidenceRefId);
  });

  it('validates input errors properly', async () => {
    // Missing proposal
    await assert.rejects(
      async () => writer.persistProposal(null as unknown as EventProposalDto),
      /Proposal must be an object/,
    );

    // Missing proposal_id
    await assert.rejects(
      async () => writer.persistProposal({ ...sampleProposal1, proposal_id: '' }),
      /Proposal must have a valid proposal_id/,
    );

    // Invalid dataset
    await assert.rejects(
      async () => writer.persistProposal(sampleProposal1, 'invalid_dataset'),
      /Invalid dataset_kind/,
    );

    // Invalid proposalId for readProposalById
    await assert.rejects(
      async () => writer.readProposalById(''),
      /proposalId must be a non-empty string/,
    );
  });

  it('proves database enforces immutable append-only trigger against UPDATE', async () => {
    await assert.rejects(
      async () => {
        await db.executor.execute(
          `UPDATE waspada.event_proposals
           SET proposed_at = now()
           WHERE proposal_id = '${sampleProposal1.proposal_id}'`,
        );
      },
      /is append-only/,
    );
  });
});
