// HOSTED-03: source-registry seeding for the live server.
//
// Owner decision (16 Nov): a revoke must survive restarts. So nothing that already exists is ever changed by a
// seed. The RSS seed inserts a missing feed as approved, active and auto-acquisition enabled. An existing row,
// including a revoked one, is left as it is. The hosted bootstrap uses the same rule for all 16 sources.
import type { SqlExecutor } from "../apps/db/src/sql.js";
import { DEFAULT_NEWS_FEEDS } from "../apps/worker/src/runtime/news-poll-runtime.js";
import { STRUCTURED_LIVE_SOURCE_IDS } from "./live-source-coverage.js";

export const LOCAL_RSS_SEED_TRACE_ID = "trace-seed-rss-sources";
export const HOSTED_SEED_TRACE_ID = "trace-seed-live-sources";

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
         ARRAY['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived', 'public_display'],
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
 * The PetaBencana and BMKG values mirror the lazy insert in serve-live-pipeline.ts. Approval, the active status,
 * the auto-acquisition flag and polling_interval_seconds (600, the same as the RSS rows) differ. The lazy insert
 * is ON CONFLICT DO NOTHING and runs after this seed, so it never overrides these rows.
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
         ARRAY['model_triage', 'model_description', 'retain_title', 'retain_description', 'retain_derived', 'public_display'],
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
       VALUES ($1, $2, 1, $1, 'authority', ARRAY['all'], 'manual_fixture',
               ARRAY[]::text[], ARRAY[]::text[], ARRAY['public'], 'active', 'approved', 'healthy', true, 'never', 600)
       ON CONFLICT (source_id) DO NOTHING
       RETURNING source_id`,
      [sourceId, HOSTED_SEED_TRACE_ID],
    );
    inserted += result.rows.length;
  }
  const total = DEFAULT_NEWS_FEEDS.length + STRUCTURED_LIVE_SOURCE_IDS.length;
  return { inserted, existing: total - inserted };
}
