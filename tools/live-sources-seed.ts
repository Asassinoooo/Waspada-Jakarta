// HOSTED-03: source-registry seeding for the live server.
//
// Owner decision (16 Nov): a revoke must survive restarts. So nothing that already exists is ever changed by a
// seed. The RSS seed inserts a missing feed as approved, active and auto-acquisition enabled. An existing row,
// including a revoked one, is left as it is. The hosted bootstrap uses the same rule for all 16 sources.
//
// Owner decision (17 Nov): all 16 sources are approved with public display. PetaBencana and BMKG get the RSS grant.
// Legacy rows that still carry only ['public'] are upgraded by upgradeStructuredPublicDisplayGrants, and nothing else.
import type { SqlExecutor } from "../apps/db/src/sql.js";
import { BMKG_GEMPA_SOURCE_ID } from "../apps/worker/src/runtime/bmkg-poll-runtime.js";
import { structuredSourceDisplayName } from "../apps/worker/src/runtime/structured-source-display.js";
import { DEFAULT_NEWS_FEEDS } from "../apps/worker/src/runtime/news-poll-runtime.js";
import { PETABENCANA_SOURCE_ID } from "../apps/worker/src/layers/l1-data-knowledge/petabencana-ingest.js";
import { STRUCTURED_LIVE_SOURCE_IDS } from "./live-source-coverage.js";

export const LOCAL_RSS_SEED_TRACE_ID = "trace-seed-rss-sources";
export const HOSTED_SEED_TRACE_ID = "trace-seed-live-sources";

/** The public-display grant. Constant SQL text only, never user input. */
const PUBLIC_DISPLAY_REUSE_BASIS_SQL =
  "ARRAY['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived', 'public_display']";
/** The legacy structured grant. It has no public_display token, so the public list never showed these sources. */
const LEGACY_STRUCTURED_REUSE_BASIS_SQL = "ARRAY['public']::text[]";

function rssDisplayName(sourceId: string): string {
  return sourceId.replace(/^source-/, "").replace(/-/g, " ").toUpperCase();
}

async function ensureSeedTrace(executor: SqlExecutor, traceId: string, metadataJson: string): Promise<void> {
  await executor.query(
    `INSERT INTO waspada.traces (trace_id, dataset_kind, started_at, outcome, metadata)
     VALUES ($1, 'live', now(), 'succeeded', $2::jsonb)
     ON CONFLICT (trace_id, dataset_kind) DO NOTHING`,
    [traceId, metadataJson],
  );
}

/** Default serve:live. Inserts missing RSS feeds only; returns how many feeds were checked. */
export async function seedRssSources(executor: SqlExecutor): Promise<number> {
  await ensureSeedTrace(executor, LOCAL_RSS_SEED_TRACE_ID, '{"seed": "all_rss_feeds"}');
  for (const feed of DEFAULT_NEWS_FEEDS) {
    const host = new URL(feed.url).host;
    await executor.query(
      `INSERT INTO waspada.source_registry (
         source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
         polling_interval_seconds
       )
       VALUES (
         $1, $2, 1, $3, 'newsroom', ARRAY['news', 'incidents'],
         'rss', ARRAY[$4]::text[], ARRAY[]::text[],
         ${PUBLIC_DISPLAY_REUSE_BASIS_SQL},
         'active', 'approved', 'healthy', true, 'never', 600
       )
       ON CONFLICT (source_id) DO NOTHING`,
      [feed.sourceId, LOCAL_RSS_SEED_TRACE_ID, rssDisplayName(feed.sourceId), host],
    );
  }
  return DEFAULT_NEWS_FEEDS.length;
}

export interface LiveSourceSeedSummary {
  readonly inserted: number;
  readonly existing: number;
}

/**
 * Hosted bootstrap. Inserts each missing row as approved, active and auto-acquisition enabled.
 * ON CONFLICT DO NOTHING means nothing that already exists is modified, so an audited revocation survives.
 * The PetaBencana and BMKG rows carry the RSS public-display grant (17 Nov). The lazy insert in serve-live-pipeline.ts
 * still writes the legacy ['public'] grant, but it is ON CONFLICT DO NOTHING and runs after this seed, so it never
 * changes these rows. A row seeded before 17 Nov is upgraded by upgradeStructuredPublicDisplayGrants, not here.
 */
export async function seedLiveSourcesInsertMissing(executor: SqlExecutor): Promise<LiveSourceSeedSummary> {
  await ensureSeedTrace(executor, HOSTED_SEED_TRACE_ID, '{"seed": "live_sources"}');
  let inserted = 0;
  for (const feed of DEFAULT_NEWS_FEEDS) {
    const host = new URL(feed.url).host;
    const result = await executor.query<{ source_id: string }>(
      `INSERT INTO waspada.source_registry (
         source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
         polling_interval_seconds
       )
       VALUES (
         $1, $2, 1, $3, 'newsroom', ARRAY['news', 'incidents'],
         'rss', ARRAY[$4]::text[], ARRAY[]::text[],
         ${PUBLIC_DISPLAY_REUSE_BASIS_SQL},
         'active', 'approved', 'healthy', true, 'never', 600
       )
       ON CONFLICT (source_id) DO NOTHING
       RETURNING source_id`,
      [feed.sourceId, HOSTED_SEED_TRACE_ID, rssDisplayName(feed.sourceId), host],
    );
    inserted += result.rows.length;
  }
  for (const sourceId of STRUCTURED_LIVE_SOURCE_IDS) {
    const result = await executor.query<{ source_id: string }>(
      `INSERT INTO waspada.source_registry (
         source_id, trace_id, registry_version, display_name, source_kind, remit,
         access_method, approved_hosts, access_restrictions, reuse_basis, registry_status,
         approval_status, health_status, auto_acquisition_enabled, auto_publication_policy,
         polling_interval_seconds
       )
       VALUES ($1, $2, 1, $3, 'authority', ARRAY['all'], 'manual_fixture',
               ARRAY[]::text[], ARRAY[]::text[], ${PUBLIC_DISPLAY_REUSE_BASIS_SQL}, 'active', 'approved', 'healthy', true, 'never', 600)
       ON CONFLICT (source_id) DO NOTHING
       RETURNING source_id`,
      [sourceId, HOSTED_SEED_TRACE_ID, structuredSourceDisplayName(sourceId)],
    );
    inserted += result.rows.length;
  }
  const total = DEFAULT_NEWS_FEEDS.length + STRUCTURED_LIVE_SOURCE_IDS.length;
  return { inserted, existing: total - inserted };
}

/**
 * Idempotent upgrade (owner decision, 17 Nov) for the PetaBencana and BMKG rows seeded before the public-display grant.
 * A row changes only when it is still approved, active and auto-acquisition enabled, and its reuse_basis is exactly
 * ['public']. Revoked, disabled, paused and already-changed rows are never touched. Returns how many rows changed.
 */
export async function upgradeStructuredPublicDisplayGrants(executor: SqlExecutor): Promise<number> {
  let upgraded = 0;
  for (const sourceId of [PETABENCANA_SOURCE_ID, BMKG_GEMPA_SOURCE_ID]) {
    const result = await executor.query<{ source_id: string }>(
      `UPDATE waspada.source_registry
          SET reuse_basis = ${PUBLIC_DISPLAY_REUSE_BASIS_SQL}
        WHERE source_id = $1
          AND approval_status = 'approved'
          AND registry_status = 'active'
          AND auto_acquisition_enabled = true
          AND reuse_basis = ${LEGACY_STRUCTURED_REUSE_BASIS_SQL}
        RETURNING source_id`,
      [sourceId],
    );
    upgraded += result.rows.length;
  }
  return upgraded;
}
