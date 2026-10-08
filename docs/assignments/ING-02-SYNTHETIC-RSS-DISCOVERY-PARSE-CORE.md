# ING-02-SYNTHETIC-RSS-DISCOVERY-PARSE-CORE — bounded RSS discovery metadata parser

- **Status:** Assigned for local synthetic implementation; no live source is authorized.
- **Backlog ID:** `ING-02-SYNTHETIC-RSS-DISCOVERY-PARSE-CORE`
- **Parent:** ING-02; FR-02/03/12; NFR-01/07
- **Dependencies:** SPEC-01, ING-PARSE-01, ING-CAP-PARSE-CORE, existing `saxes@6.0.0` Worker dependency.
- **Contracts:** Internal Layer 1 parser result only. No persisted/domain/model/public API/OpenAPI changes.
- **Branch/worktree:** Create `work/ING-02-SYNTHETIC-RSS-DISCOVERY-PARSE-CORE` in its own worktree under `.codex-build/worktrees/ing-02-synthetic-rss-discovery-parse-core`, based on pushed `main` after this assignment commit. Do not edit through the root checkout.
- **Model:** GPT-6 Luna, max reasoning.

## Objective

Add a pure, resource-bounded parser for caller-buffered, authored synthetic RSS 2.0 XML. It returns only discovery metadata needed for a later, separately authorized acquisition step: bounded title, opaque link/GUID text, raw source publication-date text, and caller-supplied retrieval time. It must not return an item description or article body. An RSS link is untrusted data and `pubDate` is not event/observation time.

This parser is groundwork for ING-02 only. It does not make ANTARA, Korlantas, or any feed an approved source, and it does not allow real feed content in fixtures.

## Read first

- `AGENTS.md`
- `SOFTWARE_DEVELOPMENT_PLAN.md`
- `docs/IMPLEMENTATION_BACKLOG.md` — ING-02 and source gates
- `docs/SOURCE_CLEARANCE_PLAN.md`
- `docs/SOURCE_FEASIBILITY.md`
- `docs/assignments/ING-PARSE-01.md`
- `docs/assignments/ING-CAP-PARSE-CORE.md`
- `apps/worker/src/layers/l1-data-knowledge/bmkg-cap.ts`
- `apps/worker/package.json`

## Required behavior

1. Add a pure parser in `apps/worker/src/layers/l1-data-knowledge/rss-discovery.ts` and authored synthetic tests in `apps/worker/test/rss-discovery.test.ts`.
2. Accept only a bounded RSS 2.0 document rooted in `<rss version="2.0">` with the expected channel/item structure. Reject malformed XML and unsupported root formats with closed error codes; do not return partial items after a parse failure.
3. Enforce explicit UTF-8 byte, element-count, nesting-depth, text-size, item-count, and per-field limits before returning output. Use the existing `saxes@6.0.0` parser; reject every DOCTYPE and do not resolve external entities. Do not parse XML with regular expressions.
4. Extract only bounded item title, link, GUID and raw `pubDate` text, plus the caller's retrieval timestamp. Preserve the source date string without parsing it as incident time. Omit `description`, `content:encoded`, images, enclosures, and extension bodies from output.
5. Ignore unknown extension namespaces without interpreting their text. Reject duplicate known fields where ambiguity could change the extracted value. Treat links and all text as untrusted input; do not fetch, normalize into an approved host, or follow them.
6. Return bounded error codes only. Do not expose source text, field values, parser messages, stack traces, or paths in errors or logs.
7. Use only authored, clearly synthetic XML fixtures. Cover valid and empty feeds, multiple items, CDATA, malformed/wrong-root XML, duplicate/over-limit fields, unknown extensions, DOCTYPE/XXE/entity expansion, and all configured resource limits.
8. Keep source activation, acquisition, retention, AI processing and public display disabled. Record in comments/tests that parser correctness does not grant reuse rights, verify an issuer, prove an event, or establish freshness.

## Allowed paths

- `apps/worker/src/layers/l1-data-knowledge/rss-discovery.ts` (new)
- `apps/worker/test/rss-discovery.test.ts` (new)
- `apps/worker/package.json` (register the test only)
- `docs/assignments/ING-02-SYNTHETIC-RSS-DISCOVERY-PARSE-CORE.md` (handoff section only)

Do not change package versions or lockfiles, source registries/permissions, fixtures from real feeds, L1 persistence, queue/runtime wiring, models, database, APIs, route configuration, deployment, or any other path. No network request, source contact, credential, or external service is authorized.

## Acceptance and verification

- The parser is deterministic, bounded and fails closed; its output cannot contain article bodies or extension payloads.
- Synthetic tests cover every required behavior and do not copy ANTARA, Korlantas, or other live content.
- Run in WSL Ubuntu-26.04 with existing dependencies: focused parser test, `npm test --workspace=@waspada/worker`, `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check <assigned-base>..HEAD`. Record actual runtime/package versions and results.
- Commit implementation and handoff on the task branch in coherent commits. Do not push or merge. Root independently reviews and integrates accepted work.

Stop and report if the existing XML parser cannot enforce the required namespace/structure and bounds without a new dependency or broader contract change. Do not weaken limits or use live content. Escalate to GPT-6 Astra xhigh only after a Luna/max attempt leaves a substantive technical issue unresolved.

## Implementer handoff

### Handoff

- **Branch/worktree:** `work/ING-02-SYNTHETIC-RSS-DISCOVERY-PARSE-CORE` — `D:\Projects\RPL\.codex-build\worktrees\ing-02-synthetic-rss-discovery-parse-core`
- **Base:** `3b6f9b15834047775054154f0454521a48b94ea3` (`docs(plan): assign three local integration slices`)
- **Implementation commit:** `b97ee43` — `feat(ING-02): add synthetic RSS discovery parser`
- **Implementation paths:** `apps/worker/src/layers/l1-data-knowledge/rss-discovery.ts`, `apps/worker/test/rss-discovery.test.ts`, and test registration only in `apps/worker/package.json`.
- **Behavior:** SAX parsing of buffered, unnamespaced RSS 2.0 with a required channel; fixed byte/element/depth/text/item/field/time bounds; DOCTYPE rejection; closed redacted errors; no partial output. Output includes only item title, opaque link/GUID, raw `pubDate` text and caller retrieval time. Unknown namespaces and non-discovery bodies are omitted. No fetch, persistence, source approval or activation was added.
- **Verification (WSL Ubuntu-26.04):** focused RSS tests pass (13/13); `npm test --workspace=@waspada/worker` passes (464/464); root `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check 3b6f9b15834047775054154f0454521a48b94ea3..HEAD` pass. Runtime/tool versions: Node `24.21.0`, npm `11.19.0`, `saxes` `6.0.0`, `tsx` `4.23.15`, TypeScript `7.0.2`, Wrangler `4.137.0`, Vite `8.3.0`. The build ran Wrangler dry-run only. No dependency was installed or version changed; a temporary worktree link to the existing dependency directory was removed after checks.
- **Impact and limitations:** no migration, lockfile, configuration, or source registry change. This is an isolated parser core; callers, acquisition, persistence and source approval remain out of scope. Tests use authored synthetic strings only and confer no reuse rights or evidence/freshness claims.
- **Remaining decision:** root review and acceptance; no contract or source-authorization change is proposed.
