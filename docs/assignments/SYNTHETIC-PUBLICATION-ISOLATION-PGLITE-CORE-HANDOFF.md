# SYNTHETIC-PUBLICATION-ISOLATION-PGLITE-CORE handoff

## Delivery

- Branch: `work/SYNTHETIC-PUBLICATION-ISOLATION-PGLITE-CORE`
- Worktree: `/mnt/d/Projects/RPL/.codex-build/worktrees/synthetic-publication-isolation-pglite-core`
- Assigned base: `931ebef205166dd273e507ba3fe397c16309338d`
- Implementation commit: `7082fea` — `test(SYNTHETIC-PUBLICATION-ISOLATION): prove synthetic draft isolation`
- Changed paths: `apps/db/test/synthetic-publication-isolation-composition.test.ts`; this task handoff is the only other assigned path.
- Root checkout was not edited. No migration, grant, dependency, runtime, public API, OpenAPI, DTO, or production source changed.

## Behavior covered

The new PGlite composition proves the negative isolation path only. It uses one authored in-memory synthetic fixture and the existing L1 queue claim and fixture processor under `waspada_l1_pipeline`. The real L1 persistence writes one unreviewed synthetic report revision and its extraction/evidence lineage; the injected extraction capability is deterministic and local.

The test then uses the real L2 retrieval, exact Unicode code-point span reader/assembler, refs-only grounding-context persistence, direct reasoning service, and proposal bridge. Reasoning is an injected deterministic double. The persisted proposal remains in the `synthetic` dataset with no event ID and an `under_review` claim. Assertions verify that its context row contains references rather than report text and that no proposal row appears in `live`.

For L4, the existing strict SQL proposal reader returns no live proposal for that synthetic-only proposal ID. The manual gate is invoked without a moderator decision or moderator identity; it returns the existing `proposal_not_found` denial. The writer spy records zero calls. The test compares exact snapshots of the 14 publication-writer footprint tables before and after this attempt. It does not exercise a successful publication.

For the public projection, the test directly invokes the existing detail handler/runtime with an injected PGlite executor under `waspada_public_reader`. It asserts the existing 404 `NOT_FOUND` envelope for an event ID present only in the synthetic proposal context, checks that private report/context/proposal identifiers do not appear in the response, and verifies the public event view and publication snapshots remain unchanged. The `live` mode and `.invalid` connection string are test-only inputs to the existing runtime seam; no Worker route, binding, provider, network connection, or production configuration is set up. The `requestedBy` string is existing queue request metadata for this authored test job and is not passed as an L4 actor or used as an authenticated moderator identity.

## Dependencies and configuration

No dependency or configuration was added. Verification used WSL Ubuntu-26.04, Node `24.21.0`, npm `11.19.0`, PGlite `0.5.8`, `@electric-sql/pglite-postgis` `0.2.8`, `@electric-sql/pglite-pgvector` `0.0.9`, `tsx` `4.23.15`, TypeScript `7.0.2`, and Wrangler `4.137.0`. The worktree temporarily used an untracked `node_modules` symlink to the existing root dependency cache; it was removed before handoff and is not committed.

## Verification

Commands were run in WSL Ubuntu-26.04 from this worktree with the configured Node/npm runtime:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24.21.0
cd /mnt/d/Projects/RPL/.codex-build/worktrees/synthetic-publication-isolation-pglite-core
node_modules/.bin/tsx --test apps/db/test/synthetic-publication-isolation-composition.test.ts
npm run db:test
npm test
npm run typecheck
npm run build
git diff --check 931ebef205166dd273e507ba3fe397c16309338d..HEAD
```

- Focused composition: passed, 1/1 test.
- `npm run db:test`: passed, 44/44 DB test files.
- `npm test`: passed (exit 0); workspace tests, all 44/44 DB files, and 19 casebook/evaluation CLI tests completed successfully.
- `npm run typecheck`: passed for web, worker, database, and evaluation projects.
- `npm run build`: passed; Vite web build and Wrangler worker dry-run completed.
- `git diff --check` against the assigned base: run after the commits; no whitespace errors.

## Boundaries and remaining review

This is a local PGlite composition test, not evidence of a live-source right, external report authenticity, hosted Neon behavior, configured provider, authenticated reviewer, production Worker route, or successful publication. The fixture is synthetic and remains so throughout. There is no established public contract change or migration/configuration impact. Root review and integration remain outstanding; no merge or push was performed.
