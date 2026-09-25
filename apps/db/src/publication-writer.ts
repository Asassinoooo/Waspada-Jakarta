import { createHash, randomUUID } from 'node:crypto';
import type { SqlExecutor, SqlTransactionRunner } from './sql.js';

export type PublicationDisposition = 'publish' | 'review' | 'reject' | 'retract';
export type PublicationLifecycle = 'planned' | 'ongoing' | 'resolved' | 'cancelled' | 'unknown';
export type PublicationCategory =
  | 'crime_personal_security'
  | 'demonstrations_public_gatherings'
  | 'crowds_major_events'
  | 'violence_immediate_threats'
  | 'disasters_weather'
  | 'fires_infrastructure_hazards'
  | 'transport_road_incidents'
  | 'utilities_essential_services'
  | 'health_environmental_advisories'
  | 'group_specific_critical_notices';

export interface PublicationEvidenceReference {
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly offset_unit: 'unicode_code_points';
  readonly relation: 'supports' | 'contradicts' | 'context';
}

export interface PublicationClaimDecision {
  readonly claim_id: string;
  readonly disposition: PublicationDisposition;
  readonly reason_codes: readonly string[];
  readonly evidence: readonly PublicationEvidenceReference[];
}

export interface TrustedModeratorApproval {
  readonly action: 'approve';
  /** Asserted by the trusted L4 caller after authorization; this writer does not authenticate. */
  readonly trusted_caller_authorized: true;
  readonly actor_id: string;
  readonly decided_at: string;
  readonly reason: string;
}

export interface PublicationEventTarget {
  readonly event_id: string | null;
  readonly base_event_version: number | null;
}

export interface PublicationTimeScope {
  readonly start: string | null;
  readonly end: string | null;
  readonly precision: 'exact' | 'date' | 'range' | 'unknown';
}

export interface PublicationValidityPeriod {
  readonly valid_from: string | null;
  readonly valid_until: string | null;
}

export interface PublicationFreshness {
  readonly status: 'current' | 'needs_update' | 'expired';
  readonly evaluated_at: string;
  readonly review_due_at: string | null;
  readonly basis: 'source_validity' | 'fast_observation_review' | 'undated_advisory_review' | 'manual_review' | 'unknown';
}

export interface PublicationTag {
  readonly namespace: 'topic' | 'service' | 'audience' | 'hazard' | 'transport_mode' | 'place_type';
  readonly value: string;
}

export interface PublicationScope {
  readonly place_ids: readonly string[];
  readonly service_ids: readonly string[];
  readonly institution_ids: readonly string[];
  readonly audience_ids: readonly string[];
  readonly geometry_ids: readonly string[];
}

export interface PublicationEventVersionDraft {
  readonly event_id: string;
  readonly version: number;
  readonly supersedes_version: number | null;
  readonly title: string;
  readonly summary: string;
  readonly category: PublicationCategory;
  readonly tags: readonly PublicationTag[];
  readonly lifecycle: PublicationLifecycle;
  readonly freshness: PublicationFreshness;
  readonly event_time: PublicationTimeScope;
  readonly validity: PublicationValidityPeriod;
  readonly scope: PublicationScope;
  readonly published_at: string;
}

export interface PublicationImpactVersionDraft {
  readonly impact_id: string;
  readonly version: number;
  readonly event_id: string;
  readonly event_version: number;
  readonly impact_type:
    | 'road_closure'
    | 'traffic_diversion'
    | 'transport_service_disruption'
    | 'facility_closure'
    | 'utility_outage'
    | 'hazard_observation'
    | 'public_access_restriction'
    | 'event_attendance'
    | 'audience_notice'
    | 'other';
  readonly title: string;
  readonly description: string;
  readonly lifecycle: PublicationLifecycle;
  readonly freshness: PublicationFreshness;
  readonly event_time: PublicationTimeScope;
  readonly validity: PublicationValidityPeriod;
  readonly scope: PublicationScope;
  readonly supporting_claim_ids: readonly string[];
  readonly published_at: string;
}

/** The typed command accepted from the trusted Layer 4 composition. */
export interface PublicationWriteCommand {
  readonly datasetKind: 'live';
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly proposalId: string;
  readonly decisionId: string;
  readonly policyVersion: string;
  readonly expectedTarget: PublicationEventTarget;
  readonly moderatorApproval: TrustedModeratorApproval;
  readonly claimDecisions: readonly PublicationClaimDecision[];
  readonly event: PublicationEventVersionDraft;
  readonly impacts: readonly PublicationImpactVersionDraft[];
}

export interface PublicationWriteReceipt {
  readonly outcome: 'written' | 'replayed';
  readonly decisionId: string;
  readonly eventId: string;
  readonly eventVersion: number;
}

export interface PublicationWriteConflict {
  readonly outcome: 'conflict';
  readonly code: 'idempotency_key_reused' | 'stale_event_version' | 'event_version_exists';
}

export type PublicationWriteResult = PublicationWriteReceipt | PublicationWriteConflict;

export type PublicationWriteErrorCode =
  | 'invalid_command'
  | 'moderator_approval_required'
  | 'live_dataset_namespace_required'
  | 'proposal_not_found'
  | 'publication_evidence_invalid';

export class PublicationWriteError extends Error {
  constructor(readonly code: PublicationWriteErrorCode, message: string) {
    super(message);
    this.name = 'PublicationWriteError';
  }
}

interface ParsedEvidenceReference extends PublicationEvidenceReference {}

interface ParsedClaimDecision extends PublicationClaimDecision {
  readonly evidence: readonly ParsedEvidenceReference[];
}

interface ParsedCommand extends PublicationWriteCommand {
  readonly claimDecisions: readonly ParsedClaimDecision[];
}

interface ProposalRow {
  readonly trace_id: string;
  readonly candidate_id: string;
  readonly context_id: string;
  readonly event_id: string | null;
  readonly base_event_version: number | null;
  readonly record_json: unknown;
}

interface ProposalClaimRow {
  readonly claim_id: string;
  readonly support_assessment: string;
  readonly evidence_label: string;
  readonly claim_text: string;
  readonly record_json: unknown;
}

interface ProposalClaimRelationRow {
  readonly claim_id: string;
  readonly evidence_kind: 'support' | 'contradiction' | 'context';
  readonly evidence_ref_id: string;
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly offset_unit: string;
  readonly relation: string;
  readonly in_grounding_context: boolean;
}

interface ProposalOriginRow {
  readonly claim_id: string;
  readonly origin_id: string;
}

interface ReceiptRow {
  readonly request_fingerprint: string;
  readonly decision_id: string;
  readonly event_id: string;
  readonly event_version: number;
}

interface IdRow {
  readonly id: string;
}

interface VersionRow {
  readonly version: number;
}

interface StoredProposalClaim {
  readonly claimId: string;
  readonly assessment: 'supported' | 'uncertain' | 'disputed';
  readonly evidenceLabel: 'issuer_notice' | 'attributed_report' | 'independent_corroboration' | 'crowdsourced_observation';
  readonly claimText: string;
  readonly record: ProposalClaimDocument;
}

interface ProposalClaimDocument {
  readonly claim_id: string;
  readonly text: string;
  readonly event_time: PublicationTimeScope;
  readonly validity: PublicationValidityPeriod;
  readonly scope: PublicationScope;
  readonly qualifiers: readonly string[];
  readonly support: readonly PublicationEvidenceReference[];
  readonly contradictions: readonly PublicationEvidenceReference[];
  readonly context_evidence: readonly PublicationEvidenceReference[];
  readonly origin_ids: readonly string[];
  readonly support_assessment: 'supported' | 'uncertain' | 'disputed';
  readonly evidence_label: StoredProposalClaim['evidenceLabel'];
}

interface ResolvedClaim {
  readonly proposal: StoredProposalClaim;
  readonly publishedClaim: Readonly<Record<string, unknown>>;
  readonly evidenceByKind: Readonly<{
    support: readonly string[];
    contradiction: readonly string[];
    context: readonly string[];
  }>;
}

const categories = new Set<PublicationCategory>([
  'crime_personal_security', 'demonstrations_public_gatherings', 'crowds_major_events',
  'violence_immediate_threats', 'disasters_weather', 'fires_infrastructure_hazards',
  'transport_road_incidents', 'utilities_essential_services', 'health_environmental_advisories',
  'group_specific_critical_notices',
]);
const lifecycles = new Set<PublicationLifecycle>(['planned', 'ongoing', 'resolved', 'cancelled', 'unknown']);
const dispositions = new Set<PublicationDisposition>(['publish', 'review', 'reject', 'retract']);
const impactTypes = new Set<PublicationImpactVersionDraft['impact_type']>([
  'road_closure', 'traffic_diversion', 'transport_service_disruption', 'facility_closure',
  'utility_outage', 'hazard_observation', 'public_access_restriction', 'event_attendance',
  'audience_notice', 'other',
]);
const referenceKinds = new Map<PublicationEvidenceReference['relation'], ProposalClaimRelationRow['evidence_kind']>([
  ['supports', 'support'],
  ['contradicts', 'contradiction'],
  ['context', 'context'],
]);
const recordLabels = new Set<StoredProposalClaim['evidenceLabel']>([
  'issuer_notice', 'attributed_report', 'independent_corroboration', 'crowdsourced_observation',
]);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const rfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Persist one manually approved event version and its impact set atomically.
 * Identity/authentication belongs to the trusted L4 caller (MOD-01 when wired).
 */
export class SqlPublicationWriter {
  constructor(private readonly transactions: SqlTransactionRunner) {}

  async publish(input: PublicationWriteCommand): Promise<PublicationWriteResult> {
    const command = parseCommand(input as unknown);
    const requestFingerprint = createHash('sha256')
      .update(canonicalJson(command), 'utf8')
      .digest('hex');
    try {
      return await this.transactions.transaction((transaction) =>
        this.publishInTransaction(transaction, command, requestFingerprint));
    } catch (error) {
      if (isUniqueViolation(error, 'event_versions_pkey')) {
        return { outcome: 'conflict', code: 'event_version_exists' };
      }
      throw error;
    }
  }

  private async publishInTransaction(
    transaction: SqlExecutor,
    command: ParsedCommand,
    requestFingerprint: string,
  ): Promise<PublicationWriteResult> {
    const namespace = await transaction.query<{ dataset_kind: string }>(
      'SELECT dataset_kind FROM waspada.dataset_namespace_config LIMIT 1',
    );
    if (namespace.rows[0]?.dataset_kind !== 'live') {
      throw new PublicationWriteError(
        'live_dataset_namespace_required',
        'The configured dataset namespace must be live before publication writes are allowed',
      );
    }

    await lockKey(transaction, 'publication-idempotency', command.idempotencyKey);
    const existing = await transaction.query<ReceiptRow>(
      `SELECT request_fingerprint, decision_id, event_id, event_version
       FROM waspada.publication_write_receipts
       WHERE dataset_kind = $1 AND idempotency_key = $2`,
      ['live', command.idempotencyKey],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (prior.request_fingerprint !== requestFingerprint) {
        return { outcome: 'conflict', code: 'idempotency_key_reused' };
      }
      return {
        outcome: 'replayed',
        decisionId: prior.decision_id,
        eventId: prior.event_id,
        eventVersion: Number(prior.event_version),
      };
    }

    const trace = await transaction.query<{ trace_id: string }>(
      `SELECT trace_id FROM waspada.traces
       WHERE trace_id = $1 AND dataset_kind = $2`,
      [command.traceId, command.datasetKind],
    );
    if (!trace.rows[0]) {
      throw new PublicationWriteError('invalid_command', 'The publication trace does not exist in the live dataset');
    }

    const proposalResult = await transaction.query<ProposalRow>(
      `SELECT trace_id, candidate_id, context_id, event_id, base_event_version, record_json
       FROM waspada.event_proposals
       WHERE dataset_kind = $1 AND proposal_id = $2`,
      [command.datasetKind, command.proposalId],
    );
    const proposalRow = proposalResult.rows[0];
    if (!proposalRow) {
      throw new PublicationWriteError('proposal_not_found', 'The event proposal does not exist in the live dataset');
    }
    if (proposalRow.trace_id !== command.traceId) {
      throw new PublicationWriteError('invalid_command', 'The command trace must match its stored proposal trace');
    }
    const proposal = parseStoredProposal(proposalRow, command);

    await lockKey(transaction, 'publication-event', command.event.event_id);
    const current = await transaction.query<{ current_version: number | null }>(
      `SELECT max(version)::integer AS current_version
       FROM waspada.event_versions
       WHERE dataset_kind = $1 AND event_id = $2`,
      [command.datasetKind, command.event.event_id],
    );
    const currentVersion = current.rows[0]?.current_version ?? null;
    const versionConflict = checkCurrentVersion(command, currentVersion);
    if (versionConflict) return versionConflict;

    const impactLocks = [...command.impacts].map(({ impact_id }) => impact_id).sort();
    for (const impactId of impactLocks) await lockKey(transaction, 'publication-impact', impactId);

    const claims = await loadProposalClaims(transaction, command, proposal);
    validateClaimDecisions(command, claims);
    const publishedClaims = await resolvePublishedClaims(transaction, command, proposal, claims);
    if (publishedClaims.length === 0) invalid('An approved publication needs at least one publishable claim');
    await validateEventGeometryReferences(transaction, command, publishedClaims);
    await validateImpactVersions(transaction, command);

    await writeDecision(transaction, command, proposal, publishedClaims);
    await writeEventVersion(transaction, command, publishedClaims);
    await writeImpacts(transaction, command, publishedClaims);
    await writeAudit(transaction, command);
    await writeOutbox(transaction, command);
    await transaction.query(
      `INSERT INTO waspada.publication_write_receipts
         (dataset_kind, idempotency_key, request_fingerprint,
          decision_id, event_id, event_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['live', command.idempotencyKey, requestFingerprint, command.decisionId,
        command.event.event_id, command.event.version],
    );

    return {
      outcome: 'written',
      decisionId: command.decisionId,
      eventId: command.event.event_id,
      eventVersion: command.event.version,
    };
  }
}

async function loadProposalClaims(
  transaction: SqlExecutor,
  command: ParsedCommand,
  proposal: StoredProposal,
): Promise<readonly StoredProposalClaim[]> {
  const result = await transaction.query<ProposalClaimRow>(
    `SELECT claim_id, support_assessment, evidence_label, claim_text, record_json
     FROM waspada.proposal_claims
     WHERE dataset_kind = $1 AND proposal_id = $2`,
    [command.datasetKind, command.proposalId],
  );
  const rows = new Map(result.rows.map((row) => [row.claim_id, row]));
  if (rows.size !== proposal.claims.length) {
    invalidEvidence('The proposal claim rows do not match the stored proposal record');
  }
  return proposal.claims.map((record) => {
    const row = rows.get(record.claim_id);
    if (!row) invalidEvidence(`The proposal claim is missing from normalized storage: ${record.claim_id}`);
    const parsedRecord = parseProposalClaim(row.record_json);
    if (row.claim_text !== parsedRecord.text || row.evidence_label !== parsedRecord.evidence_label
      || row.support_assessment !== parsedRecord.support_assessment
      || parsedRecord.claim_id !== row.claim_id || record.claim_id !== row.claim_id) {
      invalidEvidence(`The normalized proposal claim disagrees with its stored record: ${row.claim_id}`);
    }
    return {
      claimId: row.claim_id,
      assessment: row.support_assessment as StoredProposalClaim['assessment'],
      evidenceLabel: row.evidence_label as StoredProposalClaim['evidenceLabel'],
      claimText: row.claim_text,
      record: parsedRecord,
    };
  });
}

async function resolvePublishedClaims(
  transaction: SqlExecutor,
  command: ParsedCommand,
  proposal: StoredProposal,
  claims: readonly StoredProposalClaim[],
): Promise<readonly ResolvedClaim[]> {
  const relationRows = await transaction.query<ProposalClaimRelationRow>(
    `SELECT relation.proposal_id, relation.claim_id, relation.evidence_kind,
            reference.evidence_ref_id::text AS evidence_ref_id,
            reference.report_revision_id, reference.permitted_text_hash,
            reference.span_start, reference.span_end, reference.offset_unit, reference.relation,
            (grounding.evidence_ref_id IS NOT NULL) AS in_grounding_context
     FROM waspada.proposal_claim_evidence AS relation
     JOIN waspada.evidence_references AS reference
       ON reference.dataset_kind = relation.dataset_kind
      AND reference.evidence_ref_id = relation.evidence_ref_id
     LEFT JOIN waspada.grounding_evidence AS grounding
       ON grounding.dataset_kind = relation.dataset_kind
      AND grounding.context_id = $3
      AND grounding.evidence_ref_id = relation.evidence_ref_id
     WHERE relation.dataset_kind = $1 AND relation.proposal_id = $2`,
    [command.datasetKind, command.proposalId, proposal.contextId],
  );
  const relationRowsByClaim = groupBy(relationRows.rows, (row) => row.claim_id);
  const originRows = await transaction.query<ProposalOriginRow>(
    `SELECT claim_id, origin_id
     FROM waspada.proposal_claim_origins
     WHERE dataset_kind = $1 AND proposal_id = $2`,
    [command.datasetKind, command.proposalId],
  );
  const originIdsByClaim = groupBy(originRows.rows, (row) => row.claim_id);
  const decisions = new Map(command.claimDecisions.map((decision) => [decision.claim_id, decision]));
  const resolved: ResolvedClaim[] = [];

  for (const claim of claims) {
    const relationRowsForClaim = relationRowsByClaim.get(claim.claimId) ?? [];
    const origins = (originIdsByClaim.get(claim.claimId) ?? []).map((row) => row.origin_id).sort();
    if (!sameStringSet(origins, claim.record.origin_ids)) {
      invalidEvidence(`Proposal origins do not match stored relations for claim ${claim.claimId}`);
    }
    const evidenceByKind = {
      support: resolveDeclaredEvidence(claim, 'support', relationRowsForClaim),
      contradiction: resolveDeclaredEvidence(claim, 'contradiction', relationRowsForClaim),
      context: resolveDeclaredEvidence(claim, 'context', relationRowsForClaim),
    };
    const decision = decisions.get(claim.claimId)!;
    const decisionRefs = decision.evidence.map(evidenceKey);
    const allDeclaredRefs = [
      ...claim.record.support,
      ...claim.record.contradictions,
      ...claim.record.context_evidence,
    ].map(evidenceKey);
    if (!sameStringSet(decisionRefs, allDeclaredRefs)) {
      invalidEvidence(`Publication decision evidence must preserve every stored reference for claim ${claim.claimId}`);
    }
    if (decision.disposition === 'publish') {
      const supportKeys = claim.record.support.map(evidenceKey);
      if (claim.assessment !== 'supported' || supportKeys.length === 0
        || !supportKeys.every((key) => decisionRefs.includes(key))) {
        invalidEvidence(`Published claim ${claim.claimId} lacks its exact supported proposal evidence`);
      }
      for (const geometryId of claim.record.scope.geometry_ids) {
        const supportIds = evidenceByKind.support;
        const geometryLink = await transaction.query<IdRow>(
          `SELECT evidence_ref_id::text AS id
           FROM waspada.geometry_evidence
           WHERE dataset_kind = $1 AND geometry_id = $2
             AND evidence_ref_id = ANY($3::bigint[])`,
          [command.datasetKind, geometryId, supportIds],
        );
        if (geometryLink.rows.length === 0) {
          invalidEvidence(`Claim geometry ${geometryId} is not linked to its supporting evidence`);
        }
      }
      resolved.push({
        proposal: claim,
        publishedClaim: publishedClaimRecord(claim.record),
        evidenceByKind,
      });
    }
  }
  return resolved;
}

function resolveDeclaredEvidence(
  claim: StoredProposalClaim,
  evidenceKind: ProposalClaimRelationRow['evidence_kind'],
  rows: readonly ProposalClaimRelationRow[],
): readonly string[] {
  const declared = evidenceForKind(claim.record, evidenceKind);
  const matchingRows = rows.filter((row) => row.evidence_kind === evidenceKind);
  const resolvedIds: string[] = [];
  for (const reference of declared) {
    const matches = matchingRows.filter((row) => sameEvidenceReference(row, reference));
    if (matches.length !== 1 || !matches[0]?.in_grounding_context) {
      invalidEvidence(`Claim ${claim.claimId} evidence does not map to one retrieval-backed same-dataset reference`);
    }
    resolvedIds.push(matches[0]!.evidence_ref_id);
  }
  if (matchingRows.length !== declared.length) {
    invalidEvidence(`Stored ${evidenceKind} relations do not match the proposal claim ${claim.claimId}`);
  }
  return resolvedIds;
}

function evidenceForKind(
  claim: ProposalClaimDocument,
  kind: ProposalClaimRelationRow['evidence_kind'],
): readonly PublicationEvidenceReference[] {
  if (kind === 'support') return claim.support;
  if (kind === 'contradiction') return claim.contradictions;
  return claim.context_evidence;
}

function sameEvidenceReference(
  row: ProposalClaimRelationRow,
  reference: PublicationEvidenceReference,
): boolean {
  return row.report_revision_id === reference.report_revision_id
    && row.permitted_text_hash === reference.permitted_text_hash
    && Number(row.span_start) === reference.span_start
    && Number(row.span_end) === reference.span_end
    && row.offset_unit === reference.offset_unit
    && row.relation === reference.relation;
}

async function writeDecision(
  transaction: SqlExecutor,
  command: ParsedCommand,
  proposal: StoredProposal,
  publishedClaims: readonly ResolvedClaim[],
): Promise<void> {
  const decisionRecord = {
    schema_version: '2.0',
    trace_id: command.traceId,
    record_type: 'PublicationDecision',
    dataset_kind: command.datasetKind,
    decision_id: command.decisionId,
    proposal_id: command.proposalId,
    policy_version: command.policyVersion,
    event_id: command.event.event_id,
    event_version: command.event.version,
    claim_decisions: command.claimDecisions,
    reviewer_id: command.moderatorApproval.actor_id,
    decided_at: command.moderatorApproval.decided_at,
  };
  await transaction.query(
    `INSERT INTO waspada.publication_decisions
       (dataset_kind, decision_id, trace_id, proposal_id, policy_version,
        event_id, event_version, reviewer_id, decided_at, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    ['live', command.decisionId, command.traceId, command.proposalId, command.policyVersion,
      command.event.event_id, command.event.version, command.moderatorApproval.actor_id,
      command.moderatorApproval.decided_at, JSON.stringify(decisionRecord)],
  );
  const evidenceRowsByClaim = new Map(publishedClaims.map((entry) => [
    entry.proposal.claimId,
    new Set([...entry.evidenceByKind.support, ...entry.evidenceByKind.contradiction, ...entry.evidenceByKind.context]),
  ]));

  const proposalClaims = await transaction.query<ProposalClaimRow>(
    `SELECT claim_id, support_assessment, evidence_label, claim_text, record_json
     FROM waspada.proposal_claims
     WHERE dataset_kind = $1 AND proposal_id = $2`,
    ['live', command.proposalId],
  );
  const proposalClaimIds = proposalClaims.rows.map((row) => row.claim_id);
  for (const decision of command.claimDecisions) {
    if (!proposalClaimIds.includes(decision.claim_id)) {
      invalidEvidence(`Decision refers to an unknown proposal claim: ${decision.claim_id}`);
    }
    await transaction.query(
      `INSERT INTO waspada.publication_claim_decisions
         (dataset_kind, decision_id, proposal_id, claim_id, disposition, reason_codes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['live', command.decisionId, command.proposalId, decision.claim_id,
        decision.disposition, [...decision.reason_codes]],
    );
    const evidenceIds = evidenceRowsByClaim.get(decision.claim_id)
      ?? await resolveDecisionEvidenceIds(transaction, command, proposal, decision);
    if (decision.disposition === 'publish' && evidenceIds.size === 0) {
      invalidEvidence(`Published claim ${decision.claim_id} has no publication decision evidence`);
    }
    for (const evidenceRefId of evidenceIds) {
      await transaction.query(
        `INSERT INTO waspada.publication_decision_evidence
           (dataset_kind, decision_id, claim_id, evidence_ref_id)
         VALUES ($1, $2, $3, $4)`,
        ['live', command.decisionId, decision.claim_id, evidenceRefId],
      );
    }
  }
}

async function resolveDecisionEvidenceIds(
  transaction: SqlExecutor,
  command: ParsedCommand,
  proposal: StoredProposal,
  decision: ParsedClaimDecision,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const reference of decision.evidence) {
    const evidenceKind = referenceKinds.get(reference.relation);
    if (!evidenceKind) invalidEvidence(`Unsupported decision evidence relation for claim ${decision.claim_id}`);
    const result = await transaction.query<{ evidence_ref_id: string }>(
      `SELECT reference.evidence_ref_id::text AS evidence_ref_id
       FROM waspada.proposal_claim_evidence AS relation
       JOIN waspada.evidence_references AS reference
         ON reference.dataset_kind = relation.dataset_kind
        AND reference.evidence_ref_id = relation.evidence_ref_id
       JOIN waspada.grounding_evidence AS grounding
         ON grounding.dataset_kind = relation.dataset_kind
        AND grounding.context_id = $4
        AND grounding.evidence_ref_id = relation.evidence_ref_id
       WHERE relation.dataset_kind = $1 AND relation.proposal_id = $2
         AND relation.claim_id = $3 AND relation.evidence_kind = $5
         AND reference.report_revision_id = $6
         AND reference.permitted_text_hash = $7
         AND reference.span_start = $8 AND reference.span_end = $9
         AND reference.offset_unit = $10 AND reference.relation = $11`,
      ['live', command.proposalId, decision.claim_id, proposal.contextId, evidenceKind,
        reference.report_revision_id, reference.permitted_text_hash, reference.span_start,
        reference.span_end, reference.offset_unit, reference.relation],
    );
    if (result.rows.length !== 1) invalidEvidence(`Decision evidence is not uniquely retrieval-backed for claim ${decision.claim_id}`);
    ids.add(result.rows[0]!.evidence_ref_id);
  }
  return ids;
}

async function writeEventVersion(
  transaction: SqlExecutor,
  command: ParsedCommand,
  claims: readonly ResolvedClaim[],
): Promise<void> {
  const event = command.event;
  const impactRefs = command.impacts.map((impact) => ({ impact_id: impact.impact_id, version: impact.version }));
  const eventRecord = {
    schema_version: '2.0',
    trace_id: command.traceId,
    record_type: 'Event',
    dataset_kind: command.datasetKind,
    ...event,
    claims: claims.map((claim) => claim.publishedClaim),
    impact_refs: impactRefs,
    publication_status: 'published',
    withdrawal_reason: null,
    publication_decision_id: command.decisionId,
    withdrawn_at: null,
  };
  await transaction.query(
    `INSERT INTO waspada.event_versions
       (dataset_kind, event_id, version, trace_id, supersedes_version, title, summary,
        category, lifecycle, publication_status, withdrawal_reason,
        publication_decision_id, published_at, withdrawn_at, record_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published', NULL,
             $10, $11, NULL, $12::jsonb)`,
    ['live', event.event_id, event.version, command.traceId, event.supersedes_version,
      event.title, event.summary, event.category, event.lifecycle, command.decisionId,
      event.published_at, JSON.stringify(eventRecord)],
  );

  for (const claim of claims) {
    const proposalClaim = claim.proposal;
    await transaction.query(
      `INSERT INTO waspada.event_claims
         (dataset_kind, event_id, event_version, claim_id, publication_status,
          claim_text, evidence_label, record_json)
       VALUES ($1, $2, $3, $4, 'published', $5, $6, $7::jsonb)`,
      ['live', event.event_id, event.version, proposalClaim.claimId, proposalClaim.claimText,
        proposalClaim.evidenceLabel, JSON.stringify(claim.publishedClaim)],
    );
    for (const evidenceRefId of claim.evidenceByKind.support) {
      await insertEventClaimEvidence(transaction, command, proposalClaim.claimId, 'support', evidenceRefId);
    }
    for (const evidenceRefId of claim.evidenceByKind.contradiction) {
      await insertEventClaimEvidence(transaction, command, proposalClaim.claimId, 'contradiction', evidenceRefId);
    }
    for (const evidenceRefId of claim.evidenceByKind.context) {
      await insertEventClaimEvidence(transaction, command, proposalClaim.claimId, 'context', evidenceRefId);
    }
    for (const originId of proposalClaim.record.origin_ids) {
      await transaction.query(
        `INSERT INTO waspada.event_claim_origins
           (dataset_kind, event_id, event_version, claim_id, origin_id)
         VALUES ($1, $2, $3, $4, $5)`,
        ['live', event.event_id, event.version, proposalClaim.claimId, originId],
      );
    }
    for (const geometryId of proposalClaim.record.scope.geometry_ids) {
      await transaction.query(
        `INSERT INTO waspada.event_claim_geometries
           (dataset_kind, event_id, event_version, claim_id, geometry_id)
         VALUES ($1, $2, $3, $4, $5)`,
        ['live', event.event_id, event.version, proposalClaim.claimId, geometryId],
      );
    }
  }
}

async function insertEventClaimEvidence(
  transaction: SqlExecutor,
  command: ParsedCommand,
  claimId: string,
  evidenceKind: 'support' | 'contradiction' | 'context',
  evidenceRefId: string,
): Promise<void> {
  await transaction.query(
    `INSERT INTO waspada.event_claim_evidence
       (dataset_kind, event_id, event_version, claim_id, evidence_kind, evidence_ref_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ['live', command.event.event_id, command.event.version, claimId, evidenceKind, evidenceRefId],
  );
}

async function writeImpacts(
  transaction: SqlExecutor,
  command: ParsedCommand,
  publishedClaims: readonly ResolvedClaim[],
): Promise<void> {
  const publishedClaimIds = new Set(publishedClaims.map((claim) => claim.proposal.claimId));
  for (const impact of command.impacts) {
    const record = {
      schema_version: '2.0',
      trace_id: command.traceId,
      record_type: 'Impact',
      dataset_kind: command.datasetKind,
      ...impact,
    };
    await transaction.query(
      `INSERT INTO waspada.impact_versions
         (dataset_kind, impact_id, version, trace_id, event_id, event_version,
          impact_type, lifecycle, published_at, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      ['live', impact.impact_id, impact.version, command.traceId, impact.event_id,
        impact.event_version, impact.impact_type, impact.lifecycle, impact.published_at,
        JSON.stringify(record)],
    );
    for (const claimId of impact.supporting_claim_ids) {
      if (!publishedClaimIds.has(claimId)) {
        invalidEvidence(`Impact ${impact.impact_id} names a claim outside the new published event version`);
      }
      await transaction.query(
        `INSERT INTO waspada.impact_claim_support
           (dataset_kind, impact_id, impact_version, event_id, event_version, claim_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['live', impact.impact_id, impact.version, impact.event_id, impact.event_version, claimId],
      );
    }
    await transaction.query(
      `INSERT INTO waspada.event_impact_refs
         (dataset_kind, event_id, event_version, impact_id, impact_version)
       VALUES ($1, $2, $3, $4, $5)`,
      ['live', command.event.event_id, command.event.version, impact.impact_id, impact.version],
    );
  }
}

async function validateImpactVersions(transaction: SqlExecutor, command: ParsedCommand): Promise<void> {
  for (const impact of command.impacts) {
    const result = await transaction.query<VersionRow>(
      `SELECT max(version)::integer AS version
       FROM waspada.impact_versions
       WHERE dataset_kind = $1 AND impact_id = $2`,
      ['live', impact.impact_id],
    );
    const currentVersion = result.rows[0]?.version ?? null;
    const expectedVersion = currentVersion === null ? 1 : currentVersion + 1;
    if (impact.version !== expectedVersion) {
      throw new PublicationWriteError(
        'invalid_command',
        `Impact ${impact.impact_id} must use the next append-only version ${expectedVersion}`,
      );
    }
  }
}

async function validateEventGeometryReferences(
  transaction: SqlExecutor,
  command: ParsedCommand,
  publishedClaims: readonly ResolvedClaim[],
): Promise<void> {
  const claimGeometryIds = new Set(publishedClaims.flatMap((claim) => claim.proposal.record.scope.geometry_ids));
  if (command.event.scope.geometry_ids.some((geometryId) => !claimGeometryIds.has(geometryId))) {
    invalidEvidence('Event geometry must be present on a published, evidence-linked claim');
  }
  for (const impact of command.impacts) {
    const impactClaimGeometryIds = new Set(publishedClaims
      .filter((claim) => impact.supporting_claim_ids.includes(claim.proposal.claimId))
      .flatMap((claim) => claim.proposal.record.scope.geometry_ids));
    if (impact.scope.geometry_ids.some((geometryId) => !impactClaimGeometryIds.has(geometryId))) {
      invalidEvidence(`Impact ${impact.impact_id} geometry must be supported by one of its supporting claims`);
    }
  }
  const geometryIds = [...new Set([
    ...command.event.scope.geometry_ids,
    ...publishedClaims.flatMap((claim) => claim.proposal.record.scope.geometry_ids),
    ...command.impacts.flatMap((impact) => impact.scope.geometry_ids),
  ])];
  if (geometryIds.length === 0) return;
  const result = await transaction.query<{ geometry_id: string }>(
    `SELECT geometry_id FROM waspada.geometries
     WHERE dataset_kind = $1 AND geometry_id = ANY($2::text[])`,
    ['live', geometryIds],
  );
  const found = new Set(result.rows.map((row) => row.geometry_id));
  const missing = geometryIds.find((geometryId) => !found.has(geometryId));
  if (missing) invalidEvidence(`Geometry reference does not exist in the live dataset: ${missing}`);
}

async function writeAudit(transaction: SqlExecutor, command: ParsedCommand): Promise<void> {
  await transaction.query(
    `INSERT INTO waspada.audit_records
       (dataset_kind, audit_id, trace_id, occurred_at, actor_id, action,
        entity_type, entity_id, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    ['live', randomUUID(), command.traceId, command.moderatorApproval.decided_at,
      command.moderatorApproval.actor_id, 'publication_event_version_committed',
      'event_version', `${command.event.event_id}:${command.event.version}`,
      command.moderatorApproval.reason,
      JSON.stringify({ proposal_id: command.proposalId, decision_id: command.decisionId,
        event_id: command.event.event_id, event_version: command.event.version,
        policy_version: command.policyVersion })],
  );
}

async function writeOutbox(transaction: SqlExecutor, command: ParsedCommand): Promise<void> {
  await transaction.query(
    `INSERT INTO waspada.publication_outbox
       (outbox_id, dataset_kind, event_id, event_version, event_kind, trace_id, occurred_at)
     VALUES ($1, $2, $3, $4, 'event_version_published', $5, $6)`,
    [randomUUID(), 'live', command.event.event_id, command.event.version,
      command.traceId, command.event.published_at],
  );
}

interface StoredProposal {
  readonly contextId: string;
  readonly claims: readonly ProposalClaimDocument[];
}

function parseStoredProposal(row: ProposalRow, command: ParsedCommand): StoredProposal {
  const record = objectRecord(row.record_json, 'stored event proposal');
  assertKeys(record, [
    'schema_version', 'trace_id', 'record_type', 'dataset_kind', 'proposal_id', 'candidate_id',
    'context_id', 'event_id', 'base_event_version', 'investigation_id', 'claims',
    'unresolved_fields', 'model_runs', 'proposed_at',
  ], 'stored event proposal');
  if (record.schema_version !== '2.0' || record.record_type !== 'EventProposal'
    || record.dataset_kind !== 'live' || record.proposal_id !== command.proposalId
    || record.trace_id !== command.traceId || record.candidate_id !== row.candidate_id
    || record.context_id !== row.context_id || record.event_id !== row.event_id
    || record.base_event_version !== row.base_event_version) {
    invalidEvidence('The normalized proposal target does not match its stored EventProposal record');
  }
  if (record.event_id !== command.expectedTarget.event_id
    || record.base_event_version !== command.expectedTarget.base_event_version) {
    invalid('The expected event target must match the stored proposal target');
  }
  if (!Array.isArray(record.claims) || record.claims.length === 0) {
    invalid('A publication requires at least one proposal claim');
  }
  const claims = record.claims.map(parseProposalClaim);
  if (new Set(claims.map((claim) => claim.claim_id)).size !== claims.length) {
    invalidEvidence('The stored proposal contains duplicate claim IDs');
  }
  return { contextId: row.context_id, claims };
}

function parseProposalClaim(value: unknown): ProposalClaimDocument {
  const record = objectRecord(value, 'proposal claim');
  assertKeys(record, [
    'claim_id', 'text', 'event_time', 'validity', 'scope', 'qualifiers', 'support',
    'contradictions', 'context_evidence', 'origin_ids', 'support_assessment', 'evidence_label',
  ], 'proposal claim');
  const claimId = requiredId(record.claim_id, 'proposal claim ID');
  const text = boundedText(record.text, 'proposal claim text', 2000);
  const eventTime = parseTimeScope(record.event_time, 'proposal claim event_time');
  const validity = parseValidity(record.validity, 'proposal claim validity');
  const scope = parseScope(record.scope, 'proposal claim scope');
  const qualifiers = parseTextArray(record.qualifiers, 'proposal claim qualifiers', 200, 20);
  const support = parseReferenceArray(record.support, 'proposal claim support', 'supports');
  const contradictions = parseReferenceArray(record.contradictions, 'proposal claim contradictions', 'contradicts');
  const contextEvidence = parseContextReferenceArray(record.context_evidence, 'proposal claim context_evidence');
  const originIds = parseUniqueIds(record.origin_ids, 'proposal claim origin_ids', 128, true);
  const supportAssessment = enumValue(record.support_assessment, ['supported', 'uncertain', 'disputed'], 'support_assessment');
  const evidenceLabel = enumValue(record.evidence_label, [...recordLabels], 'evidence_label');
  if (support.length === 0 || !hasMeaningfulScope(scope)) {
    invalidEvidence('A proposal claim needs supporting evidence and an evidenced place, service, institution, or audience');
  }
  return {
    claim_id: claimId,
    text,
    event_time: eventTime,
    validity,
    scope,
    qualifiers,
    support,
    contradictions,
    context_evidence: contextEvidence,
    origin_ids: originIds,
    support_assessment: supportAssessment,
    evidence_label: evidenceLabel,
  };
}

function publishedClaimRecord(record: ProposalClaimDocument): Readonly<Record<string, unknown>> {
  return {
    claim_id: record.claim_id,
    text: record.text,
    event_time: record.event_time,
    validity: record.validity,
    scope: record.scope,
    qualifiers: [...record.qualifiers],
    support: record.support,
    contradictions: record.contradictions,
    context_evidence: record.context_evidence,
    origin_ids: [...record.origin_ids],
    evidence_label: record.evidence_label,
  };
}

function parseCommand(input: unknown): ParsedCommand {
  const record = objectRecord(input, 'publication command');
  assertKeys(record, [
    'datasetKind', 'idempotencyKey', 'traceId', 'proposalId', 'decisionId', 'policyVersion',
    'expectedTarget', 'moderatorApproval', 'claimDecisions', 'event', 'impacts',
  ], 'publication command');
  if (record.datasetKind !== 'live') {
    invalid('Only the live dataset is eligible for manual publication writes');
  }
  const idempotencyKey = boundedText(record.idempotencyKey, 'idempotency key', 256);
  const traceId = requiredId(record.traceId, 'trace ID');
  const proposalId = requiredId(record.proposalId, 'proposal ID');
  const decisionId = requiredId(record.decisionId, 'decision ID');
  const policyVersion = requiredId(record.policyVersion, 'policy version');
  const expectedTarget = parseExpectedTarget(record.expectedTarget);
  const moderatorApproval = parseModeratorApproval(record.moderatorApproval);
  const claimDecisions = parseClaimDecisions(record.claimDecisions);
  const event = parseEventDraft(record.event);
  const impacts = parseImpactDrafts(record.impacts);
  validateVersionRelationships(expectedTarget, event, impacts);
  if (claimDecisions.length === 0 || !claimDecisions.some((decision) => decision.disposition === 'publish')) {
    invalid('An approved publication requires at least one publish disposition');
  }
  return {
    datasetKind: 'live', idempotencyKey, traceId, proposalId, decisionId, policyVersion,
    expectedTarget, moderatorApproval, claimDecisions, event, impacts,
  };
}

function parseExpectedTarget(value: unknown): PublicationEventTarget {
  const record = objectRecord(value, 'expected target');
  assertKeys(record, ['event_id', 'base_event_version'], 'expected target');
  const eventId = record.event_id === null ? null : requiredId(record.event_id, 'expected event ID');
  const base = record.base_event_version;
  const baseVersion = base === null ? null : positiveInteger(base, 'expected base event version');
  if ((eventId === null) !== (baseVersion === null)) invalid('Expected event ID and base version must be both null or both populated');
  return { event_id: eventId, base_event_version: baseVersion };
}

function parseModeratorApproval(value: unknown): TrustedModeratorApproval {
  const record = objectRecord(value, 'moderator approval');
  assertKeys(record, ['action', 'trusted_caller_authorized', 'actor_id', 'decided_at', 'reason'], 'moderator approval');
  if (record.action !== 'approve' || record.trusted_caller_authorized !== true) {
    throw new PublicationWriteError(
      'moderator_approval_required',
      'A trusted L4 caller must provide an authorized explicit moderator approval',
    );
  }
  return {
    action: 'approve',
    trusted_caller_authorized: true,
    actor_id: boundedActorId(record.actor_id),
    decided_at: dateTime(record.decided_at, 'moderator decided_at'),
    reason: boundedText(record.reason, 'moderator reason', 1000),
  };
}

function parseClaimDecisions(value: unknown): readonly ParsedClaimDecision[] {
  if (!Array.isArray(value)) invalid('claimDecisions must be an array');
  const decisions = value.map((entry, index) => {
    const record = objectRecord(entry, `claimDecisions[${index}]`);
    assertKeys(record, ['claim_id', 'disposition', 'reason_codes', 'evidence'], `claimDecisions[${index}]`);
    const disposition = enumValue(record.disposition, [...dispositions], 'claim disposition');
    const reasonCodes = parseTextArray(record.reason_codes, 'claim reason_codes', 120, 50);
    if (reasonCodes.length === 0) invalid('Every claim disposition needs a reason code');
    return {
      claim_id: requiredId(record.claim_id, 'claim ID'),
      disposition,
      reason_codes: reasonCodes,
      evidence: parseReferenceArray(record.evidence, 'claim decision evidence'),
    } satisfies ParsedClaimDecision;
  });
  if (new Set(decisions.map((decision) => decision.claim_id)).size !== decisions.length) {
    invalid('claimDecisions must include each claim ID at most once');
  }
  return decisions;
}

function parseEventDraft(value: unknown): PublicationEventVersionDraft {
  const record = objectRecord(value, 'event version draft');
  assertKeys(record, [
    'event_id', 'version', 'supersedes_version', 'title', 'summary', 'category', 'tags',
    'lifecycle', 'freshness', 'event_time', 'validity', 'scope', 'published_at',
  ], 'event version draft');
  const supersedesVersion = record.supersedes_version === null
    ? null : positiveInteger(record.supersedes_version, 'supersedes_version');
  const tags = parseTags(record.tags);
  const scope = parseScope(record.scope, 'event scope');
  if (!hasMeaningfulScope(scope)) invalid('A published event requires an evidenced place, service, institution, or audience');
  return {
    event_id: requiredId(record.event_id, 'event ID'),
    version: positiveInteger(record.version, 'event version'),
    supersedes_version: supersedesVersion,
    title: boundedText(record.title, 'event title', 240),
    summary: boundedText(record.summary, 'event summary', 2000),
    category: enumValue(record.category, [...categories], 'event category'),
    tags,
    lifecycle: enumValue(record.lifecycle, [...lifecycles], 'event lifecycle'),
    freshness: parseFreshness(record.freshness, 'event freshness'),
    event_time: parseTimeScope(record.event_time, 'event_time'),
    validity: parseValidity(record.validity, 'event validity'),
    scope,
    published_at: dateTime(record.published_at, 'event published_at'),
  };
}

function parseImpactDrafts(value: unknown): readonly PublicationImpactVersionDraft[] {
  if (!Array.isArray(value)) invalid('impacts must be an array');
  const impacts = value.map((entry, index) => {
    const record = objectRecord(entry, `impacts[${index}]`);
    assertKeys(record, [
      'impact_id', 'version', 'event_id', 'event_version', 'impact_type', 'title', 'description',
      'lifecycle', 'freshness', 'event_time', 'validity', 'scope', 'supporting_claim_ids', 'published_at',
    ], `impacts[${index}]`);
    const scope = parseScope(record.scope, 'impact scope');
    if (!hasMeaningfulScope(scope)) invalid('A published impact requires an evidenced place, service, institution, or audience');
    return {
      impact_id: requiredId(record.impact_id, 'impact ID'),
      version: positiveInteger(record.version, 'impact version'),
      event_id: requiredId(record.event_id, 'impact event ID'),
      event_version: positiveInteger(record.event_version, 'impact event version'),
      impact_type: enumValue(record.impact_type, [...impactTypes], 'impact type'),
      title: boundedText(record.title, 'impact title', 240),
      description: boundedText(record.description, 'impact description', 2000),
      lifecycle: enumValue(record.lifecycle, [...lifecycles], 'impact lifecycle'),
      freshness: parseFreshness(record.freshness, 'impact freshness'),
      event_time: parseTimeScope(record.event_time, 'impact event_time'),
      validity: parseValidity(record.validity, 'impact validity'),
      scope,
      supporting_claim_ids: parseUniqueIds(record.supporting_claim_ids, 'supporting_claim_ids', 128, true),
      published_at: dateTime(record.published_at, 'impact published_at'),
    } satisfies PublicationImpactVersionDraft;
  });
  if (new Set(impacts.map((impact) => impact.impact_id)).size !== impacts.length) {
    invalid('Every impact version must be referenced exactly once by the new event');
  }
  return impacts;
}

function validateVersionRelationships(
  target: PublicationEventTarget,
  event: PublicationEventVersionDraft,
  impacts: readonly PublicationImpactVersionDraft[],
): void {
  if (target.event_id === null) {
    if (target.base_event_version !== null || event.version !== 1 || event.supersedes_version !== null) {
      invalid('A new event requires a null base version, version 1, and no superseded version');
    }
  } else if (target.base_event_version === null || event.event_id !== target.event_id
    || event.version !== target.base_event_version + 1 || event.supersedes_version !== target.base_event_version) {
    invalid('An event update must target the supplied ID and exactly the next version');
  }
  for (const impact of impacts) {
    if (impact.event_id !== event.event_id || impact.event_version !== event.version) {
      invalid(`Impact ${impact.impact_id} must target the new event ID and version`);
    }
  }
}

function checkCurrentVersion(command: ParsedCommand, currentVersion: number | null): PublicationWriteConflict | null {
  if (command.expectedTarget.event_id === null) {
    return currentVersion === null ? null : { outcome: 'conflict', code: 'event_version_exists' };
  }
  if (currentVersion !== command.expectedTarget.base_event_version) {
    return { outcome: 'conflict', code: 'stale_event_version' };
  }
  return null;
}

function validateClaimDecisions(command: ParsedCommand, claims: readonly StoredProposalClaim[]): void {
  const proposalIds = claims.map((claim) => claim.claimId);
  const decisionIds = command.claimDecisions.map((decision) => decision.claim_id);
  if (!sameStringSet(proposalIds, decisionIds)) {
    invalid('Every stored proposal claim must have exactly one publication disposition');
  }
}

function parseFreshness(value: unknown, label: string): PublicationFreshness {
  const record = objectRecord(value, label);
  assertKeys(record, ['status', 'evaluated_at', 'review_due_at', 'basis'], label);
  return {
    status: enumValue(record.status, ['current', 'needs_update', 'expired'], `${label}.status`),
    evaluated_at: dateTime(record.evaluated_at, `${label}.evaluated_at`),
    review_due_at: nullableDateTime(record.review_due_at, `${label}.review_due_at`),
    basis: enumValue(record.basis, ['source_validity', 'fast_observation_review', 'undated_advisory_review', 'manual_review', 'unknown'], `${label}.basis`),
  };
}

function parseTimeScope(value: unknown, label: string): PublicationTimeScope {
  const record = objectRecord(value, label);
  assertKeys(record, ['start', 'end', 'precision'], label);
  const precision = enumValue(record.precision, ['exact', 'date', 'range', 'unknown'], `${label}.precision`);
  if (precision === 'unknown') {
    if (record.start !== null || record.end !== null) invalid(`${label} with unknown precision requires null endpoints`);
    return { start: null, end: null, precision };
  }
  const parseEndpoint = (endpoint: unknown, endpointLabel: string, allowNull: boolean): string | null => {
    if (endpoint === null && allowNull) return null;
    if (precision === 'date') return dateOnly(endpoint, endpointLabel);
    if (precision === 'range') return dateOrDateTime(endpoint, endpointLabel);
    return dateTime(endpoint, endpointLabel);
  };
  const start = parseEndpoint(record.start, `${label}.start`, false);
  const end = parseEndpoint(record.end, `${label}.end`, precision !== 'range');
  if (precision === 'range' && (start === null || end === null)) invalid(`${label} range requires both endpoints`);
  if (start !== null && end !== null && timeScopeInstant(end) < timeScopeInstant(start)) {
    invalid(`${label} end must not precede start`);
  }
  return { start, end, precision };
}

function timeScopeInstant(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
}

function parseValidity(value: unknown, label: string): PublicationValidityPeriod {
  const record = objectRecord(value, label);
  assertKeys(record, ['valid_from', 'valid_until'], label);
  const validFrom = nullableDateTime(record.valid_from, `${label}.valid_from`);
  const validUntil = nullableDateTime(record.valid_until, `${label}.valid_until`);
  if (validFrom && validUntil && Date.parse(validFrom) >= Date.parse(validUntil)) {
    invalid(`${label} valid_from must precede valid_until`);
  }
  return { valid_from: validFrom, valid_until: validUntil };
}

function parseScope(value: unknown, label: string): PublicationScope {
  const record = objectRecord(value, label);
  assertKeys(record, ['place_ids', 'service_ids', 'institution_ids', 'audience_ids', 'geometry_ids'], label);
  return {
    place_ids: parseUniqueIds(record.place_ids, `${label}.place_ids`, 128, false),
    service_ids: parseUniqueIds(record.service_ids, `${label}.service_ids`, 128, false),
    institution_ids: parseUniqueIds(record.institution_ids, `${label}.institution_ids`, 128, false),
    audience_ids: parseUniqueIds(record.audience_ids, `${label}.audience_ids`, 128, false),
    geometry_ids: parseUniqueIds(record.geometry_ids, `${label}.geometry_ids`, 128, false),
  };
}

function parseTags(value: unknown): readonly PublicationTag[] {
  if (!Array.isArray(value)) invalid('event tags must be an array');
  const tags = value.map((entry, index) => {
    const record = objectRecord(entry, `event tags[${index}]`);
    assertKeys(record, ['namespace', 'value'], `event tags[${index}]`);
    const namespace = enumValue(record.namespace, ['topic', 'service', 'audience', 'hazard', 'transport_mode', 'place_type'], 'tag namespace');
    const tagValue = boundedText(record.value, 'tag value', 64);
    if (!/^[a-z][a-z0-9_]*$/.test(tagValue)) invalid('tag value must be a lowercase taxonomy token');
    return { namespace, value: tagValue };
  });
  const signatures = tags.map((tag) => `${tag.namespace}\u0000${tag.value}`);
  if (new Set(signatures).size !== signatures.length) invalid('event tags must be unique');
  return tags;
}

function parseReferenceArray(
  value: unknown,
  label: string,
  requiredRelation?: PublicationEvidenceReference['relation'],
): readonly PublicationEvidenceReference[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const references = value.map((entry, index) => {
    const record = objectRecord(entry, `${label}[${index}]`);
    assertKeys(record, [
      'report_revision_id', 'permitted_text_hash', 'span_start', 'span_end', 'offset_unit', 'relation',
    ], `${label}[${index}]`);
    const relation = enumValue(record.relation, ['supports', 'contradicts', 'context'], `${label}[${index}].relation`);
    if (requiredRelation && relation !== requiredRelation) invalid(`${label} relation must be ${requiredRelation}`);
    const spanStart = nonnegativeInteger(record.span_start, `${label}[${index}].span_start`);
    const spanEnd = positiveInteger(record.span_end, `${label}[${index}].span_end`);
    if (spanEnd <= spanStart || spanEnd > 10_000_000) invalid(`${label}[${index}] has an invalid evidence span`);
    if (record.offset_unit !== 'unicode_code_points') invalid(`${label}[${index}] offset_unit must be unicode_code_points`);
    return {
      report_revision_id: requiredId(record.report_revision_id, `${label}[${index}].report_revision_id`),
      permitted_text_hash: hashValue(record.permitted_text_hash, `${label}[${index}].permitted_text_hash`),
      span_start: spanStart,
      span_end: spanEnd,
      offset_unit: 'unicode_code_points' as const,
      relation,
    };
  });
  if (new Set(references.map(evidenceKey)).size !== references.length) invalid(`${label} cannot contain duplicates`);
  return references;
}

function parseContextReferenceArray(value: unknown, label: string): readonly PublicationEvidenceReference[] {
  const references = parseReferenceArray(value, label);
  if (references.some((reference) => reference.relation !== 'context')) {
    invalid(`${label} may only contain context relation references; updates are not persisted as support`);
  }
  return references;
}

function parseUniqueIds(value: unknown, label: string, maxLength: number, requireOne: boolean): readonly string[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const ids = value.map((entry) => requiredId(entry, label, maxLength));
  if ((requireOne && ids.length === 0) || new Set(ids).size !== ids.length) {
    invalid(`${label} must contain ${requireOne ? 'at least one unique' : 'unique'} ID`);
  }
  return ids;
}

function parseTextArray(value: unknown, label: string, maxLength: number, maxItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid(`${label} must be an array of at most ${maxItems} values`);
  return value.map((entry) => boundedText(entry, label, maxLength));
}

function hasMeaningfulScope(scope: PublicationScope): boolean {
  return scope.place_ids.length > 0 || scope.service_ids.length > 0
    || scope.institution_ids.length > 0 || scope.audience_ids.length > 0;
}

function requiredId(value: unknown, label: string, maxLength = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength
    || !idPattern.test(value)) invalid(`${label} must be a bounded identifier`);
  return value;
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) invalid(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function boundedActorId(value: unknown): string {
  if (typeof value !== 'string' || Array.from(value).length < 1 || Array.from(value).length > 128
    || value.trim() !== value || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    invalid('moderator actor_id must be bounded and contain no whitespace or control characters');
  }
  return value;
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || Array.from(value).length > maxLength
    || value.trim().length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    invalid(`${label} must be non-empty and at most ${maxLength} characters`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(`${label} must be a positive safe integer`);
  return Number(value);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(`${label} must be a non-negative safe integer`);
  return Number(value);
}

function dateTime(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be an RFC 3339 date-time`);
  const match = rfc3339Pattern.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) invalid(`${label} must be an RFC 3339 date-time`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59
    || (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))) {
    invalid(`${label} must be a valid RFC 3339 date-time`);
  }
  return value;
}

function nullableDateTime(value: unknown, label: string): string | null {
  return value === null ? null : dateTime(value, label);
}

function dateOnly(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(`${label} must be an ISO date`);
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) {
    invalid(`${label} must be a valid ISO date`);
  }
  return value;
}

function dateOrDateTime(value: unknown, label: string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return dateOnly(value, label);
  return dateTime(value, label);
}

function enumValue<Value extends string>(value: unknown, options: readonly Value[], label: string): Value {
  if (typeof value !== 'string' || !options.includes(value as Value)) invalid(`${label} has an unsupported value`);
  return value as Value;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) invalid(`${label} has an unsupported field: ${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) invalid(`${label} is missing ${key}`);
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function evidenceKey(reference: PublicationEvidenceReference): string {
  return [reference.report_revision_id, reference.permitted_text_hash, reference.span_start,
    reference.span_end, reference.offset_unit, reference.relation].join('\u0000');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function groupBy<Row, Key extends string>(rows: readonly Row[], key: (row: Row) => Key): Map<Key, Row[]> {
  const result = new Map<Key, Row[]>();
  for (const row of rows) {
    const value = key(row);
    const group = result.get(value) ?? [];
    group.push(row);
    result.set(value, group);
  }
  return result;
}

async function lockKey(transaction: SqlExecutor, namespace: string, key: string): Promise<void> {
  await transaction.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1 || $2, 0))',
    [`waspada:${namespace}:`, key],
  );
}

function invalid(message: string): never {
  throw new PublicationWriteError('invalid_command', message);
}

function invalidEvidence(message: string): never {
  throw new PublicationWriteError('publication_evidence_invalid', message);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return error !== null && typeof error === 'object'
    && 'code' in error && (error as { code?: unknown }).code === '23505'
    && 'constraint' in error && (error as { constraint?: unknown }).constraint === constraint;
}
