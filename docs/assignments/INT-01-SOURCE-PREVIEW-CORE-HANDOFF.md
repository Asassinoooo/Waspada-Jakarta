# INT-01 source preview core handoff

## Branch and commits

- Branch: `work/INT-01-SOURCE-PREVIEW-CORE`
- Worktree: `D:/Projects/RPL/.codex-build/worktrees/int01-source-preview`
- Implementation base: `0270af0c0b0233f467bcf680315f3df49f76a331`
- Base adjustment: the original assignment named `95c4113490cf41b920978811184fde312534d43e`; the orchestrator fast-forwarded this branch/worktree to `0270af0c0b0233f467bcf680315f3df49f76a331` before implementation so the exact `source_created_at` contract and snapshot were in place. No legacy `observed_at` compatibility was added.
- Implementation commit: `153739ee5684f7f6eba7cffbc87d16443b5cdeab` — `feat(INT-01): implement bounded source preview core`

## Changed paths and behavior

- `apps/worker/src/layers/l1-data-knowledge/source-preview-adapters.ts`: validates the committed OSM snapshot and normalizes bounded OSM and PetaBencana responses into allowlisted records. It rejects malformed, out-of-window, stale/future and contradictory records; deduplicates identical records; drops raw report fields; keeps OSM extent centres distinct from point coordinates; and preserves PetaBencana report creation time as `source_created_at` rather than physical observation time. Each upstream request has its own 25-second deadline and abort signal, including streamed body reads. Responses are limited to 1 MiB, JSON nesting and record counts are bounded, redirects and Overpass remarks/provider errors fail closed, and errors are sanitized.
- `apps/worker/src/runtime/source-preview-runtime.ts`: coalesces concurrent fetches and reuses one normalized result for five minutes without stale fallback. Expired cache references are cleared on the next snapshot or fetch access. Expiry controls reuse; absent another request, the in-memory object may remain until isolate disposal. No durable storage or background purge timer is used.
- `apps/worker/src/layers/l4-application-integration/source-preview-api.ts`: exports `createSourcePreviewHandler(options?)`; gates the route to exact demo/feature-flag values, defaults to the dated snapshot, permits only `?mode=fetch`, rejects mutations, validates the final DTO, and returns sanitized errors.
- `apps/worker/test/source-preview.test.ts`: adds 11 mocked-provider tests for the route gates, snapshot, exact source requests, privacy projection, partial failures, provider errors, date and coordinate filters, contradictory duplicates, body limits, independent deadlines, cache coalescing and stale-refresh behavior.

For unavailable providers, `fetched_at` carries the request-start timestamp for the failed attempt; it does not assert successful acquisition. The response also carries `status: unavailable` and a sanitized error code.

## Verification

Environment versions: WSL Ubuntu-26.04; Node.js `v24.21.0`; npm `11.19.0`; TypeScript `7.0.2`; tsx `4.23.15`. No dependency was installed or changed.

- `PATH="/home/perry/.nvm/versions/node/v24.21.0/bin:$PATH" node --import tsx --test apps/worker/test/source-preview.test.ts` — passed, 11/11.
- `PATH="/home/perry/.nvm/versions/node/v24.21.0/bin:$PATH" npm run typecheck --workspace=@waspada/worker` — passed.
- `git diff --cached --check 0270af0c0b0233f467bcf680315f3df49f76a331` — passed before the implementation commit.

Tests use mocked fetch responses only; no source network requests were made. The full Worker suite and Wrangler dry-run were not run because root owns route/configuration wiring and integrated verification.

## Integration and remaining work

No dependency, migration, secret, environment configuration, Worker entrypoint or test-registration changes are included. Root owns wiring the handler into the Worker route and configuration, registering the focused test in the Worker test script, reviewing the branch, and running integrated checks. Live hosted access still needs the later quota/terms review described in `docs/DEMO_DATA_INTEGRATION.md`.
