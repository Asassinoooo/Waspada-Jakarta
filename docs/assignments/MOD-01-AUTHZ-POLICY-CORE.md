# MOD-01-AUTHZ-POLICY-CORE — server-side moderator authorization kernel

- **Status:** Assigned; implementation pending.
- **Backlog:** [MOD-01-AUTHZ-POLICY-CORE](../IMPLEMENTATION_BACKLOG.md).
- **Implementation agent:** `gpt-6-luna` / `max`; root reviews and accepts.
- **Branch:** `work/MOD-01-AUTHZ-POLICY-CORE`.
- **Dedicated worktree:** `C:\Users\perry\.codex\worktrees\ui-02-pref-core\RPL` (reused only after confirming the prior task is complete and the checkout is clean). WSL path: `/mnt/c/Users/perry/.codex/worktrees/ui-02-pref-core/RPL`.

## Objective

Add a pure, deterministic Layer 4 authorization policy that decides whether a server-resolved active moderator principal may perform a closed set of moderation actions against the dataset selected by server configuration. This is the authorization kernel only: it must not authenticate identities, derive roles from request data, expose a route, or perform a publication write.

## Read first

- `SOFTWARE_DEVELOPMENT_PLAN.md` (five-layer boundaries and current implementation state).
- `docs/IMPLEMENTATION_BACKLOG.md` (MOD-01 and task dependencies).
- `docs/decisions/ADR-006-moderator-auth.md` (accepted identity, role and dataset security contract).
- `docs/assignments/PUB-POLICY-CORE.md` and `docs/assignments/PUB-WRITE-CORE.md` (publication remains a separate L4 gate and writer).
- Existing Layer 4 policy code under `apps/worker/src/layers/l4-application-integration/` and worker test conventions.

## Dependencies and boundaries

- Inputs: accepted ADR-006 role rules; schema 2.0 domain boundary; existing PUB-POLICY-CORE and PUB-WRITE-CORE contracts.
- Public API/OpenAPI contract: unchanged.
- The identity integration choice is unresolved. Do not select or implement Cloudflare Access, app passwords, sessions, JWT validation, credential hashing or account provisioning in this task.
- A caller must provide a principal already resolved by a future trusted authentication boundary. Never accept client-provided role, active state, actor ID or dataset scope as proof of authorization.
- This decision only authorizes an action to be attempted. It does not establish source rights, evidence support, eligibility, or permission to bypass PUB-POLICY-CORE/PUB-WRITE-CORE.
- No route, SQL, migration, database grant, provider configuration, secret, dependency, live source or real moderator account is authorized.

## Allowed paths

- `apps/worker/src/layers/l4-application-integration/moderator-authorization.ts`
- `apps/worker/test/l4-moderator-authorization.test.ts`
- `apps/worker/package.json` (only to register the new test in the existing script; no dependency or lockfile changes)
- This assignment file (implementation handoff only)

Do not edit unrelated plans, contracts, generated output, fixtures used by public/demo flows, or any other path without asking root.

## Required behavior

Define closed types for server-resolved principal, action and dataset selection, plus a fixed allow/deny result. The action set must represent the accepted ADR-006 moderator responsibilities: review evidence, approve a supported publication, submit an eligible correction, retract information, approve a source, and manage moderator access. A `moderator` may perform the first four. An `admin` may perform all six. Any future action or role must fail closed until added to this policy deliberately.

Every allow decision requires an active principal whose dataset scope matches both the requested target dataset and the dataset selected by trusted server configuration. Missing, inactive, malformed, unknown-role, unknown-action and cross-dataset inputs must deny with bounded stable reason codes. Do not include private identity or request content in results or logs.

## Acceptance scenarios

- Moderator and admin receive only their documented permissions; admin-only source/account actions cannot be performed by a moderator.
- Inactive or missing principals, unrecognized roles/actions and malformed identities deny.
- A principal cannot read or act on a dataset different from its server-assigned scope or the server-selected dataset.
- Authorization success for publication/correction/retraction does not itself approve claims or bypass the existing evidence/publication policy.
- Tests prove the decision remains deterministic and closed to unknown values; all data are synthetic fixtures.
- No public endpoint, authentication mechanism, database operation, identity provider, API contract or external resource changes.

## Verification (run in WSL Ubuntu-26.04)

- `npm test --workspace=@waspada/worker`.
- `npm run typecheck --workspace=@waspada/worker`.
- `git diff --check` on the task branch.

Use only existing locked dependencies. Record actual command output/results; do not claim unrun checks. Do not use paid APIs, provider configuration, real source data or live databases.

## Stop and escalation conditions

Stop and ask root if the existing ADRs/contracts imply an action permission not covered by the matrix above, if policy requires changing a public contract or publication semantics, or if any implementation would need trusted identity/session input not already available. Do not ask the user directly. Do not spawn subagents or change branches. Escalate to Astra only if Luna/max attempts the task and cannot resolve a substantive technical difficulty; report the attempted evidence first.

## Handoff

The implementer must commit coherent changes on the assigned branch with descriptive messages, including an implementation handoff in this file. Report branch/worktree, commit SHA(s) and exact messages, changed paths, behavior, actual checks/results, limitations, migration/configuration impact, and remaining decisions. Do not push, merge or deploy. Root reviews before acceptance.
