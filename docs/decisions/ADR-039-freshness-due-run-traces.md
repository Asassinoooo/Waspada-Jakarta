# ADR-039 — Auditable traces for scheduled freshness evaluation

- **Status:** Accepted
- **Date:** 2 October 2026
- **Owner:** Root planner
- **Affected scope:** LIFE-01, FR-11/13, NFR-01/05/07

## Context

The append-only freshness ledger requires every status transition to reference a `waspada.traces` row. The existing `waspada_l4_freshness_writer` can read trace identity for this foreign key but cannot create or finish a trace. A later scheduled evaluation therefore cannot use a fresh run trace under the current grants. Reusing an event's original acquisition trace would misattribute a time-based Layer 4 evaluation to older source work. Granting the freshness role unrestricted trace updates would let it rewrite unrelated audit records.

## Decision

1. Give each scheduled freshness run a stable trace ID derived from its scheduled invocation. Keep the fixed live dataset and the run's evaluation time explicit.
2. Use two narrow database functions to create or resume a freshness-run trace and to finalize it with a terminal outcome plus count-only summary. The functions set fixed metadata identifying the `freshness_due_evaluation` trigger; callers cannot provide arbitrary metadata or source/event identifiers.
3. Implement both functions as `SECURITY DEFINER` with a fixed safe `search_path`, fully qualified table access, bounded input validation, and idempotent replay rules. Revoke execution from `PUBLIC` and grant it only to `waspada_l4_freshness_writer`. Do not grant that role direct `INSERT` or `UPDATE` privileges on `waspada.traces`.
4. Begin replay with the existing run status: an open run may resume; a succeeded or failed run is already terminal and must not be reopened. Finalization accepts only `succeeded` or `failed` and a closed non-negative count object. An exact finalization replay is idempotent; changed identity, timestamps, outcome, or summary fails closed.
5. Persist only bounded operational counts in trace metadata. Do not include event IDs, evidence/source identifiers, report text, model content, connection details, or secrets.
6. This decision adds database capability only. It does not add a Worker runtime, scheduled trigger, Cron expression, role membership for a hosted login, or live-data processing.

## Consequences

The freshness recorder can later reference an auditable trace for the evaluation itself without broad trace-table grants or misusing source provenance. A future runtime must call the begin function before recording transitions and finalize the same trace afterward. Deploy-time login membership and hosted Neon behavior remain unverified and must be configured separately before enablement.

## Rejected alternatives

- Reuse the event's original trace: it does not identify the later evaluation.
- Grant direct trace-table writes to the freshness role: it expands access to unrelated audit records.
- Create an open trace and leave it unfinished: it fails to represent completion and failures accurately.
