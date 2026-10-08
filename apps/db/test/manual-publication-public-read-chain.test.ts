import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createSqlEventProposalReader,
  type EventProposal,
  type ProposalClaim,
  type ProposalEvidenceReference,
} from '../src/event-proposals.js';
import {
  SqlPublicationWriter,
  type PublicationEventVersionDraft,
  type PublicationImpactVersionDraft,
} from '../src/publication-writer.js';
import { createPublicEventHistoryRepository } from '../src/public-event-history.js';
import { createPublicEventHistoryDisclosureRepository } from '../src/public-event-history-disclosure.js';
import { createPublicEventUpdatesReader } from '../src/public-event-updates.js';
import type { EvidenceRetrievalCandidate } from '../src/evidence-retrieval.js';
import { applyMigrations, readMigrations } from '../src/migrations.js';
import type { SqlExecutor } from '../src/sql.js';
import {
  createManualPublicationService,
  type ManualPublicationServiceInput,
} from '../../worker/src/layers/l4-application-integration/manual-publication-service.js';
import type {
  CurrentEvidenceState,
  ExplicitModeratorDecision,
  PublicationPolicyInput,
} from '../../worker/src/layers/l4-application-integration/publication-policy.js';
import { createPublicEventHistoryProjectionService } from '../../worker/src/layers/l4-application-integration/public-event-history-projection-service.js';
import { createPublicEventUpdatesService } from '../../worker/src/layers/l4-application-integration/public-event-updates-service.js';
import {
  handlePublicApiRequest,
  type WorkerEnvironment,
} from '../../worker/src/layers/l4-application-integration/api.js';
import type { EventDetail, EventPage } from '../../worker/src/contracts/public-api.js';
import { createPublicEventListRuntime } from '../../worker/src/runtime/public-event-list-runtime.js';
import { createPublicEventDetailRuntime } from '../../worker/src/runtime/public-event-detail-runtime.js';
import type { EvidenceReference, GroundingContext, ProposedClaim } from '../../worker/src/layers/l2-model-grounding/contracts.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const NOW = '2026-10-08T03:00:00Z';
const CORRECTION_AT = '2026-10-08T03:15:00.123456Z';
const TEST_CONNECTION_STRING = 'postgresql://test-user:test-password@hyperdrive.example.invalid/waspada?sslmode=require';
const PUBLIC_SOURCE_DISPLAY_NAME = 'Authored synthetic attribution fixture only';
const PUBLIC_SOURCE_URL = 'https://example.invalid/authored-attribution-fixture';
const FIRST_DISCLOSURE_SUMMARY = 'Fictional reviewed disclosure for synthetic version one.';
const CORRECTION_DISCLOSURE_SUMMARY = 'Fictional reviewed correction disclosure for synthetic version two.';
const REPORT_TEXT = 'Synthetic fixture claim one; Synthetic fixture claim two.';
const REPORT_HASH = sha256(REPORT_TEXT);
const MODEL_RUN = {
  capability: 'reasoning' as const,
  modelVersion: 'synthetic-model-v1',
  promptVersion: 'synthetic-prompt-v1',
  inputTokens: 12,
  outputTokens: 8,
};
const EXPECTED_LABELS = {
  'claim-001': 'issuer_notice',
  'claim-002': 'crowdsourced_observation',
} as const;

const FOOTPRINT_TABLES = [
  'publication_decisions',
  'publication_claim_decisions',
  'publication_decision_evidence',
  'event_versions',
  'event_claims',
  'event_claim_evidence',
  'event_claim_origins',
  'event_claim_geometries',
  'impact_versions',
  'impact_claim_support',
  'event_impact_refs',
  'audit_records',
  'publication_outbox',
  'publication_write_receipts',
] as const;
type FootprintTable = (typeof FOOTPRINT_TABLES)[number];
type PublicationFootprint = Record<FootprintTable, readonly Record<string, unknown>[]>;

interface ClaimFixture {
  readonly claimId: string;
  readonly text: string;
  readonly sourceId: string;
  readonly evidenceReferenceId: string;
  readonly originId: string;
  readonly proposalEvidence: ProposalEvidenceReference;
  readonly policyEvidence: EvidenceReference;
  readonly spanText: string;
  readonly spanStart: number;
}

interface Scenario {
  readonly proposal: EventProposal;
  readonly input: ManualPublicationServiceInput;
  readonly claimFixtures: readonly ClaimFixture[];
  readonly ids: {
    readonly eventId: string;
    readonly impactId: string;
    readonly decisionId: string;
    readonly idempotencyKey: string;
  };
}

describe('PUB-01 manual publication and public read-chain PGlite composition', () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    const migrations = await readMigrations(new URL('../migrations/', import.meta.url));
    await applyMigrations(db.executor, migrations);
    // The live namespace is only a fixture switch for this isolated test database.
    // No real source, source rights, reviewer identity, or factual quality is asserted.
    await db.executor.query(
      `INSERT INTO waspada.dataset_namespace_config (singleton, dataset_kind)
       VALUES (true, 'live')`,
    );
  });

  after(async () => db?.close());

  it('publishes both versions through the gate, then reads the correction through public handlers, history, and updates', async () => {
    const scenario = await seedScenario(db, 'positive');
    const reader = createSqlEventProposalReader(db.executor);
    const writer = new SqlPublicationWriter(db.executor);
    assert.ok(writer instanceof SqlPublicationWriter, 'the positive path receives the real SQL writer');
    const service = createManualPublicationService(reader, writer);
    const updateKey = await globalThis.crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    const updateService = createPublicEventUpdatesService({
      reader: createPublicEventUpdatesReader(db.executor),
      key: updateKey,
      now: () => Date.parse(NOW),
    });
    const baseline = await runAsPublicReader(db, () => updateService.read());
    assert.deepEqual(baseline.items, []);

    const privateBefore = await readPrivateProposal(db.executor, scenario.proposal.proposal_id);
    assertPrivateUnderReview(privateBefore);
    const emptyBefore = await readPublicationFootprint(db.executor, scenario.ids);
    assert.deepEqual(footprintCounts(emptyBefore), emptyFootprintCounts());

    const first = await runAsModeratorPublicationWriter(db, async () => {
      const strictRead = await reader.readLive(scenario.proposal.proposal_id);
      assert.deepEqual(strictRead, scenario.proposal);
      return service.publish(scenario.input);
    });
    assert.deepEqual(first, {
      status: 'written',
      receipt: {
        outcome: 'written',
        decisionId: scenario.ids.decisionId,
        eventId: scenario.ids.eventId,
        eventVersion: 1,
      },
    });

    const written = await readPublicationFootprint(db.executor, scenario.ids);
    assert.deepEqual(footprintCounts(written), {
      publication_decisions: 1,
      publication_claim_decisions: 2,
      publication_decision_evidence: 2,
      event_versions: 1,
      event_claims: 2,
      event_claim_evidence: 2,
      event_claim_origins: 2,
      event_claim_geometries: 0,
      impact_versions: 1,
      impact_claim_support: 2,
      event_impact_refs: 1,
      audit_records: 1,
      publication_outbox: 1,
      publication_write_receipts: 1,
    });
    assertPublishedLineage(written, scenario);
    const fingerprint = receiptFingerprint(written);
    assert.match(fingerprint, /^[0-9a-f]{64}$/u);

    const privateAfterWrite = await readPrivateProposal(db.executor, scenario.proposal.proposal_id);
    assert.deepEqual(privateAfterWrite, privateBefore);
    assertPrivateUnderReview(privateAfterWrite);

    const replay = await runAsModeratorPublicationWriter(db, () => service.publish(scenario.input));
    assert.deepEqual(replay, {
      status: 'replayed',
      receipt: {
        outcome: 'replayed',
        decisionId: scenario.ids.decisionId,
        eventId: scenario.ids.eventId,
        eventVersion: 1,
      },
    });
    const replayed = await readPublicationFootprint(db.executor, scenario.ids);
    assert.deepEqual(replayed, written, 'exact replay leaves all 14 publication tables unchanged');
    assert.equal(receiptFingerprint(replayed), fingerprint);
    assert.equal(replayed.publication_outbox.length, 1, 'one logical outbox notice remains');

    const changedLabels = [
      { claimId: 'claim-002', evidenceLabel: 'independent_corroboration' },
      { claimId: 'claim-001', evidenceLabel: 'issuer_notice' },
    ] as const;
    const changedInput: ManualPublicationServiceInput = {
      ...scenario.input,
      policyInput: {
        ...scenario.input.policyInput,
        moderatorDecision: {
          ...scenario.input.policyInput.moderatorDecision!,
          claimEvidenceLabels: changedLabels,
        },
      },
    };
    const changed = await runAsModeratorPublicationWriter(db, () => service.publish(changedInput));
    assert.deepEqual(changed, { status: 'conflict', code: 'idempotency_key_reused' });
    const afterConflict = await readPublicationFootprint(db.executor, scenario.ids);
    assert.deepEqual(afterConflict, written, 'changed-label conflict adds no publication rows');
    assert.equal(receiptFingerprint(afterConflict), fingerprint);
    assert.equal(afterConflict.publication_outbox.length, 1);

    const privateAfterConflict = await readPrivateProposal(db.executor, scenario.proposal.proposal_id);
    assert.deepEqual(privateAfterConflict, privateBefore);
    assertPrivateUnderReview(privateAfterConflict);

    // These rows are fictional exact-version review fixtures in this disposable
    // database. Their reviewer IDs and decisions do not represent real review,
    // reviewer identity, or authorization.
    await seedFictionalDisclosure(db.executor, {
      eventId: scenario.ids.eventId,
      eventVersion: 1,
      changeType: 'published',
      summary: FIRST_DISCLOSURE_SUMMARY,
      reviewedAt: NOW,
    });

    const correction = await seedCorrectionScenario(db, scenario);
    const corrected = await runAsModeratorPublicationWriter(db, async () => {
      const strictRead = await reader.readLive(correction.proposal.proposal_id);
      assert.deepEqual(strictRead, correction.proposal);
      return service.publish(correction.input);
    });
    assert.deepEqual(corrected, {
      status: 'written',
      receipt: {
        outcome: 'written',
        decisionId: correction.ids.decisionId,
        eventId: correction.ids.eventId,
        eventVersion: 2,
      },
    });
    await seedFictionalDisclosure(db.executor, {
      eventId: correction.ids.eventId,
      eventVersion: 2,
      changeType: 'corrected',
      summary: CORRECTION_DISCLOSURE_SUMMARY,
      reviewedAt: CORRECTION_AT,
    });

    const storedVersions = await db.executor.query<{
      readonly version: number;
      readonly supersedes_version: number | null;
      readonly published_at: string;
      readonly summary: string;
      readonly record_json: {
        readonly event_id: string;
        readonly version: number;
        readonly title: string;
        readonly summary: string;
        readonly category: string;
        readonly lifecycle: string;
        readonly published_at: string;
        readonly claims: readonly {
          readonly claim_id: string;
          readonly text: string;
          readonly evidence_label: string;
        }[];
      };
    }>(
      `SELECT version, supersedes_version, record_json->>'published_at' AS published_at,
              summary, record_json
       FROM waspada.event_versions
       WHERE dataset_kind = 'live' AND event_id = $1
       ORDER BY version`,
      [scenario.ids.eventId],
    );
    assert.deepEqual(storedVersions.rows.map(({ version, supersedes_version, published_at }) =>
      [version, supersedes_version, published_at]), [
      [1, null, NOW],
      [2, 1, CORRECTION_AT],
    ]);
    assert.equal(storedVersions.rows.length, 2);
    assert.deepEqual(storedVersions.rows.map(({ record_json }) =>
      record_json.claims.map(({ claim_id, evidence_label }) => [claim_id, evidence_label])), [
      [['claim-001', 'issuer_notice'], ['claim-002', 'crowdsourced_observation']],
      [['claim-001', 'issuer_notice'], ['claim-002', 'crowdsourced_observation']],
    ]);
    assert.deepEqual(storedVersions.rows.map(({ summary }) => summary), [
      'Authored synthetic summary; no real incident is asserted.',
      'Authored synthetic corrected summary; no real incident is asserted.',
    ]);

    // These owner-only rows are fictional test fixtures for the existing
    // public-reader views. They do not grant real source rights, names, or
    // reviewer identity, and are confined to this disposable PGlite database.
    await seedFictionalPublicLookups(db.executor, correction);
    const correctedRecord = storedVersions.rows.find(({ version }) => version === 2)?.record_json;
    assert.ok(correctedRecord, 'the corrected event version was persisted');
    await assertPublishedCorrectionHandlers(db, scenario, correction, correctedRecord);

    const historyService = createPublicEventHistoryProjectionService({
      candidates: createPublicEventHistoryRepository(db.executor),
      disclosures: createPublicEventHistoryDisclosureRepository(db.executor),
    });
    const history = await runAsPublicReader(db, () =>
      historyService.read(scenario.ids.eventId));
    assert.equal(history.kind, 'found');
    if (history.kind !== 'found') return;
    assert.deepEqual(history.page, {
      data: [
        {
          event_id: scenario.ids.eventId,
          version: 1,
          change_type: 'published',
          changed_at: NOW,
          summary: FIRST_DISCLOSURE_SUMMARY,
        },
        {
          event_id: scenario.ids.eventId,
          version: 2,
          change_type: 'corrected',
          changed_at: CORRECTION_AT,
          summary: CORRECTION_DISCLOSURE_SUMMARY,
        },
      ],
      page: { next_cursor: null, cursor_expires_at: null },
    });
    for (const entry of history.page.data) {
      assert.deepEqual(Object.keys(entry).sort(), [
        'change_type', 'changed_at', 'event_id', 'summary', 'version',
      ]);
    }
    assert.notEqual(history.page.data[0]?.summary, storedVersions.rows[0]?.summary);
    assert.notEqual(history.page.data[1]?.summary, storedVersions.rows[1]?.summary);

    const updates = await runAsPublicReader(db, async () =>
      db.executor.transaction(async (transaction) => {
        await transaction.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const pageService = createPublicEventUpdatesService({
          reader: createPublicEventUpdatesReader(transaction),
          key: updateKey,
          now: () => Date.parse(NOW),
        });
        return pageService.read({ cursor: baseline.next_cursor, limit: 10 });
      }));
    assert.deepEqual(updates.items, history.page.data);
    assert.deepEqual(Object.keys(updates).sort(), [
      'checked_at', 'cursor_expires_at', 'items', 'next_cursor',
    ]);
    for (const item of updates.items) {
      assert.deepEqual(Object.keys(item).sort(), [
        'change_type', 'changed_at', 'event_id', 'summary', 'version',
      ]);
    }
    const serializedPublicPages = JSON.stringify({ history: history.page, updates });
    for (const privateField of [
      'reviewer_id', 'reviewerId', 'fictional-reviewer-fixture-only',
      'proposal_id', 'trace_id', 'source_id', 'evidence_ref_id',
      'moderatorDecision', 'change_sequence',
    ]) {
      assert.equal(serializedPublicPages.includes(privateField), false,
        'public projections exclude private review, proposal, source, and evidence details');
    }
  });

  it('denies a stale evidence assessment before publication writes', async () => {
    const scenario = await seedScenario(db, 'stale');
    const staleInput: ManualPublicationServiceInput = {
      ...scenario.input,
      policyInput: {
        ...scenario.input.policyInput,
        currentEvidenceStates: scenario.input.policyInput.currentEvidenceStates.map((state, index) =>
          index === 0 ? { ...state, freshness: 'needs_update' } : state),
      },
    };
    const reader = createSqlEventProposalReader(db.executor);
    const writer = new SqlPublicationWriter(db.executor);
    const service = createManualPublicationService(reader, writer);
    const before = await readPublicationFootprint(db.executor, scenario.ids);
    assert.deepEqual(footprintCounts(before), emptyFootprintCounts());

    const result = await runAsModeratorPublicationWriter(db, async () => {
      assert.deepEqual(await reader.readLive(scenario.proposal.proposal_id), scenario.proposal);
      return service.publish(staleInput);
    });
    assert.deepEqual(result, { status: 'denied', code: 'publication_not_authorized' });
    const after = await readPublicationFootprint(db.executor, scenario.ids);
    assert.deepEqual(after, before, 'stale-policy denial leaves the complete publication footprint empty');
  });

  it('does not register the manual gate in Worker routes, scheduled handlers, or demo runtime', () => {
    const workerSource = new URL('../../worker/src/', import.meta.url);
    const matches: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.tsx?$/u.test(entry.name)
          && !path.endsWith('/layers/l4-application-integration/manual-publication-service.ts')
          && readFileSync(path, 'utf8').includes('manual-publication-service')) {
          matches.push(path);
        }
      }
    };
    visit(fileURLToPath(workerSource));
    assert.deepEqual(matches, []);
  });
});

async function seedScenario(database: TestDatabase, suffix: string): Promise<Scenario> {
  const traceId = `trace-pub-gate-${suffix}`;
  const sourceId = `source-pub-gate-${suffix}`;
  const revisionId = `revision-pub-gate-${suffix}`;
  const candidateId = `candidate-pub-gate-${suffix}`;
  const contextId = `context-pub-gate-${suffix}`;
  const proposalId = `proposal-pub-gate-${suffix}`;
  const eventId = `event-pub-gate-${suffix}`;
  const impactId = `impact-pub-gate-${suffix}`;
  const decisionId = `decision-pub-gate-${suffix}`;
  const idempotencyKey = `idempotency-pub-gate-${suffix}`;

  await database.executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'live', $2, 'open', $3::jsonb)`,
    [traceId, NOW, JSON.stringify({ fixture: 'authored synthetic test only' })],
  );
  await database.executor.query(
    `INSERT INTO waspada.source_registry
       (source_id, trace_id, registry_version, display_name, source_kind, remit,
        access_method, access_restrictions, reuse_basis, registry_status,
        approval_status, health_status, auto_acquisition_enabled, auto_publication_policy)
     VALUES ($1, $2, 1, 'Authored synthetic fixture only', 'other', ARRAY['test-only'],
        'manual_fixture', ARRAY['no real source rights are asserted'], ARRAY['synthetic fixture'],
        'active', 'approved', 'unknown', false, 'never')`,
    [sourceId, traceId],
  );
  await database.executor.query(
    `INSERT INTO waspada.report_revisions
       (dataset_kind, report_revision_id, trace_id, source_id, canonical_url,
        content_hash, permitted_text, permitted_text_hash, normalization_version,
        retrieved_at, revision_status, record_json)
     VALUES ('live', $1, $2, $3, 'https://example.invalid/synthetic-fixture',
        $4, $5, $4, 'synthetic-normalization-v1', $6, 'eligible', $7::jsonb)`,
    [revisionId, traceId, sourceId, REPORT_HASH, REPORT_TEXT, NOW,
      JSON.stringify({ fixture: 'authored synthetic; rights and quality not asserted' })],
  );
  await database.executor.query(
    `INSERT INTO waspada.extraction_results
       (dataset_kind, candidate_id, trace_id, report_revision_id, category, record_json)
     VALUES ('live', $1, $2, $3, 'transport_road_incidents', $4::jsonb)`,
    [candidateId, traceId, revisionId, JSON.stringify({ fixture: 'authored synthetic candidate' })],
  );
  await database.executor.query(
    `INSERT INTO waspada.grounding_contexts
       (dataset_kind, context_id, trace_id, candidate_id, retrieval_version,
        index_version, sufficient, record_json)
     VALUES ('live', $1, $2, $3, 'hybrid-evidence-v2', 'synthetic-index-v1', true, $4::jsonb)`,
    [contextId, traceId, candidateId, JSON.stringify({ fixture: 'authored synthetic context' })],
  );

  const claims: ClaimFixture[] = [];
  for (const [index, claimId] of ['claim-001', 'claim-002'].entries()) {
    const claimText = index === 0 ? 'Synthetic fixture claim one' : 'Synthetic fixture claim two';
    const spanStart = REPORT_TEXT.indexOf(claimText);
    const spanEnd = spanStart + Array.from(claimText).length;
    const originId = `origin-pub-gate-${suffix}-${index + 1}`;
    await database.executor.query(
      `INSERT INTO waspada.evidence_origins
         (dataset_kind, origin_id, trace_id, origin_kind, actor_label, source_id,
          lineage_relation, independence_status, record_json)
       VALUES ('live', $1, $2, 'original_document', 'Authored synthetic fixture only', $3,
          'original', 'unknown', $4::jsonb)`,
      [originId, traceId, sourceId, JSON.stringify({ fixture: 'synthetic provenance only' })],
    );
    const evidence = await database.executor.query<{ evidence_ref_id: string | number | bigint }>(
      `INSERT INTO waspada.evidence_references
         (dataset_kind, trace_id, report_revision_id, permitted_text_hash,
          span_start, span_end, offset_unit, relation)
       VALUES ('live', $1, $2, $3, $4, $5, 'unicode_code_points', 'supports')
       RETURNING evidence_ref_id::text AS evidence_ref_id`,
      [traceId, revisionId, REPORT_HASH, spanStart, spanEnd],
    );
    const evidenceReferenceId = String(evidence.rows[0]!.evidence_ref_id);
    await database.executor.query(
      `INSERT INTO waspada.grounding_evidence (dataset_kind, context_id, evidence_ref_id)
       VALUES ('live', $1, $2)`,
      [contextId, evidenceReferenceId],
    );
    await database.executor.query(
      `INSERT INTO waspada.origin_evidence (dataset_kind, origin_id, evidence_ref_id)
       VALUES ('live', $1, $2)`,
      [originId, evidenceReferenceId],
    );
    const proposalEvidence: ProposalEvidenceReference = {
      report_revision_id: revisionId,
      permitted_text_hash: REPORT_HASH,
      span_start: spanStart,
      span_end: spanEnd,
      offset_unit: 'unicode_code_points',
      relation: 'supports',
    };
    const policyEvidence: EvidenceReference = {
      reportRevisionId: revisionId,
      permittedTextHash: REPORT_HASH,
      spanStart,
      spanEnd,
      offsetUnit: 'unicode_code_points',
      relation: 'supports',
    };
    claims.push({
      claimId,
      text: claimText,
      sourceId,
      evidenceReferenceId,
      originId,
      proposalEvidence,
      policyEvidence,
      spanText: Array.from(REPORT_TEXT).slice(spanStart, spanEnd).join(''),
      spanStart,
    });
  }

  const proposal = makeProposal({
    proposal_id: proposalId,
    trace_id: traceId,
    candidate_id: candidateId,
    context_id: contextId,
    claims: claims.map((claim) => makeProposalClaim(claim, proposalId)),
  });
  await database.executor.query(
    `INSERT INTO waspada.event_proposals
       (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id,
        base_event_version, investigation_id, proposed_at, record_json)
     VALUES ('live', $1, $2, $3, $4, NULL, NULL, NULL, $5, $6::jsonb)`,
    [proposalId, traceId, candidateId, contextId, NOW, JSON.stringify(proposal)],
  );
  for (const claim of proposal.claims) {
    await database.executor.query(
      `INSERT INTO waspada.proposal_claims
         (dataset_kind, proposal_id, claim_id, support_assessment, evidence_label,
          claim_text, record_json)
       VALUES ('live', $1, $2, $3, $4, $5, $6::jsonb)`,
      [proposalId, claim.claim_id, claim.support_assessment, claim.evidence_label,
        claim.text, JSON.stringify(claim)],
    );
    const fixtureClaim = claims.find((entry) => entry.claimId === claim.claim_id)!;
    await database.executor.query(
      `INSERT INTO waspada.proposal_claim_evidence
         (dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id)
       VALUES ('live', $1, $2, 'support', $3)`,
      [proposalId, claim.claim_id, fixtureClaim.evidenceReferenceId],
    );
    await database.executor.query(
      `INSERT INTO waspada.proposal_claim_origins
         (dataset_kind, proposal_id, claim_id, origin_id)
       VALUES ('live', $1, $2, $3)`,
      [proposalId, claim.claim_id, fixtureClaim.originId],
    );
  }

  const input = makeServiceInput(proposal, claims, { eventId, impactId, decisionId, idempotencyKey });
  return { proposal, input, claimFixtures: claims, ids: { eventId, impactId, decisionId, idempotencyKey } };
}

async function seedCorrectionScenario(database: TestDatabase, initial: Scenario): Promise<Scenario> {
  const proposalId = initial.proposal.proposal_id + '-correction';
  const proposal: EventProposal = {
    ...initial.proposal,
    proposal_id: proposalId,
    event_id: initial.ids.eventId,
    base_event_version: 1,
    proposed_at: CORRECTION_AT,
    claims: initial.proposal.claims.map((claim) => ({
      ...claim,
      scope: claimScope(proposalId),
    })),
  };
  const decisionId = 'decision-' + proposalId;
  const idempotencyKey = 'idempotency-' + proposalId;

  await database.executor.query(
    [
      'INSERT INTO waspada.event_proposals',
      '  (dataset_kind, proposal_id, trace_id, candidate_id, context_id, event_id,',
      '   base_event_version, investigation_id, proposed_at, record_json)',
      "VALUES ('live', $1, $2, $3, $4, $5, 1, NULL, $6, $7::jsonb)",
    ].join('\n'),
    [proposalId, proposal.trace_id, proposal.candidate_id, proposal.context_id,
      initial.ids.eventId, CORRECTION_AT, JSON.stringify(proposal)],
  );
  for (const claim of proposal.claims) {
    await database.executor.query(
      [
        'INSERT INTO waspada.proposal_claims',
        '  (dataset_kind, proposal_id, claim_id, support_assessment, evidence_label, claim_text, record_json)',
        "VALUES ('live', $1, $2, $3, $4, $5, $6::jsonb)",
      ].join('\n'),
      [proposalId, claim.claim_id, claim.support_assessment, claim.evidence_label,
        claim.text, JSON.stringify(claim)],
    );
    const fixtureClaim = initial.claimFixtures.find((entry) => entry.claimId === claim.claim_id)!;
    await database.executor.query(
      [
        'INSERT INTO waspada.proposal_claim_evidence',
        '  (dataset_kind, proposal_id, claim_id, evidence_kind, evidence_ref_id)',
        "VALUES ('live', $1, $2, 'support', $3)",
      ].join('\n'),
      [proposalId, claim.claim_id, fixtureClaim.evidenceReferenceId],
    );
    await database.executor.query(
      [
        'INSERT INTO waspada.proposal_claim_origins',
        '  (dataset_kind, proposal_id, claim_id, origin_id)',
        "VALUES ('live', $1, $2, $3)",
      ].join('\n'),
      [proposalId, claim.claim_id, fixtureClaim.originId],
    );
  }

  const ids = {
    ...initial.ids,
    decisionId,
    idempotencyKey,
  };
  const input = makeServiceInput(proposal, initial.claimFixtures, ids, {
    target: { kind: 'update', eventId: initial.ids.eventId, baseVersion: 1 },
    publishedAt: CORRECTION_AT,
    eventSummary: 'Authored synthetic corrected summary; no real incident is asserted.',
    impactDescription: 'Authored synthetic corrected impact; no real condition is asserted.',
  });
  return { proposal, input, claimFixtures: initial.claimFixtures, ids };
}

async function seedFictionalDisclosure(
  executor: SqlExecutor,
  input: {
    readonly eventId: string;
    readonly eventVersion: number;
    readonly changeType: 'published' | 'corrected' | 'impact_changed' | 'retracted';
    readonly summary: string;
    readonly reviewedAt: string;
  },
): Promise<void> {
  await executor.query(
    'INSERT INTO waspada.public_event_history_review_decisions ' +
      '(dataset_kind, event_id, event_version, review_status, change_type, summary, reviewer_id, reviewed_at) ' +
      "VALUES ('live', $1, $2, 'approved', $3, $4, 'fictional-reviewer-fixture-only', $5)",
    [input.eventId, input.eventVersion, input.changeType, input.summary, input.reviewedAt],
  );
}

async function seedFictionalPublicLookups(executor: SqlExecutor, scenario: Scenario): Promise<void> {
  for (const claim of scenario.claimFixtures) {
    await executor.query(
      `INSERT INTO waspada.public_attribution_review_decisions
         (review_decision_id, dataset_kind, evidence_ref_id, report_revision_id,
          permitted_text_hash, span_start, span_end, offset_unit, relation, review_version,
          decision_status, rights_basis_ref, public_display_name, source_url,
          source_published_at, source_observed_at, reviewer_id, decision_reason, reviewed_at)
       VALUES ($1, 'live', $2, $3, $4, $5, $6, 'unicode_code_points', 'supports', 1,
         'approved', $7, $8, $9, NULL, NULL, $10, $11, $12)`,
      [
        `fictional-attribution-${claim.claimId}`,
        claim.evidenceReferenceId,
        claim.policyEvidence.reportRevisionId,
        claim.policyEvidence.permittedTextHash,
        claim.policyEvidence.spanStart,
        claim.policyEvidence.spanEnd,
        'synthetic-test-only-no-real-rights-asserted',
        PUBLIC_SOURCE_DISPLAY_NAME,
        PUBLIC_SOURCE_URL,
        'fictional-reviewer-fixture-only',
        'Authored fixture decision; no source rights or real review are asserted.',
        CORRECTION_AT,
      ],
    );
  }

  const scope = scenario.input.eventDraft.scope;
  const scopeEntities = [
    ...scope.place_ids.map((id) => ['place', id] as const),
    ...scope.service_ids.map((id) => ['service', id] as const),
    ...scope.institution_ids.map((id) => ['institution', id] as const),
    ...scope.audience_ids.map((id) => ['audience', id] as const),
  ];
  for (const [index, [entityType, entityId]] of scopeEntities.entries()) {
    await executor.query(
      `INSERT INTO waspada.scope_name_review_decisions
         (review_decision_id, entity_type, entity_id, locale, review_version,
          decision_status, display_name, provenance_ref, reviewer_id, decision_reason, reviewed_at)
       VALUES ($1, $2, $3, 'id-ID', 1, 'approved', $4, $5, $6, $7, $8)`,
      [
        `fictional-scope-name-${index + 1}`,
        entityType,
        entityId,
        `Authored synthetic ${entityType} name fixture`,
        'synthetic-test-only-no-real-provenance-asserted',
        'fictional-reviewer-fixture-only',
        'Authored fixture decision; no real name review is asserted.',
        CORRECTION_AT,
      ],
    );
  }
}

async function assertPublishedCorrectionHandlers(
  database: TestDatabase,
  initial: Scenario,
  correction: Scenario,
  persistedCurrent: {
    readonly event_id: string;
    readonly version: number;
    readonly title: string;
    readonly summary: string;
    readonly category: string;
    readonly lifecycle: string;
    readonly published_at: string;
    readonly claims: readonly {
      readonly claim_id: string;
      readonly text: string;
      readonly evidence_label: string;
    }[];
  },
): Promise<void> {
  let sqlOperations = 0;
  const withSqlExecutor = async <Result>(
    connectionString: string,
    operation: (executor: SqlExecutor) => Promise<Result>,
  ): Promise<Result> => {
    assert.equal(connectionString, TEST_CONNECTION_STRING);
    sqlOperations += 1;
    return runAsPublicReader(database, () => operation(database.executor));
  };
  const runtimeConfiguration = {
    datasetMode: 'live',
    connectionString: TEST_CONNECTION_STRING,
  } as const;
  const cursorHmacKeyHex = randomBytes(32).toString('hex');
  const listRuntime = await createPublicEventListRuntime({
    ...runtimeConfiguration,
    cursorHmacKeyHex,
  }, { withSqlExecutor, now: () => Date.parse(CORRECTION_AT) });
  const detailRuntime = createPublicEventDetailRuntime(runtimeConfiguration, { withSqlExecutor });
  assert.ok(listRuntime);
  assert.ok(detailRuntime);

  const environment: WorkerEnvironment = { DATASET_MODE: 'live' };
  const listOperations = sqlOperations;
  const listResponse = await handlePublicApiRequest(
    new Request('https://api.example.invalid/api/v1/events?limit=10'),
    environment,
    undefined,
    listRuntime,
    detailRuntime,
  );
  assert.equal(listResponse.status, 200);
  assert.equal(sqlOperations - listOperations, 1,
    'the public list handler uses one injected SQL operation under the public-reader role');
  const page = await listResponse.json() as EventPage;
  assert.equal(page.data.length, 1);
  const listed = page.data[0];
  assert.ok(listed);

  const detailOperations = sqlOperations;
  const detailResponse = await handlePublicApiRequest(
    new Request(`https://api.example.invalid/api/v1/events/${encodeURIComponent(correction.ids.eventId)}`),
    environment,
    undefined,
    listRuntime,
    detailRuntime,
  );
  assert.equal(detailResponse.status, 200);
  assert.equal(sqlOperations - detailOperations, 1,
    'the public detail handler uses one injected SQL operation under the public-reader role');
  const detail = await detailResponse.json() as EventDetail;

  assert.equal(persistedCurrent.event_id, correction.ids.eventId);
  for (const event of [listed, detail]) {
    assert.equal(event.event_id, persistedCurrent.event_id);
    assert.equal(event.version, persistedCurrent.version);
    assert.equal(event.title, persistedCurrent.title);
    assert.equal(event.summary, persistedCurrent.summary);
    assert.equal(event.category, persistedCurrent.category);
    assert.equal(event.lifecycle, persistedCurrent.lifecycle);
    assert.equal(event.published_at, persistedCurrent.published_at);
    assert.deepEqual(event.claims.map(({ claim_id, text, evidence_label }) => ({
      claim_id, text, evidence_label,
    })), persistedCurrent.claims.map(({ claim_id, text, evidence_label }) => ({
      claim_id, text, evidence_label,
    })));
    assert.deepEqual(event.claims.map(({ claim_id, evidence_label }) => [claim_id, evidence_label]), [
      ['claim-001', EXPECTED_LABELS['claim-001']],
      ['claim-002', EXPECTED_LABELS['claim-002']],
    ]);
  }
  assert.equal(listed.version, 2, 'the list returns the corrected current event version');
  assert.equal(detail.version, 2, 'the detail route returns the corrected current event version');
  assert.deepEqual(listed, (() => {
    const { geometries: _geometries, ...event } = detail;
    return event;
  })(), 'list and detail expose the same current public EventView');
  assert.deepEqual(detail.geometries, [], 'no unsupported geometry is inferred for the synthetic fixture');
  const expectedPublicScope = {
    places: [],
    services: ['Authored synthetic service name fixture'],
    institutions: [],
    audiences: ['Authored synthetic audience name fixture'],
  };

  const eventViewKeys = [
    'category', 'claims', 'event_id', 'event_time', 'freshness', 'impacts', 'lifecycle',
    'published_at', 'scope', 'summary', 'tags', 'title', 'validity', 'version',
  ].sort();
  assert.deepEqual(Object.keys(listed).sort(), eventViewKeys);
  assert.deepEqual(Object.keys(detail).sort(), [...eventViewKeys, 'geometries'].sort());
  for (const event of [listed, detail]) {
    assert.deepEqual(event.scope, expectedPublicScope);
    assert.deepEqual(Object.keys(event.scope).sort(), ['audiences', 'institutions', 'places', 'services']);
    assert.deepEqual(Object.keys(event.freshness).sort(), ['basis', 'evaluated_at', 'review_due_at', 'status']);
    for (const tag of event.tags) assert.deepEqual(Object.keys(tag).sort(), ['namespace', 'value']);
    for (const claim of event.claims) {
      assert.deepEqual(Object.keys(claim).sort(), [
        'claim_id', 'event_time', 'evidence_label', 'qualifiers', 'scope', 'sources', 'text', 'validity',
      ]);
      assert.deepEqual(Object.keys(claim.scope).sort(), ['audiences', 'institutions', 'places', 'services']);
      assert.deepEqual(claim.scope, expectedPublicScope);
      assert.equal(claim.sources.length, 1);
      assert.deepEqual(Object.keys(claim.sources[0]!).sort(), [
        'display_name', 'excerpt', 'observed_at', 'published_at', 'url',
      ]);
      assert.equal(claim.sources[0]?.display_name, PUBLIC_SOURCE_DISPLAY_NAME);
      assert.equal(claim.sources[0]?.url, PUBLIC_SOURCE_URL);
      assert.equal(claim.sources[0]?.excerpt, null, 'source excerpts are not public in these fixtures');
    }
    for (const impact of event.impacts) {
      assert.deepEqual(Object.keys(impact).sort(), [
        'description', 'event_time', 'freshness', 'impact_id', 'impact_type', 'lifecycle',
        'scope', 'title', 'validity', 'version',
      ]);
      assert.deepEqual(Object.keys(impact.scope).sort(), ['audiences', 'institutions', 'places', 'services']);
      assert.deepEqual(impact.scope, expectedPublicScope);
    }
  }
  for (const item of page.data) {
    assert.deepEqual(Object.keys(item).sort(), eventViewKeys);
  }

  const serializedPublicResult = JSON.stringify({ page, detail });
  for (const privateField of [
    'dataset_kind', 'trace_id', 'proposal_id', 'candidate_id', 'context_id',
    'publication_decision_id', 'reviewer_id', 'report_revision_id', 'permitted_text_hash',
    'span_start', 'span_end', 'evidence_ref_id', 'origin_ids', 'moderatorDecision',
  ]) {
    assert.equal(serializedPublicResult.includes(privateField), false,
      `public list/detail projections omit private field ${privateField}`);
  }
  for (const privateValue of [
    initial.proposal.proposal_id,
    initial.proposal.trace_id,
    initial.proposal.candidate_id,
    initial.proposal.context_id,
    correction.proposal.proposal_id,
    correction.proposal.trace_id,
    correction.proposal.candidate_id,
    correction.proposal.context_id,
    ...initial.claimFixtures.flatMap(({ sourceId, originId }) => [sourceId, originId]),
    ...correction.claimFixtures.flatMap(({ sourceId, originId }) => [sourceId, originId]),
    'fictional-reviewer-fixture-only',
    'synthetic-reviewer-fixture-only',
    REPORT_TEXT,
  ]) {
    assert.equal(serializedPublicResult.includes(privateValue), false,
      'public list/detail projections omit private proposal, source, evidence, and reviewer values');
  }
}

function makeProposal(overrides: Partial<EventProposal> = {}): EventProposal {
  return {
    schema_version: '2.0',
    trace_id: 'trace-pub-gate-default',
    record_type: 'EventProposal',
    dataset_kind: 'live',
    proposal_id: 'proposal-pub-gate-default',
    candidate_id: 'candidate-pub-gate-default',
    context_id: 'context-pub-gate-default',
    event_id: null,
    base_event_version: null,
    investigation_id: null,
    claims: [],
    unresolved_fields: [],
    model_runs: [{
      capability: 'reasoning',
      model_version: MODEL_RUN.modelVersion,
      prompt_version: MODEL_RUN.promptVersion,
      input_tokens: MODEL_RUN.inputTokens,
      output_tokens: MODEL_RUN.outputTokens,
    }],
    proposed_at: NOW,
    ...overrides,
  };
}

function makeProposalClaim(claim: ClaimFixture, proposalId: string): ProposalClaim {
  return {
    claim_id: claim.claimId,
    text: claim.text,
    event_time: { precision: 'unknown', start: null, end: null },
    validity: { valid_from: null, valid_until: null },
    scope: claimScope(proposalId),
    qualifiers: ['Authored synthetic fixture only.'],
    support: [claim.proposalEvidence],
    contradictions: [],
    context_evidence: [],
    origin_ids: [claim.originId],
    support_assessment: 'supported',
    evidence_label: 'under_review',
  };
}

function makeServiceInput(
  proposal: EventProposal,
  claims: readonly ClaimFixture[],
  ids: Scenario['ids'],
  options: {
    readonly target?: PublicationPolicyInput['target'];
    readonly publishedAt?: string;
    readonly eventSummary?: string;
    readonly impactDescription?: string;
  } = {},
): ManualPublicationServiceInput {
  const target = options.target ?? { kind: 'new' as const };
  const publishedAt = options.publishedAt ?? NOW;
  const version = target.kind === 'new' ? 1 : target.baseVersion + 1;
  const reasoningClaims: ProposedClaim[] = claims.map((claim) => ({
    text: claim.text,
    eventTime: { precision: 'unknown', start: null, end: null },
    validity: { validFrom: null, validUntil: null },
    scope: {
      placeIds: [],
      serviceIds: [`service-pub-gate-${proposal.proposal_id}`],
      institutionIds: [],
      audienceIds: [`audience-pub-gate-${proposal.proposal_id}`],
      geometryIds: [],
    },
    qualifiers: ['Authored synthetic fixture only.'],
    support: [claim.policyEvidence],
    contradictions: [],
    contextEvidence: [],
    supportAssessment: 'supported',
  }));
  const context: GroundingContext = {
    schemaVersion: '2.0',
    recordType: 'GroundingContext',
    datasetKind: 'live',
    traceId: proposal.trace_id,
    contextId: proposal.context_id,
    candidateId: proposal.candidate_id,
    evidence: claims.map((claim) => ({
      reference: claim.policyEvidence,
      text: claim.spanText,
      sourceId: claim.sourceId,
      revisionStatus: 'eligible' as const,
      publishedAt: null,
      observedAt: null,
      retrievedAt: NOW,
      origins: [{ originId: claim.originId, independenceStatus: 'unknown', dependsOnOriginIds: [] }],
    })),
    revisionStates: [{ reportRevisionId: claimRevisionId(claims), revisionStatus: 'eligible' }],
    candidateEvents: [],
    priorDecisionIds: [],
    missingFields: [],
    conflicts: [],
    retrievalVersion: 'hybrid-evidence-v2',
    indexVersion: 'synthetic-index-v1',
    sufficient: true,
  };
  const candidates = claims.map((claim) => makeRetrievalCandidate(proposal, claim));
  const retrieval = {
    datasetKind: 'live' as const,
    retrievalVersion: 'hybrid-evidence-v2' as const,
    indexVersion: 'synthetic-index-v1',
    candidates,
    rowsExamined: candidates.length,
    filteredRowsOmitted: 0,
    invalidSpanRowsOmitted: 0,
    scanTruncated: false,
    resultTruncated: false,
    semanticStatus: 'not_requested' as const,
  };
  const moderatorDecision: ExplicitModeratorDecision = {
    action: 'approve',
    actorId: 'synthetic-reviewer-fixture-only',
    decidedAt: options.publishedAt ?? NOW,
    reason: 'Synthetic test approval only; no reviewer identity or authorization is asserted.',
    trustedCallerAuthorized: true,
    // Deliberately reverse persisted claim order to prove exact claim_id mapping.
    claimEvidenceLabels: [
      { claimId: 'claim-002', evidenceLabel: EXPECTED_LABELS['claim-002'] },
      { claimId: 'claim-001', evidenceLabel: EXPECTED_LABELS['claim-001'] },
    ],
  };
  const currentEvidenceStates: readonly CurrentEvidenceState[] = claims.map((claim) => ({
    datasetKind: 'live',
    evidenceReferenceId: claim.evidenceReferenceId,
    sourceId: claim.sourceId,
    remit: 'in_scope' as const,
    freshness: 'current' as const,
  }));
  const policyInput: PublicationPolicyInput = {
    groundingContext: context,
    reasoningResult: {
      outcome: 'proposed',
      claims: reasoningClaims,
      unresolvedFields: [],
      conflicts: [],
      modelRun: MODEL_RUN,
      provider: 'synthetic-only',
    },
    retrieval,
    currentEvidenceStates,
    target,
    currentEvent: target.kind === 'new'
      ? null
      : { eventId: target.eventId, version: target.baseVersion },
    moderatorDecision,
  };
  const eventScope = claimScope(proposal.proposal_id);
  const event: PublicationEventVersionDraft = {
    event_id: ids.eventId,
    version,
    supersedes_version: target.kind === 'new' ? null : target.baseVersion,
    title: target.kind === 'new' ? 'Synthetic fixture event title' : 'Synthetic corrected fixture event title',
    summary: options.eventSummary ?? 'Authored synthetic summary; no real incident is asserted.',
    category: 'transport_road_incidents',
    tags: [],
    lifecycle: 'ongoing',
    freshness: { status: 'current', evaluated_at: NOW, review_due_at: null, basis: 'manual_review' },
    event_time: { start: null, end: null, precision: 'unknown' },
    validity: { valid_from: null, valid_until: null },
    scope: eventScope,
    published_at: publishedAt,
  };
  const impact: PublicationImpactVersionDraft = {
    impact_id: ids.impactId,
    version,
    event_id: ids.eventId,
    event_version: version,
    impact_type: 'facility_closure',
    title: 'Synthetic fixture impact',
    description: options.impactDescription ?? 'Authored synthetic impact; no current real-world condition is asserted.',
    lifecycle: 'ongoing',
    freshness: event.freshness,
    event_time: event.event_time,
    validity: event.validity,
    scope: eventScope,
    supporting_claim_ids: proposal.claims.map((claim) => claim.claim_id),
    published_at: publishedAt,
  };
  return {
    proposalId: proposal.proposal_id,
    policyInput,
    eventDraft: event,
    impactDrafts: [impact],
    writeMetadata: {
      idempotencyKey: ids.idempotencyKey,
      decisionId: ids.decisionId,
      policyVersion: 'synthetic-publication-policy-v1',
    },
  };
}

function makeRetrievalCandidate(proposal: EventProposal, claim: ClaimFixture): EvidenceRetrievalCandidate {
  return {
    datasetKind: 'live',
    candidateId: proposal.candidate_id,
    reportRevisionId: claim.policyEvidence.reportRevisionId,
    permittedTextHash: claim.policyEvidence.permittedTextHash,
    evidenceReferenceId: claim.evidenceReferenceId,
    spanStart: claim.policyEvidence.spanStart,
    spanEnd: claim.policyEvidence.spanEnd,
    offsetUnit: 'unicode_code_points',
    relation: 'supports',
    spanText: claim.spanText,
    spanTextStart: claim.spanStart,
    spanTextEnd: claim.spanStart + Array.from(claim.spanText).length,
    spanTextTruncated: false,
    revisionStatus: 'eligible',
    source: {
      sourceId: claim.sourceId,
      displayName: 'Authored synthetic fixture only',
      sourceKind: 'other',
      publisherGroupId: null,
      registryStatus: 'active',
      approvalStatus: 'approved',
      healthStatus: 'unknown',
    },
    publishedAt: null,
    observedAt: null,
    retrievedAt: NOW,
    validFrom: null,
    validUntil: null,
    eventTime: { start: null, end: null, precision: 'unknown', status: 'unknown' },
    origins: [{
      originId: claim.originId,
      originKind: 'original_document',
      sourceId: claim.sourceId,
      lineageRelation: 'original',
      independenceStatus: 'unknown',
      dependsOnOriginIds: [],
    }],
    originLineageStatus: 'recorded',
    geometryMatches: [],
    chunk: null,
    matchFacets: {
      identifiers: [],
      audienceIds: [],
      exactTerms: [],
      reportTimeFields: [],
      eventTime: false,
      geometry: false,
      semanticDistance: null,
    },
  };
}

function claimRevisionId(claims: readonly ClaimFixture[]): string {
  const revisionId = claims[0]?.policyEvidence.reportRevisionId;
  if (!revisionId || claims.some((claim) => claim.policyEvidence.reportRevisionId !== revisionId)) {
    throw new Error('synthetic fixture claims must share their authored report revision');
  }
  return revisionId;
}

function claimScope(id = 'default'): ProposalClaim['scope'] {
  return {
    place_ids: [],
    service_ids: [`service-pub-gate-${id}`],
    institution_ids: [],
    audience_ids: [`audience-pub-gate-${id}`],
    geometry_ids: [],
  };
}

async function runAsModeratorPublicationWriter<Result>(
  database: TestDatabase,
  operation: () => Promise<Result>,
): Promise<Result> {
  await database.executor.execute('SET ROLE waspada_l4_moderator_publication_writer');
  try {
    const role = await database.executor.query<{ current_user: string }>('SELECT current_user');
    assert.equal(role.rows[0]?.current_user, 'waspada_l4_moderator_publication_writer');
    return await operation();
  } finally {
    await database.executor.execute('RESET ROLE');
  }
}

async function runAsPublicReader<Result>(
  database: TestDatabase,
  operation: () => Promise<Result>,
): Promise<Result> {
  await database.executor.execute('SET ROLE waspada_public_reader');
  try {
    const role = await database.executor.query<{ current_user: string }>('SELECT current_user');
    assert.equal(role.rows[0]?.current_user, 'waspada_public_reader');
    return await operation();
  } finally {
    await database.executor.execute('RESET ROLE');
  }
}

async function readPrivateProposal(executor: SqlExecutor, proposalId: string): Promise<unknown> {
  const proposal = await executor.query<{ record_json: Record<string, unknown> }>(
    `SELECT record_json FROM waspada.event_proposals WHERE dataset_kind = 'live' AND proposal_id = $1`,
    [proposalId],
  );
  const claims = await executor.query<{
    claim_id: string;
    evidence_label: string;
    record_json: Record<string, unknown>;
  }>(
    `SELECT claim_id, evidence_label, record_json FROM waspada.proposal_claims
     WHERE dataset_kind = 'live' AND proposal_id = $1 ORDER BY claim_id`,
    [proposalId],
  );
  return { record_json: proposal.rows[0]?.record_json, claims: claims.rows };
}

function assertPrivateUnderReview(value: unknown): void {
  const snapshot = value as {
    readonly record_json: { readonly claims: readonly { readonly claim_id: string; readonly evidence_label: string }[] };
    readonly claims: readonly { readonly claim_id: string; readonly evidence_label: string; readonly record_json: { readonly evidence_label: string } }[];
  };
  assert.ok(snapshot.record_json);
  assert.deepEqual(snapshot.record_json.claims.map(({ claim_id, evidence_label }) => [claim_id, evidence_label]), [
    ['claim-001', 'under_review'],
    ['claim-002', 'under_review'],
  ]);
  assert.deepEqual(snapshot.claims.map(({ claim_id, evidence_label, record_json }) => [claim_id, evidence_label, record_json.evidence_label]), [
    ['claim-001', 'under_review', 'under_review'],
    ['claim-002', 'under_review', 'under_review'],
  ]);
}

async function readPublicationFootprint(
  executor: SqlExecutor,
  ids: Scenario['ids'],
): Promise<PublicationFootprint> {
  const scopes: readonly [FootprintTable, string, readonly unknown[]][] = [
    ['publication_decisions', 'dataset_kind = \'live\' AND decision_id = $1', [ids.decisionId]],
    ['publication_claim_decisions', 'dataset_kind = \'live\' AND decision_id = $1', [ids.decisionId]],
    ['publication_decision_evidence', 'dataset_kind = \'live\' AND decision_id = $1', [ids.decisionId]],
    ['event_versions', 'dataset_kind = \'live\' AND event_id = $1', [ids.eventId]],
    ['event_claims', 'dataset_kind = \'live\' AND event_id = $1', [ids.eventId]],
    ['event_claim_evidence', 'dataset_kind = \'live\' AND event_id = $1', [ids.eventId]],
    ['event_claim_origins', 'dataset_kind = \'live\' AND event_id = $1', [ids.eventId]],
    ['event_claim_geometries', 'dataset_kind = \'live\' AND event_id = $1', [ids.eventId]],
    ['impact_versions', 'dataset_kind = \'live\' AND impact_id = $1', [ids.impactId]],
    ['impact_claim_support', 'dataset_kind = \'live\' AND impact_id = $1', [ids.impactId]],
    ['event_impact_refs', 'dataset_kind = \'live\' AND event_id = $1', [ids.eventId]],
    ['audit_records', "dataset_kind = 'live' AND entity_type = 'event_version' AND entity_id = $1", [`${ids.eventId}:1`]],
    ['publication_outbox', 'dataset_kind = \'live\' AND event_id = $1 AND event_version = 1', [ids.eventId]],
    ['publication_write_receipts', 'dataset_kind = \'live\' AND idempotency_key = $1', [ids.idempotencyKey]],
  ];
  const entries = await Promise.all(scopes.map(async ([table, predicate, parameters]) => {
    const result = await executor.query<{ rows: readonly Record<string, unknown>[] }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows
       FROM waspada.${table} AS t WHERE ${predicate}`,
      parameters,
    );
    return [table, result.rows[0]?.rows ?? []] as const;
  }));
  return Object.fromEntries(entries) as PublicationFootprint;
}

function footprintCounts(footprint: PublicationFootprint): Record<FootprintTable, number> {
  return Object.fromEntries(FOOTPRINT_TABLES.map((table) => [table, footprint[table].length])) as Record<FootprintTable, number>;
}

function emptyFootprintCounts(): Record<FootprintTable, number> {
  return Object.fromEntries(FOOTPRINT_TABLES.map((table) => [table, 0])) as Record<FootprintTable, number>;
}

function assertPublishedLineage(footprint: PublicationFootprint, scenario: Scenario): void {
  const expectedLabels: Record<string, string> = EXPECTED_LABELS;
  const decision = footprint.publication_decisions[0] as {
    readonly trace_id: string;
    readonly proposal_id: string;
    readonly policy_version: string;
    readonly event_id: string;
    readonly event_version: number;
    readonly reviewer_id: string;
    readonly record_json: { readonly claim_decisions: readonly Record<string, unknown>[] };
  };
  assert.equal(decision.trace_id, scenario.proposal.trace_id);
  assert.equal(decision.proposal_id, scenario.proposal.proposal_id);
  assert.equal(decision.policy_version, 'synthetic-publication-policy-v1');
  assert.equal(decision.event_id, scenario.ids.eventId);
  assert.equal(decision.event_version, 1);
  assert.equal(decision.reviewer_id, 'synthetic-reviewer-fixture-only');
  const decisionClaims = decision.record_json.claim_decisions;
  assert.deepEqual(labelsByClaim(decisionClaims), expectedLabels);
  assert.ok(decision.record_json.claim_decisions.every((claim) => claim.disposition === 'publish'));
  assert.deepEqual(decisionEvidenceDetailsByClaim(decisionClaims), expectedDecisionEvidenceDetails(scenario));

  const event = footprint.event_versions[0] as {
    readonly trace_id: string;
    readonly publication_decision_id: string;
    readonly record_json: { readonly claims: readonly Record<string, unknown>[]; readonly impact_refs: readonly Record<string, unknown>[] };
  };
  assert.equal(event.trace_id, scenario.proposal.trace_id);
  assert.equal(event.publication_decision_id, scenario.ids.decisionId);
  assert.deepEqual(labelsByClaim(event.record_json.claims), expectedLabels);
  assert.deepEqual(event.record_json.impact_refs, [{ impact_id: scenario.ids.impactId, version: 1 }]);

  const normalizedClaims = footprint.event_claims as readonly {
    readonly claim_id: string;
    readonly evidence_label: string;
    readonly record_json: Record<string, unknown>;
  }[];
  assert.deepEqual(labelsByClaim(normalizedClaims), expectedLabels);
  for (const claim of normalizedClaims) {
    assert.equal(claim.record_json.evidence_label, expectedLabels[claim.claim_id]);
  }
  assert.deepEqual(claimIds(footprint.publication_claim_decisions), ['claim-001', 'claim-002']);
  assert.ok(footprint.publication_claim_decisions.every((row) => row.disposition === 'publish'));
  assert.deepEqual(claimIds(footprint.publication_decision_evidence), ['claim-001', 'claim-002']);
  assert.deepEqual(eventEvidenceDetailsByClaim(footprint.event_claim_evidence), expectedEventEvidenceDetails(scenario));
  assert.deepEqual(evidenceByClaim(footprint.publication_decision_evidence), expectedEvidenceByClaim(scenario));
  assert.deepEqual(originDetailsByClaim(footprint.event_claim_origins), Object.fromEntries(
    scenario.claimFixtures.map((claim) => [claim.claimId, claim.originId]).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ));
  assert.deepEqual(impactSupportByClaim(footprint.impact_claim_support), Object.fromEntries(
    scenario.claimFixtures.map((claim) => [claim.claimId, [scenario.ids.impactId, 1, scenario.ids.eventId, 1]])
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ));
  assert.deepEqual(footprint.event_impact_refs.map((row) => [row.event_id, row.event_version, row.impact_id, row.impact_version]), [
    [scenario.ids.eventId, 1, scenario.ids.impactId, 1],
  ]);

  const impact = footprint.impact_versions[0] as { readonly trace_id: string; readonly event_id: string; readonly event_version: number };
  assert.equal(impact.trace_id, scenario.proposal.trace_id);
  assert.equal(impact.event_id, scenario.ids.eventId);
  assert.equal(impact.event_version, 1);

  const audit = footprint.audit_records[0] as {
    readonly trace_id: string;
    readonly actor_id: string;
    readonly action: string;
    readonly entity_id: string;
    readonly details: Record<string, unknown>;
  };
  assert.equal(audit.trace_id, scenario.proposal.trace_id);
  assert.equal(audit.actor_id, 'synthetic-reviewer-fixture-only');
  assert.equal(audit.action, 'publication_event_version_committed');
  assert.equal(audit.entity_id, `${scenario.ids.eventId}:1`);
  assert.deepEqual(audit.details, {
    proposal_id: scenario.proposal.proposal_id,
    decision_id: scenario.ids.decisionId,
    event_id: scenario.ids.eventId,
    event_version: 1,
    policy_version: 'synthetic-publication-policy-v1',
  });

  const receipt = footprint.publication_write_receipts[0] as {
    readonly idempotency_key: string;
    readonly request_fingerprint: string;
    readonly decision_id: string;
    readonly event_id: string;
    readonly event_version: number;
  };
  assert.equal(receipt.idempotency_key, scenario.ids.idempotencyKey);
  assert.equal(receipt.decision_id, scenario.ids.decisionId);
  assert.equal(receipt.event_id, scenario.ids.eventId);
  assert.equal(receipt.event_version, 1);
  assert.match(receipt.request_fingerprint, /^[0-9a-f]{64}$/u);

  const outbox = footprint.publication_outbox[0] as {
    readonly dataset_kind: string;
    readonly event_id: string;
    readonly event_version: number;
    readonly event_kind: string;
    readonly trace_id: string;
    readonly occurred_at: string;
  };
  assert.equal(outbox.dataset_kind, 'live');
  assert.equal(outbox.event_id, scenario.ids.eventId);
  assert.equal(outbox.event_version, 1);
  assert.equal(outbox.event_kind, 'event_version_published');
  assert.equal(outbox.trace_id, scenario.proposal.trace_id);
  assert.equal(new Date(outbox.occurred_at).toISOString(), new Date(NOW).toISOString());

  const publicationJson = JSON.stringify([
    decision.record_json,
    event.record_json,
    normalizedClaims.map(({ record_json }) => record_json),
  ]);
  assert.equal(publicationJson.includes('under_review'), false);
}

function labelsByClaim(rows: readonly Record<string, unknown>[]): Record<string, string> {
  return Object.fromEntries(rows
    .map((row) => [String(row.claim_id), String(row.evidence_label)] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function claimIds(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => String(row.claim_id)).sort();
}

function evidenceByClaim(rows: readonly Record<string, unknown>[]): Record<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const claimId = String(row.claim_id);
    const evidenceRefId = String(row.evidence_ref_id);
    const group = grouped.get(claimId) ?? [];
    group.push(evidenceRefId);
    grouped.set(claimId, group);
  }
  return Object.fromEntries([...grouped.entries()]
    .map(([claimId, values]) => [claimId, values.sort()] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function decisionEvidenceDetailsByClaim(
  claimDecisions: readonly Record<string, unknown>[],
): Record<string, readonly Record<string, unknown>[]> {
  const details: Record<string, readonly Record<string, unknown>[]> = {};
  for (const decision of claimDecisions) {
    assert.ok(Array.isArray(decision.evidence));
    details[String(decision.claim_id)] = decision.evidence.map((entry: unknown) => {
      assert.ok(typeof entry === 'object' && entry !== null && !Array.isArray(entry));
      return entry as Record<string, unknown>;
    });
  }
  return Object.fromEntries(Object.entries(details)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function expectedDecisionEvidenceDetails(scenario: Scenario): Record<string, readonly Record<string, unknown>[]> {
  return Object.fromEntries(scenario.claimFixtures
    .map((claim) => [claim.claimId, [{ ...claim.proposalEvidence }]] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function eventEvidenceDetailsByClaim(rows: readonly Record<string, unknown>[]): Record<string, readonly unknown[]> {
  const details = new Map<string, unknown[]>();
  for (const row of rows) {
    const claimId = String(row.claim_id);
    const entries = details.get(claimId) ?? [];
    entries.push([String(row.evidence_ref_id), String(row.evidence_kind)]);
    details.set(claimId, entries);
  }
  return Object.fromEntries([...details.entries()]
    .map(([claimId, values]) => [claimId, values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function expectedEventEvidenceDetails(scenario: Scenario): Record<string, readonly unknown[]> {
  return Object.fromEntries(scenario.claimFixtures
    .map((claim) => [claim.claimId, [[claim.evidenceReferenceId, 'support']]] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function expectedEvidenceByClaim(scenario: Scenario): Record<string, readonly string[]> {
  return Object.fromEntries(scenario.claimFixtures
    .map((claim) => [claim.claimId, [claim.evidenceReferenceId]] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function originDetailsByClaim(rows: readonly Record<string, unknown>[]): Record<string, string> {
  return Object.fromEntries(rows
    .map((row) => [String(row.claim_id), String(row.origin_id)] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function impactSupportByClaim(rows: readonly Record<string, unknown>[]): Record<string, readonly unknown[]> {
  return Object.fromEntries(rows
    .map((row) => [String(row.claim_id), [String(row.impact_id), Number(row.impact_version), String(row.event_id), Number(row.event_version)]] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function receiptFingerprint(footprint: PublicationFootprint): string {
  const row = footprint.publication_write_receipts[0];
  assert.ok(row);
  return String(row.request_fingerprint);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
