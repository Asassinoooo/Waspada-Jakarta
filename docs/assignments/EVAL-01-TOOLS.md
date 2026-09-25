# EVAL-01-TOOLS — Casebook contract and split-leakage validator

- **Status:** Assigned for synthetic-only tooling
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
