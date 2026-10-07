# EVAL-01-CASEBOOK-CLI-CORE — local metadata-only casebook command

**Status:** Assigned; local tooling only<br>
**Backlog ID:** `EVAL-01-CASEBOOK-CLI-CORE`<br>
**Parent:** `EVAL-01`<br>
**Dependencies:** `EVAL-01-TOOLS` (accepted)<br>
**Contract baseline:** Evaluation casebook schema 1.0, `validateCasebook`, and `evaluateReleaseReadiness`; no schema or label-contract change<br>
**Implementation model:** GPT-6 Luna, max reasoning<br>
**Branch:** `work/EVAL-01-CASEBOOK-CLI-CORE`<br>
**Worktree:** `.codex-build/worktrees/eval-01-casebook-cli-core`<br>
**Assigned base:** Pinned by root in the task dispatch before implementation.

## Objective

Expose the accepted standalone evaluation validator through a local command so a future metadata-only, rights-cleared casebook can be checked without importing TypeScript functions manually. The command is a structural and declared-readiness check only. It does not verify a permission record, authenticate reviewers, establish label accuracy, or make an evaluation-quality or release claim.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md`
- `docs/evaluation/CASEBOOK.md`
- `docs/evaluation/casebook.schema.json`
- `tools/evaluation/casebook.ts`
- `tools/evaluation/casebook.test.ts`
- Root `package.json` and `tools/evaluation/tsconfig.json`

## Required behavior

1. Add `npm run eval:casebook -- <path>` for one caller-supplied local JSON file. Accept absolute and working-directory-relative paths; reject missing or additional arguments. Do not fetch URLs or invoke a shell.
2. Enforce a 5 MiB input cap with a bounded local-file read before parsing. A casebook contains metadata only, so the cap is sufficient for the minimum evaluation corpus; do not read an unbounded file and check its size only afterward.
3. Parse UTF-8 JSON and call both existing `validateCasebook` and `evaluateReleaseReadiness`. Do not duplicate or weaken their validation rules, and do not change the casebook schema or evaluator.
4. Emit one stable JSON result with only `valid`, `metadata_ready`, `issue_codes`, and `readiness_reasons`. Do not include source, report, case, reviewer, adjudicator or permission identifiers; content hashes; labels; input contents; local paths; exception messages; or stack traces. Preserve stable reason codes from the existing validator.
5. For usage, read, size and JSON failures, emit a fixed machine-readable error code to stderr and return exit code `2`. For a structurally invalid casebook, return a redacted validation result and exit code `2`. For a valid but not-ready casebook, return its readiness reasons and exit code `1`. Return exit code `0` only when the declared metadata passes the existing readiness checks.
6. Document that `metadata_ready` is not proof that external rights, reviewer identities, adjudication, data independence, held-out freezing, or quality were verified. The checked-in synthetic fixture must continue to return not-ready.
7. Add tests using only the existing synthetic fixture and temporary metadata-only files. Verify usage, size/read/JSON errors, invalid input, valid-but-not-ready output, exit codes, and absence of sentinel identifiers/content from stdout and stderr. Do not create a test case that claims approved rights or completed human labels.

## Allowed paths

- `tools/evaluation/casebook-cli.ts` (new)
- `tools/evaluation/casebook-cli.test.ts` (new)
- `tools/evaluation/tsconfig.json`
- Root `package.json` (script/test registration only; no dependency or version changes)
- `docs/evaluation/CASEBOOK.md`
- `docs/assignments/EVAL-01-CASEBOOK-CLI-CORE.md` (handoff section only)

Do not change the schema, validator semantics, synthetic fixture, Worker/web code, source or model integrations, database, public API, dependencies, credentials, cloud services, or deployment configuration. Do not acquire, copy, or retain real source material. Perry Tjahya and Jesaya Hamonangan Gaudensius Malau remain the identified future independent reviewers; no labels exist yet and source/data rights remain pending.

## Acceptance and verification

- The package command invokes the same tested entry point as direct local CLI use.
- Tests show the synthetic fixture is structurally valid but never metadata-ready; invalid data and file/usage errors are bounded and redacted.
- The result contains no raw input values or path, and the command makes no network or write calls.
- In WSL Ubuntu-26.04 with installed dependencies, record Node/npm versions and run focused CLI tests, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`.
- Smoke-run the synthetic fixture and verify exit code `1`, `valid: true`, and `metadata_ready: false`; report the expected nonzero status accurately.
- Work only in the assigned branch/worktree. Commit implementation/tests and the completed handoff separately with descriptive messages; leave the worktree clean. Do not merge or push. Root independently reviews the branch and evidence before acceptance.

## Stop conditions

Stop and report to root if this command would require a schema or public contract change, a dependency, network/source access, source content, real reviewer or rights metadata, or a cloud resource. Do not invent such inputs to make a smoke test appear ready. Escalate only if a GPT-6 Luna/max attempt documents a substantive unresolved technical problem.

## Implementation handoff

**Branch:** `work/EVAL-01-CASEBOOK-CLI-CORE`

**Worktree:** `D:\Projects\RPL\.codex-build\worktrees\eval-01-casebook-cli-core`

**Assigned base:** `bdc850de9a01dcfc607a9f71a0d40e42d883068d`

**Implementation commit:** `81fa414b46c0d67a263beeb373f2a9824473afa1` — `feat(EVAL-01): add bounded casebook CLI`

**Handoff commit message:** `docs(EVAL-01): record casebook CLI handoff`

**Changed paths:** `tools/evaluation/casebook-cli.ts`, `tools/evaluation/casebook-cli.test.ts`, `tools/evaluation/tsconfig.json`, root `package.json`, `docs/evaluation/CASEBOOK.md`, and this handoff section.

**Behavior:** The `npm run eval:casebook -- <path>` command accepts one absolute or working-directory-relative local JSON file, bounds the read to 5 MiB, and calls the existing `validateCasebook` and `evaluateReleaseReadiness` functions. Its result contains only `valid`, `metadata_ready`, `issue_codes`, and `readiness_reasons`. Usage, read, size, UTF-8, JSON, and unexpected failures use fixed stderr error codes without path, input, or exception details. Invalid metadata returns the redacted result with exit status 2; valid but not-ready metadata returns status 1; status 0 is reserved for metadata that passes the existing readiness checks.

**Checks:** WSL Ubuntu-26.04, Node v24.21.0 and npm v11.19.0; existing `tsx` 4.23.15, TypeScript 7.0.2, and `@types/node` 24.13.6. No dependency installation or version change.

- Focused CLI tests: 7/7 passed.
- `npm test`: passed, including web 60, Worker 431, DB 41/41 files, and evaluation 19/19 tests.
- `npm run typecheck`: passed.
- `npm run build`: passed; Vite production build and Wrangler dry-run completed.
- `npm run eval:casebook -- docs/evaluation/fixtures/synthetic-casebook.json`: expected exit status 1; output had `valid: true`, `metadata_ready: false`, and readiness reason codes.
- `git diff --check bdc850de9a01dcfc607a9f71a0d40e42d883068d..HEAD`: passed for the implementation commit. The final assigned-base diff check will be rerun after this handoff commit.

**Limitations:** The CLI checks only declared metadata; it cannot establish external rights, reviewer identity, that reviews or adjudication occurred, label quality, independence, or freeze governance. Only the checked-in synthetic fixture and temporary authored metadata were used. No metadata-ready casebook was constructed or smoke-run because that would require invented rights or human-review assertions; the status-0 mapping is tested from closed boolean result states only. The synthetic fixture remains valid but not-ready. Source/data rights and real human labels remain pending.

**Migration/configuration impact:** No database migration, runtime configuration, dependency, API, Worker, or web behavior changed. The root package gained only the CLI/test scripts; the evaluation TypeScript include list and casebook local-use documentation were updated.

**Remaining decisions:** No implementation contract decision remains. EVAL-01 source/data rights and independent human review are still separate pending gates. Root review and acceptance remain outstanding.

Root performs independent review and acceptance.
