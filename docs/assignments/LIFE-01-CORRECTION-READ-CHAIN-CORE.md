# LIFE-01-CORRECTION-READ-CHAIN-CORE — verify synthetic correction propagation

**Parent package:** LIFE-01, FR-11/13
**Status:** Assigned for an isolated, test-only implementation
**Implementation model:** GPT-6 Luna, max reasoning
**Branch:** `work/LIFE-01-CORRECTION-READ-CHAIN-CORE`
**Worktree:** Supplied in the root dispatch after creation
**Base:** Exact assignment commit supplied in the root dispatch
**Contract baseline:** Existing publication command and immutable event-version records; exact-version reviewed-history metadata; update reader; `HistoryEntry` and `UpdatePage`; ADR-020, ADR-026, and ADR-028. Do not change contract versions.

## Context and constraints

The local publication writer, exact-version disclosure table, public update reader, and Layer 4 update projection have separate tests. This task composes them with authored synthetic records to verify that a correction can traverse the existing persistence and read path.

ADR-028 keeps moderator access read-only for the course demo. Do not add or enable a review-metadata write endpoint, login, session, moderator account, route, or production review action. Test setup may use the existing writer test capability and directly seed clearly labelled fictional review rows in PGlite. Such rows are contract fixtures, not human decisions, source approvals, or evidence of data rights. The publication outbox has no delivery consumer; do not claim delivery or automatic propagation beyond the reader projection.

## Dependencies

- Accepted `PUB-WRITE-CORE`, `API-PUBLIC-UPDATES-READER-CORE`, `API-PUBLIC-UPDATES-PROJECTION-CORE`, and `API-PUBLIC-UPDATES-RUNTIME-CORE`.
- [ADR-020](../decisions/ADR-020-public-event-history-disclosure.md): public change labels and summaries require exact-version review metadata; they cannot be inferred from record diffs.
- [ADR-026](../decisions/ADR-026-public-update-feed-cursor.md): update ordering uses the committed review sequence and latest-public rules.
- [ADR-028](../decisions/ADR-028-read-only-moderator-demo.md): the course demo has no moderator writes.
- The synthetic-only audit in [LIFE-01](../IMPLEMENTATION_BACKLOG.md) found no freshness scheduler, outbox consumer, or source-retraction/deletion invalidation path. Those are not in this slice.

## Objective

Extend the existing PGlite publication-writer test so it publishes two versions of one authored fictional event through the real SQL writer, seeds clearly labelled synthetic exact-version disclosure rows, and reads the resulting update candidates through the real database reader and Layer 4 `UpdatePage` service. Prove that the projected correction remains bound to version 2 and its stored publication timestamp and summary.

This is a local persistence/read-path test only. It does not implement a correction workflow, make freshness transitions, deliver outbox rows, contact a source, or establish factual quality.

## Allowed paths

- `apps/db/test/publication-writer.test.ts`
- `docs/assignments/LIFE-01-CORRECTION-READ-CHAIN-CORE-HANDOFF.md`

Do not change production code, schemas, migrations, contracts/OpenAPI, API routes, package manifests, dependencies, runtime configuration, sources, credentials, providers, deployment, or root planning documents.

## Required behavior

1. Use the existing isolated PGlite test database, checked-in migrations, and `SqlPublicationWriter`; do not mock the writer or update reader.
2. Publish version 1 and a version 2 that supersedes version 1, using unique authored fixture identities and existing version/idempotency checks. Keep the publication test's synthetic-only actor and evidence annotations.
3. Seed append-only disclosure rows only as explicit test fixtures, bound to the exact event/version pairs. The correction label and summary must be authored fixture values, never inferred from the event diff or outbox.
4. Read the committed watermark and candidates through `createPublicEventUpdatesReader`, then compose that reader with the existing Layer 4 update service using an ephemeral in-memory signing key and fixed test clock. Do not persist or log the key.
5. Assert that the response includes the exact version 1 publication and version 2 correction, with the correct event ID, version, change type, fixture summary, and `changed_at` taken from the stored publication time. Assert the closed public `HistoryEntry`/`UpdatePage` keys and that reviewer IDs, sequence numbers, SQL details, proposal data, and source/evidence details do not appear in the projection.
6. Preserve existing checks for idempotent publication, exact evidence, audit and outbox writes. Do not add an outbox consumer or imply delivery. Existing update-reader tests remain responsible for latest-withdrawn suppression; do not synthesize a withdrawal entry.
7. Add no human-adjudicated labels and make no factuality, freshness, or source-independence claim.

## Acceptance and verification

- A single focused test demonstrates `PUB-WRITE-CORE → synthetic exact-version disclosure fixtures → persisted update reader → Layer 4 UpdatePage` for one correction.
- Version 2 remains tied to `supersedes_version: 1`, and its public correction entry is tied to the exact stored version/publication timestamp.
- No changes outside the two allowed paths; the course demo remains read-only and all data is authored fictional test data.
- Run in WSL Ubuntu-26.04 using the existing installed workspace dependencies: focused `publication-writer.test.ts`, `npm run db:test`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`.
- Record actual Node, npm, Git, PGlite, tsx, TypeScript, and Wrangler versions and results. Do not report hosted Neon, Cloudflare, source, or outbox-delivery behavior as verified.

## Stop conditions and handoff

Stop if the existing writer or update views cannot express the exact version chain, if L4 projection rejects the accepted database result, or if completing the test requires production contract/schema/API changes. Report the specific boundary; do not weaken validation.

Commit on the assigned task branch in coherent descriptive commits. Do not merge or push. Keep the worktree clean. The handoff must report branch/worktree, base, commit SHA(s) and exact messages, paths, behavior, commands/results, runtime versions, limitations, migration/configuration impact, and remaining decisions. Root independently reviews, verifies, integrates, and updates task status.
