# JOB-01-LOCAL-PRIVATE-PIPELINE — bounded local composition

Status: accepted locally, 12 October 2026. Parent JOB-01 and RAG-01 remain in progress.

Objective: opt-in automatic polling of one authored synthetic JSON API fixture, immutable version capture, durable local ingestion, deterministic L1 persistence before AI, then bounded private L2 proposals. No publication or live source activation.

Dependencies: JOB-01 queue/claim/recovery, L1 text preparation and immutable revision/evidence repositories, DATA-02 chunk/embedding persistence, L2-ADAPTER-01, RAG-CORE, grounding context persistence and reasoning proposal bridge; ADR-054/055. Domain schema 2.0 and public v1 remain unchanged. `tools/local-pipeline/contracts.ts` freezes the local composition interface.

## Implementation packages

- **JOB-01-LOCAL-INBOX-CORE**: isolated branch/worktree; allowed `tools/local-pipeline/database.ts`, `store.ts`, `store.test.ts`, `local-schema.sql`. Implement file-backed PGlite bootstrap with a synthetic/profile ownership marker; transactional immutable snapshots + canonical source-poll jobs; separate local AI leases/checkpoints/retries. Reuse queue policy and canonical repositories. No hosted migration or role change.
- **RAG-01-LOCAL-PRIVATE-PROCESSOR**: isolated branch/worktree; allowed `tools/local-pipeline/feed.ts`, `processor.ts`, `mock-models.ts`, `processor.test.ts`, `fixtures/feed.json`. Strict bounded authored-feed parser; reuse L1 preparation/revision/chunks, L2 extraction/embedding/grounding/reasoning and canonical private proposal writer. Exact source-origin lineage remains unknown, never independent corroboration. Models execute outside SQL transactions; validated stage receipts avoid calls after committed stages. Root integrates the inbox dependency before composition verification.
- Root owns CLI/scheduler, composition tests, scripts/typecheck registration, documentation and integration. A separate Luna/max reviewer inspects implementation and test evidence; implementers do not approve themselves.

## Acceptance and checks

Unchanged polls create no jobs/model calls; changes create immutable superseding versions, including A→B→A. Queued jobs read captured snapshots. Duplicate delivery/restart converge without duplicate canonical results; a crash before a model receipt may repeat a provider call and must not be described as exactly-once inference. Leases fence writes; expired leases, bounded exponential retry and exhausted jobs retain recoverable source data. Timeout/invalid AI leaves closed failure state while collection continues. Synthetic-only receipts and state stay ignored; public tables/routes remain untouched.

Execute in WSL Ubuntu-26.04, Node 24.21.0, existing dependencies only:

```sh
export PATH=/home/perry/.nvm/versions/node/v24.21.0/bin:$PATH
npx tsx --test tools/local-pipeline/store.test.ts
npx tsx --test tools/local-pipeline/processor.test.ts
npm run pipeline:test
npm run typecheck
npm test
npm run build
npm run smoke
```

Stop and report contract conflicts, unapproved source access or external configuration needs. Never substitute models, install dependencies, read credentials, call real providers, publish, merge or push from an implementation agent. Coherent task commits and handoff list exact SHA/message/paths/actual checks/limitations. Root accepts task status only after independent review.

## Handoff and root acceptance

Luna/max agents used isolated `codex/job-01-local-inbox` / `.codex-build/worktrees/local-inbox` and `codex/rag-01-local-processor` / `.codex-build/worktrees/local-processor`. A temporary model usage limit interrupted both; they resumed with the same configuration and no escalation/substitution. Inbox commits: `0958a85` — `feat(JOB-01): add local synthetic inbox core`; `d5de32b` — `fix(JOB-01): enforce immutable local snapshots`; `f5a62bc` — `fix(JOB-01): create local state directories`. Processor commits: `8468b75` — `feat(RAG-01): add local private polling processor`; `0a51c37` — `fix(RAG-01): reuse captured trace during L1 processing`.

Root reviewed the diffs and composed them on `codex/local-pipeline-integration`; a separate Luna/max reviewer inspected each implementation/fix plus CLI, scheduler and acceptance tests. Review/integration caught mutable snapshots/source binding, duplicate captured-trace insertion, retrieval preview mismatch, unrelated hybrid candidates, fatal-worker stop, gateway profile identity and new nested-directory startup. All current blockers were resolved. Root acceptance: isolated pipeline27/27, regression suites web126/Worker516/DB45files/evaluation-AI36, typecheck, build/dry-run and UI/API smoke pass. Actual mock watch/reopen/status retains one private proposal without duplicates. No real model/source/cloud/publication action ran. See [startup, exact limits and checks](../LOCAL_PRIVATE_PIPELINE.md).

The initial full test command failed during the new suite with a native Node24 V8/WASM assertion. Root's per-case process isolation rerun passed; old regression suites were already green and were not rerun. Hosted concurrency, scalable retrieval (16 global rows/8 results), real extraction latency, source rights/model transfer and quality evaluation remain open. Terminal L1 predecessor repair has no automatic operation. No migration, grant, dependency version, public API or Worker runtime changed.
