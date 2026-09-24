# PLATFORM-01 — Cloudflare Workers and Neon Free compatibility spike

- **Status:** In progress; no provider resources or credentials are authorized
- **Depends on:** BOOT-01, SPEC-02, SPEC-03, ADR-010
- **Requirement coverage:** NFR-02/04/05/06/07/08; FR-02/07/08/14/15
- **Branch/worktree:** `work/PLATFORM-01-free-compatibility`; `D:\Projects\RPL\.codex-build\worktrees\platform-01` (`/mnt/d/Projects/RPL/.codex-build/worktrees/platform-01` in WSL)
- **Owner:** Luna Max implementation agent; root plans and reviews

## Objective

Determine whether the current low-volume class-demo design can plausibly operate within Cloudflare Workers and Neon Free limits, and record the evidence and remaining unknowns before database implementation. This is a local measurement and documentation task only. It does not activate a provider account, deploy code, create databases, use secrets, add live data, or authorize a paid fallback.

## Required output

Create `docs/PLATFORM_COMPATIBILITY.md` as a dated decision-support report. Update only the relevant evidence and compatibility statements in `docs/decisions/ADR-010-cloudflare-neon-free.md` and add primary-source links to `REFERENCES.md` as needed. Append a concise handoff to this assignment.

The report must distinguish, for every result, among:

- **Official limit or capability:** current provider documentation, with direct official URL and access date.
- **Local measurement:** a command, workload, environment, and observed value that can be reproduced in WSL.
- **Estimate:** an explicit scenario and arithmetic, clearly not a provider measurement or operational forecast.
- **Unknown/not tested:** a dependency absent from the local prototype or requiring a provider account/resource. State what would be needed to resolve it without doing that work.

Cover Workers request and CPU limits, memory/subrequests/connections, Workflow steps and retries, Cron triggers, Hyperdrive SQL/connection behavior, Workers AI free access/quota and model restrictions, Neon compute/storage/transfer/suspend/restore and backup limits, PostGIS/pgvector support on Free, and the implications for the no-paid-fallback rule. Include a concise compatibility matrix with the quota response and the UI/system failure behavior.

Use local WSL Ubuntu-26.04 to measure what the current repo can actually measure: representative GET route latency and response sizes, application bundle size/build result, and current smoke/test behavior. The current runtime has no database, durable workflow, source poller, or model calls: do not fabricate Neon cold-start, SQL, workflow-step, Workers AI, or provider-side CPU measurements. For those, give clearly labelled envelopes based on documented limits and identify the missing integration.

Use explicit low-volume demonstration scenarios grounded in the existing plan. If an input such as expected users, polling cadence, database region, backup retention, or model choice has no agreed value, show a bounded sensitivity table or mark it unresolved; do not silently choose a production load target. State whether the current 30-day off-provider backup requirement remains unmet and whether live persistence must remain blocked.

## Boundaries

- Allowed paths: `docs/PLATFORM_COMPATIBILITY.md`, `docs/decisions/ADR-010-cloudflare-neon-free.md`, `REFERENCES.md`, and this assignment's handoff section.
- Do not change application code, APIs, schemas, migrations, dependencies, model prompts, source policy, or other ADRs.
- Use primary/official provider documentation for current specifications. Do not sign in, create a project/database, submit forms, enable billing, run a paid-tier trial, or transmit credentials or project data.
- Do not use provider account dashboards, deployment commands, external database URLs, or environment secrets. Wrangler dry-run/local mode only.
- Do not claim a tier is compatible merely because its advertised ceilings look sufficient. Separate documented ceilings from actual plan/feature availability and from behavior still requiring an authorized Free resource.

## Acceptance and checks

- The report contains direct official links with access dates, source-backed quota tables, explicit assumptions, failure actions, and a clear tested/untested split.
- The current UI/API remains runnable without provider access, and no external resource or dependency is created.
- WSL commands, environment versions, raw result summaries, and any limits of the test method are recorded. Run `npm run smoke`; run `npm test`, `npm run typecheck`, and `npm run build` if edits or test harness changes require them.
- `git diff --check` passes; the assigned branch changes only allowed paths.
- Commit the completed task on this branch using a descriptive message. Do not push, deploy, or merge.

## Handoff

Agent appends commit SHA/message, changed files, primary sources and access date, WSL commands/results, the distinction between measured and estimated values, open compatibility gates, and any follow-up needed. Root records acceptance and pushes the reviewed checkpoint.
