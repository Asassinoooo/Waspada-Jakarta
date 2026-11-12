import type { PipelineFlowNodeId, PipelineFlowSnapshotDto } from "@waspada/worker/pipeline-flow-contracts";

/**
 * Hand-written snapshot for the web tests. It mirrors the `pipeline-flow-v1` shape and labels
 * itself demo. It carries no real records and no text outside the fixed sample labels.
 */
export function demoSnapshot(): PipelineFlowSnapshotDto {
  const counts = (values: Record<string, number>) => values;
  const nodes = [
    { id: "src_petabencana", lane: "L1", health: "active", counts: counts({ sources: 1, healthy: 1, unhealthy: 0, revisions_24h: 14 }), throughput_15m: 2 },
    { id: "src_bmkg", lane: "L1", health: "idle", counts: counts({ sources: 1, healthy: 1, unhealthy: 0, revisions_24h: 0 }), throughput_15m: 0 },
    { id: "src_rss", lane: "L1", health: "failing", counts: counts({ sources: 14, healthy: 13, unhealthy: 1, revisions_24h: 61 }), throughput_15m: 4 },
    { id: "dedupe", lane: "L1", health: "active", counts: counts({ title_last_cycle: 2, cycle_last_cycle: 1, hits_total: 3 }), throughput_15m: 3 },
    { id: "det_filter", lane: "L1", health: "active", counts: counts({ skipped_24h: 40, skipped_15m: 3 }), throughput_15m: 3 },
    { id: "triage", lane: "L1", health: "waiting", counts: counts({ ingest_24h: 52, drop_24h: 19, uncertain_24h: 3, rate_limited_24h: 4, provider_error_24h: 0, invalid_output_24h: 0 }), throughput_15m: 5 },
    { id: "revisions", lane: "L1", health: "active", counts: counts({ unreviewed_24h: 9, eligible_24h: 58, quarantined_24h: 2, superseded_24h: 4, retracted_24h: 0, active_chunks: 212 }), throughput_15m: 6 },
    { id: "ai_queue", lane: "L2", health: "waiting", counts: counts({ pending: 3, leased: 1, retry: 2, needs_review: 0, completed_24h: 33, terminal_24h: 1 }), throughput_15m: 2 },
    { id: "interpret", lane: "L2", health: "active", counts: counts({ checkpointed_open: 1, leased: 1 }), throughput_15m: 1 },
    { id: "embed", lane: "L2", health: "active", counts: counts({ available_24h: 31, failed_24h: 0, invalidated_24h: 0 }), throughput_15m: 2 },
    { id: "retrieve", lane: "L2", health: "active", counts: counts({ active_chunks: 212, searchable_24h: 31 }), throughput_15m: 2 },
    { id: "correlate", lane: "L3", health: "active", counts: counts({ same_incident_24h: 18, new_incident_24h: 12, unresolved_24h: 3, incidents_open: 9 }), throughput_15m: 2 },
    { id: "proposal", lane: "L3", health: "active", counts: counts({ proposed_24h: 15, pending: 5, pending_discrepancy: 2 }), throughput_15m: 1 },
    { id: "gate", lane: "L4", health: "active", counts: counts({ auto_publish_24h: 9, moderator_publish_24h: 1, reject_24h: 2 }), throughput_15m: 1 },
    { id: "review", lane: "L4", health: "waiting", counts: counts({ waiting_discrepancy: 2, waiting_gate: 3, moderator_decisions_15m: 0, expired_24h: 2 }), throughput_15m: 0 },
    { id: "published", lane: "L4", health: "active", counts: counts({ events_published: 11, versions_24h: 10, agent_versions_24h: 9, moderator_versions_24h: 1 }), throughput_15m: 1 },
    { id: "ninerouter", lane: "L5", health: "waiting", counts: counts({ calls_total: 1522, chat_tokens_available: 6, embed_tokens_available: 21, in_flight: 1, queued: 2, cooldown_ms: 42000 }), throughput_15m: 10 },
    { id: "cycle", lane: "L5", health: "active", counts: counts({ running: 0, error_count: 0, new_items_used: 4, new_items_cap: 5, feeds_failed: 1, duration_ms: 1800 }), throughput_15m: 3 },
  ] as PipelineFlowSnapshotDto["nodes"];
  const edgeTargets: ReadonlyArray<readonly [PipelineFlowNodeId, PipelineFlowNodeId]> = [
    ["src_petabencana", "revisions"], ["src_bmkg", "revisions"], ["src_rss", "dedupe"], ["dedupe", "det_filter"],
    ["det_filter", "triage"], ["triage", "revisions"], ["revisions", "ai_queue"], ["ai_queue", "interpret"],
    ["interpret", "embed"], ["embed", "retrieve"], ["retrieve", "correlate"], ["correlate", "proposal"],
    ["proposal", "gate"], ["gate", "published"], ["gate", "review"], ["review", "published"],
  ];
  const throughput = new Map<string, number>(nodes.map((node) => [node.id, node.throughput_15m] as const));
  return {
    schema_version: "pipeline-flow-v1",
    generated_at: "2026-11-11T09:00:00.000Z",
    dataset_mode: "demo",
    window_hours: 24,
    nodes,
    edges: edgeTargets.map(([from, to]) => ({ from, to, throughput_15m: throughput.get(to) ?? 0 })) as PipelineFlowSnapshotDto["edges"],
    runtime: {
      generated_at: "2026-11-11T09:00:00.000Z",
      ninerouter: {
        chat: { rpm: 10, tokens_available: 6, cooldown_remaining_ms: 42_000, in_flight: 0, queued: 2 },
        embed: { rpm: 30, tokens_available: 21, cooldown_remaining_ms: 0, in_flight: 1, queued: 0 },
        call_counts: { chat: 318, embed: 1204 },
      },
      cycle: {
        running: false, sequence: 3, started_at: "2026-11-11T08:59:10.000Z", finished_at: "2026-11-11T08:59:12.000Z",
        duration_ms: 2000, new_items_cap: 5, new_items_used: 4, feeds_total: 14, feeds_failed: 1, error_count: 0,
      },
    },
  };
}
