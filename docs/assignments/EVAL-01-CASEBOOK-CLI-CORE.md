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

The implementer records branch/worktree and base, commit SHAs and exact messages, changed paths, behavior, actual checks/results, limitations, migration/configuration impact, and remaining decisions here. Root performs independent review and acceptance.
