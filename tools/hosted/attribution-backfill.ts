// HOSTED-24C: the source attribution backfill for published live event versions. A version published before HOSTED-22
// has no public_attribution_review_decisions rows, so the public list skips it (ATTRIBUTION_FAILED). This module finds
// the published live versions that still have a supporting reference with no attribution row at all, and gives the
// missing references to the publication transaction's own writer (writeSourceAttributions). It writes attribution rows
// only: no decision, no event version and no claim changes. The support is read from the record that was published, so
// the references named are exactly the ones the public projector matches. Idempotent: a reference with any row is never a
// candidate again, and the writer's insert is ON CONFLICT DO NOTHING on a deterministic id. The result holds counts only.
import type { SqlExecutor, TransactionalSqlExecutor } from "../../apps/db/src/sql.js";
import { writeSourceAttributions } from "../../apps/worker/src/layers/l4-application-integration/proposal-publication.js";
import type { AttributionBackfillResult } from "./ingest-once.js";

/** HOSTED-24C: at most this many published versions are attempted in one run. The next run takes the rest. */
export const ATTRIBUTION_BACKFILL_LIMIT = 200;
/** HOSTED-24C: the run stops after this many versions in a row threw (for example a dropped connection). */
export const ATTRIBUTION_BACKFILL_MAX_CONSECUTIVE_FAILURES = 3;

export interface AttributionBackfillDeps {
  readonly executor: TransactionalSqlExecutor;
  /** The rights check decideProposal receives for each claim source. Fail-closed: a throw counts as not permitted. */
  readonly checkPublicDisplay: (sourceId: string) => Promise<boolean>;
  /** No new version is attempted at or after this instant. */
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly limit?: number;
  readonly maxConsecutiveFailures?: number;
}

/**
 * Published live versions, oldest publication first, that have at least one supporting reference (of a claim, in the
 * stored record) whose evidence row has no attribution row. The join is on the exact identity the projector matches.
 * Text comparison of the span keeps a malformed JSON number from failing the whole query.
 */
const CANDIDATE_SQL = `
  SELECT ev.event_id, ev.version,
         to_char(pd.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at,
         ev.record_json, proposal.record_json AS proposal_json
  FROM waspada.event_versions AS ev
  JOIN waspada.publication_decisions AS pd
    ON pd.dataset_kind = ev.dataset_kind AND pd.decision_id = ev.publication_decision_id
  JOIN waspada.event_proposals AS proposal
    ON proposal.dataset_kind = pd.dataset_kind AND proposal.proposal_id = pd.proposal_id
  WHERE ev.dataset_kind = 'live'
    AND ev.publication_status = 'published'
    AND pd.record_json->>'disposition' = 'publish'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(ev.record_json->'claims', '[]'::jsonb)) AS claim(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(claim.value->'support', '[]'::jsonb)) AS sup(value)
      JOIN waspada.evidence_references AS er
        ON er.dataset_kind = ev.dataset_kind
       AND er.report_revision_id = sup.value->>'report_revision_id'
       AND er.permitted_text_hash = sup.value->>'permitted_text_hash'
       AND er.span_start::text = sup.value->>'span_start'
       AND er.span_end::text = sup.value->>'span_end'
       AND er.offset_unit = sup.value->>'offset_unit'
       AND er.relation = sup.value->>'relation'
      WHERE NOT EXISTS (
        SELECT 1 FROM waspada.public_attribution_review_decisions AS attribution
        WHERE attribution.dataset_kind = er.dataset_kind AND attribution.evidence_ref_id = er.evidence_ref_id
      )
    )
  ORDER BY pd.decided_at ASC, ev.event_id ASC, ev.version ASC
  LIMIT $1`;

/**
 * Resolves each support tuple to its evidence row, and says whether that row already has an attribution. The same exact
 * match the publish path uses (ownEvidence), so a tuple that matches no row or more than one is unresolved, never guessed.
 */
const RESOLVE_SQL = `
  SELECT ref.ordinal, er.evidence_ref_id::text AS evidence_ref_id,
         EXISTS (
           SELECT 1 FROM waspada.public_attribution_review_decisions AS attribution
           WHERE attribution.dataset_kind = er.dataset_kind AND attribution.evidence_ref_id = er.evidence_ref_id
         ) AS attributed
  FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
    AS ref(ordinal, report_revision_id, permitted_text_hash, span_start, span_end, offset_unit, relation)
  LEFT JOIN waspada.evidence_references AS er
    ON er.dataset_kind = 'live'
   AND er.report_revision_id = ref.report_revision_id
   AND er.permitted_text_hash = ref.permitted_text_hash
   AND er.span_start::text = ref.span_start
   AND er.span_end::text = ref.span_end
   AND er.offset_unit = ref.offset_unit
   AND er.relation = ref.relation`;

interface CandidateRow {
  readonly event_id: string;
  readonly version: number;
  /** The publication decision time, in the same UTC form the writer's reviewed_at takes. */
  readonly decided_at: string;
  readonly record_json: unknown;
  readonly proposal_json: unknown;
}

interface ResolvedRow {
  readonly ordinal: string;
  readonly evidence_ref_id: string | null;
  readonly attributed: boolean;
}

/** One distinct supporting reference of a stored record, as the text the SQL compares. */
interface SupportKey {
  readonly report_revision_id: string;
  readonly permitted_text_hash: string;
  readonly span_start: string;
  readonly span_end: string;
  readonly offset_unit: string;
  readonly relation: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * The distinct supporting references of one stored record, in record order. An entry that does not have the shape the
 * record builder writes is counted as malformed, and is never repaired or guessed.
 */
export function supportKeysOf(record: unknown): { readonly keys: readonly SupportKey[]; readonly malformed: number } {
  const keys = new Map<string, SupportKey>();
  let malformed = 0;
  const claims = isRecord(record) && Array.isArray(record.claims) ? record.claims : [];
  for (const claim of claims) {
    const support = isRecord(claim) && Array.isArray(claim.support) ? claim.support : [];
    for (const ref of support) {
      if (!isRecord(ref)) {
        malformed += 1;
        continue;
      }
      const { report_revision_id: revision, permitted_text_hash: hash, span_start: start, span_end: end } = ref;
      const valid = typeof revision === "string" && revision.length > 0
        && typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)
        && Number.isSafeInteger(start) && Number.isSafeInteger(end) && (start as number) >= 0 && (end as number) > (start as number)
        && ref.offset_unit === "unicode_code_points" && ref.relation === "supports";
      if (!valid) {
        malformed += 1;
        continue;
      }
      const key: SupportKey = {
        report_revision_id: revision as string,
        permitted_text_hash: hash as string,
        span_start: String(start),
        span_end: String(end),
        offset_unit: "unicode_code_points",
        relation: "supports",
      };
      keys.set(JSON.stringify(Object.values(key)), key);
    }
  }
  return { keys: [...keys.values()], malformed };
}

/**
 * The claim sources whose public display check passes, in the same way decideProposal's resolvePublicDisplay builds
 * them: each claim source of the version's own proposal, checked once, fail-closed.
 */
async function permittedSourceIdsFor(
  checkPublicDisplay: (sourceId: string) => Promise<boolean>,
  proposal: unknown,
): Promise<Set<string>> {
  const claims = isRecord(proposal) && Array.isArray(proposal.claims) ? proposal.claims : [];
  const sourceIds = new Set<string>();
  for (const claim of claims) {
    if (isRecord(claim) && typeof claim.source_id === "string" && claim.source_id.length > 0) sourceIds.add(claim.source_id);
  }
  const allowed = new Set<string>();
  for (const sourceId of sourceIds) {
    try {
      if (await checkPublicDisplay(sourceId)) allowed.add(sourceId);
    } catch {
      // Fail closed: a rights check error is treated as not permitted.
    }
  }
  return allowed;
}

/**
 * One version. It resolves the support, gives the writer only the references that have no attribution row yet, and
 * writes them in one transaction. "attributed" means every resolved reference now has an approved row from this write.
 */
async function attributeVersion(
  deps: AttributionBackfillDeps,
  candidate: CandidateRow,
): Promise<"attributed" | "skipped"> {
  const { keys, malformed } = supportKeysOf(parseJsonValue(candidate.record_json));
  let unresolved = malformed;
  const lacking: string[] = [];
  if (keys.length > 0) {
    const resolved = await deps.executor.query<ResolvedRow>(RESOLVE_SQL, [
      keys.map((_, index) => String(index)),
      keys.map((key) => key.report_revision_id),
      keys.map((key) => key.permitted_text_hash),
      keys.map((key) => key.span_start),
      keys.map((key) => key.span_end),
      keys.map((key) => key.offset_unit),
      keys.map((key) => key.relation),
    ]);
    keys.forEach((_, index) => {
      const matches = resolved.rows.filter((row) => row.ordinal === String(index) && row.evidence_ref_id !== null);
      const match = matches.length === 1 ? matches[0]! : null;
      if (match === null) unresolved += 1;
      else if (!match.attributed) lacking.push(match.evidence_ref_id!);
    });
  }
  // Nothing to write: no reference resolved to one row, or a concurrent publish already attributed them all.
  if (lacking.length === 0) return "skipped";

  const publicDisplaySourceIds = await permittedSourceIdsFor(deps.checkPublicDisplay, parseJsonValue(candidate.proposal_json));
  const written = await deps.executor.transaction((tx: SqlExecutor) => writeSourceAttributions(tx, {
    datasetKind: "live",
    evidenceRefIds: lacking,
    publicDisplaySourceIds,
    decidedAt: candidate.decided_at,
  }));
  return unresolved === 0 && written.attributed === lacking.length ? "attributed" : "skipped";
}

/**
 * HOSTED-24C: runs the backfill once. Oldest publications first, at most `limit` versions, each one checked against the
 * budget before it starts. A version that throws is counted as failed, and its transaction is rolled back. A failed
 * candidate query returns a failed count of one, so the caller's run goes on. Counts only: no source text, URL or error
 * message is returned or logged.
 */
export async function backfillSourceAttributions(deps: AttributionBackfillDeps): Promise<AttributionBackfillResult> {
  const limit = deps.limit ?? ATTRIBUTION_BACKFILL_LIMIT;
  const maxFailures = deps.maxConsecutiveFailures ?? ATTRIBUTION_BACKFILL_MAX_CONSECUTIVE_FAILURES;
  let candidates: readonly CandidateRow[];
  try {
    candidates = (await deps.executor.query<CandidateRow>(CANDIDATE_SQL, [limit])).rows;
  } catch {
    return { candidates: 0, attributed: 0, skipped: 0, failed: 1 };
  }
  let attributed = 0;
  let skipped = 0;
  let failed = 0;
  let streak = 0;
  for (const candidate of candidates) {
    if (deps.now() >= deps.deadlineMs || streak >= maxFailures) break;
    try {
      const outcome = await attributeVersion(deps, candidate);
      streak = 0;
      if (outcome === "attributed") attributed += 1;
      else skipped += 1;
    } catch {
      failed += 1;
      streak += 1;
    }
  }
  return { candidates: attributed + skipped + failed, attributed, skipped, failed };
}
