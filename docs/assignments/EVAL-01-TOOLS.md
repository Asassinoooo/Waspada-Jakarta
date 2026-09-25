# EVAL-01-TOOLS — Casebook contract and split-leakage validator

- **Status:** Accepted for synthetic-only tooling
- **Parent:** EVAL-01
- **Depends on:** SPEC-01, SPEC-02
- **Requirements:** FR-15; NFR-01
- **Branch/worktree:** `work/EVAL-01-tools`; `.codex-build/worktrees/eval-01-tools`
- **Owner:** GPT-6 Luna Max implementation agent; root plans and reviews

## Objective

Prepare a versioned, machine-checked casebook format and release-readiness validator so the team can curate EVAL-01 consistently after its human-reviewer and source-rights inputs are known. This is tooling only: it must not create or imply actual human labels, acquire external reports, or claim retrieval/model quality.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`, especially Sections 7 and 10
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/DOMAIN_MODEL.md`
- `docs/SOURCE_FEASIBILITY.md`
- `docs/SOURCE_FEASIBILITY.md` (SPEC-01)
- `docs/contracts.schema.json`
- `apps/worker/src/layers/l2-model-grounding/contracts.ts`
- Existing root scripts and TypeScript test setup

## Scope and required behavior

- Add a versioned casebook contract, documentation, and strict local validator/test tooling. Keep this outside the Worker production bundle.
- A casebook identifies reports by stable IDs, source, revision/content hash, known origin group and an external permission-controlled content reference. Do not embed article bodies, copied excerpts, personal data, unlicensed geometry, or credentials in the casebook or Git fixtures.
- Casebooks may be `historical` or `synthetic`; a `live` dataset cannot be used for offline evaluation. Synthetic fixtures must be visibly marked and can never count toward release readiness.
- Preserve independent human review records separately from adjudicated case labels. Each reviewer ID must be distinct within a case. Machine/model outputs cannot occupy human-review or adjudication fields. Represent unknown, disputed and not-applicable values explicitly rather than filling them from model output.
- Cover the agreed evaluation dimensions: incident grouping/identity, category, event and observation time, location or audience scope, evidence relation and source-origin dependence, and expected publication disposition. Reuse existing category and evidence relation enums where they apply; do not change public/L2 contracts.
- Assign one split (`development`, `validation`, or `held_out`) per incident case. Reject report/revision/origin/content-hash leakage across case or split boundaries. A held-out split is not tunable; record its freeze state and timestamp explicitly.
- Record explicit curator-assigned scenario coverage tags for the four complete scenarios in SDP Section 5: historical crime, gathering plus transport impact, weather warning plus flood observation, and a non-geographic group notice. Scenario tags describe planned evaluation coverage and are not model output.
- Provide a release-readiness check that requires at least 40 rights-cleared historical reports across at least 12 cases and at least three reports per case, two distinct human reviewers and a reconciled adjudication for each case, approved evaluation-use rights for every source, a frozen held-out split, all ten category values represented in reconciled case labels, and all four SDP scenarios represented. Synthetic samples and incomplete drafts remain non-ready.
- Add only authored synthetic test values. Tests may exercise the release validator with in-memory structure-shaped values but must be labelled as validator tests, never as real reports, human judgements, or ground truth.
- Add no source/model calls, DB writes, routes, auth, dependencies, or live dataset. The user identified Perry Tjahya and Jesaya Hamonangan Gaudensius Malau as the independent-reviewer pair for future human labeling. Source/data rights remain pending, so do not acquire or retain real reports or begin EVAL-01 labeling until rights are documented.

## Allowed paths

- `docs/evaluation/CASEBOOK.md`
- `docs/evaluation/casebook.schema.json`
- `docs/evaluation/fixtures/synthetic-casebook.json`
- `tools/evaluation/casebook.ts`
- `tools/evaluation/casebook.test.ts`
- `tools/evaluation/tsconfig.json`
- `package.json` — only test/typecheck script entries needed to include the validator checks
- This assignment's implementation handoff only

Root owns the backlog, plan, decision log, reviewer roster and any real-data authorization. If the casebook would require a contract change, source-content permission, or ambiguity in the prescribed labels, report the exact gap before broadening scope.

## Acceptance and checks

- Tests reject malformed or unknown fields, any `live` casebook, embedded source text, repeated reviewer IDs, missing adjudication, duplicate report identity, and split leakage through revisions or known origins.
- Tests prove synthetic/incomplete casebooks cannot pass release readiness; rights, minimum counts, reviewers, adjudication, frozen held-out state, all-ten-category coverage and four-scenario coverage are separate and produce stable reason codes.
- Tests and sample data make no factual or model-quality claim. No real report or reviewer information is added.
- In WSL Ubuntu-26.04 run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- Commit all work on the task branch with descriptive messages, leave a clean worktree, and append actual changes, checks, limitations and unresolved decisions here. Do not push or merge.

## Implementation handoff

The implementation agent appends its branch/worktree, commit SHAs/messages, changed paths, behavior, actual checks, limitations, and any scope issue here. Root reviews and accepts the task before integration.

### Implementation handoff — 25 September 2026

- **Branch/worktree:** `work/EVAL-01-tools`; `D:\Projects\RPL\.codex-build\worktrees\eval-01-tools` (`/mnt/d/Projects/RPL/.codex-build/worktrees/eval-01-tools` in WSL).
- **Base:** `f459052ae2aefe85e4250f3792a37e80d7192b47` (`docs(EVAL-01): assign synthetic casebook tooling`).
- **Implementation commit:** `81eebdbae14adccc2bf233a226f0f0a1b087be4e` — `feat(EVAL-01-TOOLS): add strict casebook validator`.
- **Handoff commit:** this section is a separate documentation commit immediately after the implementation commit; its resulting SHA is included in the task completion report.
- **Implementation paths:** `docs/evaluation/CASEBOOK.md`, `docs/evaluation/casebook.schema.json`, `docs/evaluation/fixtures/synthetic-casebook.json`, `tools/evaluation/casebook.ts`, `tools/evaluation/casebook.test.ts`, `tools/evaluation/tsconfig.json`, and `package.json` (only `test` and `typecheck` script entries).
- **Handoff path:** `docs/assignments/EVAL-01-TOOLS.md` only.

The 1.0 closed casebook contract supports historical metadata and synthetic validator fixtures; live datasets are rejected. Reports use opaque permission-controlled content references, revision/content hashes, source IDs, and nullable known-origin IDs, never source text. Category values come from L2 `CATEGORIES`; evidence relations are type-checked for complete parity with L2 `EvidenceRelation`, and tests compare both schema enum copies with the current L2/validator definitions. Human reviews and adjudication are distinct typed records. Case-level labels cover identity, category, event time, scope, and disposition; every review/adjudication includes one report-specific assessment for each member's observation time, evidence relations, and origin dependence. Unknown, disputed, and not-applicable statuses remain explicit. Duplicate report/revision identities and cross-case origin/content-hash leakage fail closed; cross-split collisions receive `SPLIT_LEAKAGE` as well. Readiness returns stable separate codes for rights, counts, review/adjudication, and held-out freeze requirements. Synthetic data always remains non-ready.

The checked-in fixture is visibly synthetic and contains no review or adjudication records. Readiness edge cases use invented in-memory structures with pending rights and placeholder IDs only; they are validator tests, not reports, rights approvals, human judgments, ground truth, or evaluation findings. The checker cannot authenticate external rights, reviewer identities, source independence, or a held-out freeze process. The freeze field records a declaration and timestamp but cannot prevent later edits. No source/model/network/database calls, real data, dependency changes, migration, contract/API/UI changes, deployment, push, or merge occurred. There are no unresolved implementation blockers; actual source-use approvals and human labeling remain separate future gates.

**Checks run in WSL Ubuntu-26.04 (all passed):**

```text
Runtime probe:
wsl.exe -d Ubuntu-26.04 -- bash -lc "export PATH='/home/perry/.local/opt/waspada-node-v24.21.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/mnt/d/Projects/RPL/node_modules/.bin' && cd '/mnt/d/Projects/RPL/.codex-build/worktrees/eval-01-tools' && uname -a && cat /etc/os-release && command -v node && command -v npm && node -p 'JSON.stringify({platform:process.platform,execPath:process.execPath,version:process.version})' && node --version && npm --version && file /home/perry/.local/opt/waspada-node-v24.21.0/bin/node"
Result: Ubuntu 26.04 LTS under WSL2; node/npm resolve under /home/perry/.local/opt/waspada-node-v24.21.0/bin; process.platform=linux; node is an x86-64 GNU/Linux ELF; Node v24.21.0, npm 11.19.0.

npm test
Result: passed — web 5/5, Worker 43/43, DB 40/40, casebook 11/11.

npm run typecheck
Result: passed — web, Worker, DB, and standalone evaluation tooling TypeScript checks.

npm run build
Result: passed — included typecheck, Vite production build, and Wrangler deploy dry-run.

git diff --check
Result: passed (exit 0); staged implementation diff also passed git diff --cached --check before commit.
```

No runtime JSON Schema dependency was added. Tests parse the schema JSON and assert its version, closed top-level shape, live-data exclusion, and taxonomy parity; semantic validation, including calendar/date-time correctness and per-report label coverage, is exercised by the standalone TypeScript validator tests.

### Coverage follow-up handoff — 25 September 2026

- **Branch/worktree:** `work/EVAL-01-tools`; `D:\Projects\RPL\.codex-build\worktrees\eval-01-tools` (`/mnt/d/Projects/RPL/.codex-build/worktrees/eval-01-tools` in WSL).
- **Follow-up scope:** implemented the release-readiness coverage requirements from the root-owned assignment amendment at `6bcf7cb` without merging or rebasing this branch.
- **Parent:** `fa0c5d5c75781351b6335d0ff24e5faf8ee6647e` — `docs(EVAL-01-TOOLS): record implementation handoff`.
- **Implementation commit:** `bcfed900edce30d2562d50cac0a83e322efaeb78` — `feat(EVAL-01-TOOLS): require category and scenario coverage`.
- **Changed implementation paths:** `docs/evaluation/CASEBOOK.md`, `docs/evaluation/casebook.schema.json`, `docs/evaluation/fixtures/synthetic-casebook.json`, `tools/evaluation/casebook.ts`, and `tools/evaluation/casebook.test.ts`.
- **Handoff path:** `docs/assignments/EVAL-01-TOOLS.md` only.

Each case now requires `scenario_tags`, restricted to the four assigned casebook IDs; the checked-in synthetic fixture uses an empty array. Scenario tags are documented and typed as explicit curator coverage metadata, never model output. Readiness returns separate `CATEGORY_COVERAGE_INCOMPLETE` and `SCENARIO_COVERAGE_INCOMPLETE` codes. Category coverage counts only labeled `labels.category` assessments on reconciled adjudications; unknown, disputed, and not-applicable values and labels from pending adjudications do not count. Tests isolate one missing category and one missing scenario, reject missing/unknown/duplicate tags, and verify a structure-only shape with full category/scenario coverage remains non-ready solely because source rights are pending.

The fixture and tests contain only authored synthetic or invented in-memory structures. No checked-in fixture or test value represents actual rights approval, and no report or reviewer data was acquired. No dependency, public contract, migration, API, UI, provider integration, or runtime behavior outside the standalone evaluation validator changed. Actual source rights, reviewer authenticity, label accuracy, representativeness, and release approval remain external decisions.

**Checks run in WSL Ubuntu-26.04 (all passed):**

```text
Runtime: Node v24.21.0, npm 11.19.0, process.platform=linux.

npm test
Result: passed — web 5/5, Worker 43/43, DB 40/40, casebook 12/12.

npm run typecheck
Result: passed — web, Worker, DB, and standalone evaluation tooling TypeScript checks.

npm run build
Result: passed — included typecheck, Vite production build, and Wrangler deploy dry-run.

git diff --check
Result: passed (exit 0) with GIT_DIR=/mnt/d/Projects/RPL/.git/worktrees/eval-01-tools and GIT_WORK_TREE=/mnt/d/Projects/RPL/.codex-build/worktrees/eval-01-tools set for the linked worktree.
```

The WSL Git workaround only supplies the linked worktree metadata paths explicitly because its `.git` pointer contains a Windows path. No source/network/provider/database calls, dependency changes, deployment, push, or merge occurred.

### Root review and acceptance — 25 September 2026

Root reviewed the task branch, including the closed schema, validator, fixture, tests, and handoff. The branch was merged into `main` as `9f80600` (`merge(EVAL-01-TOOLS): accept synthetic casebook tooling`). Root independently reran checks in WSL Ubuntu-26.04 with Node.js `v24.21.0` and npm `11.19.0`: `npm test` passed 100/100 (web 5, Worker 43, DB 40, casebook 12), `npm run typecheck`, `npm run build` (Vite production output and Wrangler dry-run), and `git diff --check` passed.

Acceptance is limited to the synthetic-only format and local readiness tooling. Perry Tjahya and Jesaya Hamonangan Gaudensius Malau are the identified future independent reviewers; neither has labeled reports in this task. Source/data retention and evaluation rights remain pending. The checker validates declarations and structure; it does not authenticate rights, reviewers, labels, freeze procedures, or any model-quality claim.
