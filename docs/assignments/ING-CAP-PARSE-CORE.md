# ING-CAP-PARSE-CORE — bounded Common Alerting Protocol 1.2 fixture parser

- **Status:** Accepted on `main` at root handoff commit `0cfca1a`; root review and WSL verification recorded in [delivery log](../DELIVERY_LOG.md)
- **Backlog ID:** `ING-CAP-PARSE-CORE`
- **Objective:** Add a deterministic Layer 1 parser for CAP 1.2 messages using authored synthetic XML only. Preserve source-described facts and time fields while keeping retrieval time separate. This is parser groundwork, not a collector, source approval, verification result, or publication path.
- **Dependencies:** `SPEC-01`, `DATA-01`, `ING-PARSE-01`.
- **Requirements:** `FR-02/03/04/09/10/15`; `NFR-01/07`.
- **Contract boundary:** New internal Worker parser types only. Do not change database/domain schemas, public API/OpenAPI contracts, model contracts, or event publication behavior.
- **Implementation model:** GPT-6 Luna, max reasoning.
- **Branch/worktree:** `work/ING-CAP-PARSE-CORE` in the reused, clean managed worktree `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL`, based on pushed `main` after this assignment commit. The prior fixture-runner task is complete; do not edit through the root checkout.
- **XML parser:** Use `saxes@6.0.0` as a direct Worker dependency for strict namespace-aware SAX parsing; update the lockfile. Reject every `DOCTYPE`; permit only standard predefined/numeric XML entities; never resolve external entities. Do not implement XML parsing with regular expressions.
- **CAP reference:** [OASIS Common Alerting Protocol Version 1.2](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html); the source register already records this standard. The CAP standard describes alert/update/cancel linkage, multiple `info` and `area` blocks, offset-qualified times, WGS 84 coordinates in latitude/longitude order, and closed polygons.

## Read before implementation

- `SOFTWARE_DEVELOPMENT_PLAN.md` — Layer 1, requirements, delivery gates and WSL workflow.
- `docs/IMPLEMENTATION_BACKLOG.md` — `ING-CAP-PARSE-CORE`, `ING-PARSE-01`, `ING-01` and `EVAL-01`.
- `docs/SOURCE_FEASIBILITY.md` and `SOURCE_VERIFICATION_PLAN.md` — BMKG access and rights gates; no CAP detail or provider field mapping has been verified.
- `ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, and `apps/db/src/ports.ts` — layer boundaries and timestamp/geometry semantics.
- `docs/assignments/ING-PARSE-01.md` and its handoff — existing pure-parser conventions.
- OASIS CAP 1.2, linked above; `REFERENCES.md` for the maintained local source register.

## Required behavior

1. Add `apps/worker/src/layers/l1-data-knowledge/bmkg-cap.ts` and `apps/worker/test/bmkg-cap.test.ts`. The parser accepts already-buffered XML text plus a caller-supplied retrieval timestamp. It performs no fetch, file/database access, model call, geocoding, scheduler action, or persistence.
2. Enforce UTF-8 input-byte, element-count, depth, text, info/area, and coordinate limits before producing a result. Return bounded error codes only; never include XML, field content, parser messages, filesystem paths, or source text in errors/logs. Malformed or over-limit messages return no partial alert.
3. Require a single `alert` root in the exact CAP 1.2 namespace. Accept default and prefixed namespace forms; only use fields in the CAP namespace. Ignore bounded extension namespaces without interpreting their text, and do not claim to verify XML signatures.
4. Validate and preserve `identifier`, `sender`, `sent`, `status`, `msgType`, `scope`, and optional `references`/`incidents`. Keep CAP message status (`Actual`, `Exercise`, `System`, `Test`, `Draft`), message type (`Alert`, `Update`, `Cancel`, `Ack`, `Error`), and scope (`Public`, `Restricted`, `Private`) distinct; none alone constitutes source approval or an active event.
5. Preserve zero or more `info` blocks and their language, category values, event text, urgency, severity, certainty, and optional headline/description/instruction/web fields covered by the parser contract. CAP category codes remain source codes; do not map them to Waspada categories or infer claims.
6. Preserve `sent`, `effective`, `onset`, and `expires` independently, validating CAP offset-qualified date-time syntax and calendar values. Attach caller `retrievedAt` separately. Do not substitute one timestamp for another, infer event time, or derive freshness/lifecycle from timestamps. A cancellation or update remains a source message; do not apply it to prior records.
7. Preserve area descriptions, geocodes, and source circle strings as source fields without geocoding or creating map buffers. Validate CAP polygons as source-supported WGS 84 latitude/longitude pairs, with at least four pairs, a closed ring, finite bounds, and configured coordinate limits; convert only the pair ordering to CRS84 `[longitude, latitude]`. Never invent a point, boundary, radius, or Jakarta location.
8. Use fixtures authored for this parser and visibly named synthetic. Do not copy OASIS examples or fetch/copy BMKG samples. Tests must cover default/prefixed namespaces, multiple/language-specific info and areas, Alert/Update/Cancel linkage, valid/invalid CAP dates, time distinction, polygon axis order/closure/bounds, empty-info system messages, malformed XML, wrong namespaces, duplicate required fields, DTD/XXE/entity expansion, and all configured bounds.
9. Document that parsing establishes syntax and field extraction only. It does not establish who issued the message, truth, rights to retain/display it, whether it concerns Jakarta, warning freshness, current danger, or signature authenticity. The BMKG connector remains disabled until the source registry and rights gates are satisfied.

## Allowed paths

- `apps/worker/src/layers/l1-data-knowledge/bmkg-cap.ts`
- `apps/worker/test/bmkg-cap.test.ts`
- `apps/worker/package.json` and root `package-lock.json` (only for `saxes@6.0.0` and test discovery)
- `docs/assignments/ING-CAP-PARSE-CORE.md` (implementation handoff only)
- `REFERENCES.md` (add the XML parser package reference if the existing local register does not contain it)

No other paths are in scope. No model, provider, source, credential, live data, HTTP client, queue integration, migration, role/grant, public contract, API route, or deployment change is authorized.

## Verification and handoff

Run all project checks from this task worktree in WSL Ubuntu-26.04 with the native Linux Node.js runtime from `docs/BOOTSTRAP.md`; record actual Node, npm, parser, TypeScript, Vite and Wrangler versions. Install only the declared parser dependency and reuse the existing package cache where possible. Run the focused CAP tests, `npm test --workspace=@waspada/worker`, full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. No browser, network source, or deployment test is needed.

Commit implementation and the handoff on the assigned branch with coherent descriptive messages; do not merge or push. Record branch/worktree, commit SHAs/messages, paths, actual check results, limitations, dependency impact, and remaining decisions. Root independently reviews and integrates accepted work.

Stop and report if the XML parser cannot enforce the exact namespace, hard resource bounds, or DOCTYPE rejection without a broader schema/runtime change. Continue by proposing a parser design correction; do not activate the source or silently weaken the parser. Escalate to GPT-6 Astra xhigh only after a Luna/max implementation attempt leaves a substantive technical issue unresolved.

## Implementation handoff

Append the implementer's exact handoff here after committing the completed work package.

### Implementer handoff — 2026-09-27

- **Branch/worktree:** `work/ING-CAP-PARSE-CORE`, `C:\Users\perry\.codex\worktrees\l1-fixture-runner-core\RPL` (WSL: `/mnt/c/Users/perry/.codex/worktrees/l1-fixture-runner-core/RPL`), based on `568f7248f1fc1e2db8089f38be6b993a11a2b1c1`.
- **Implementation commits:** `cd110bfa0a3b56f9dbbfe961dc1b7122809ed038` — `feat(ingest): add bounded CAP 1.2 parser`; `1277466c95136c0f5a42e21afee6a9629fc76cf3` — `fix(ingest): align CAP identifiers and bound retrieval time`.
- **Changed paths:** `apps/worker/src/layers/l1-data-knowledge/bmkg-cap.ts`, `apps/worker/test/bmkg-cap.test.ts`, `apps/worker/package.json`, and `package-lock.json`. This handoff is the only additional path changed.
- **Behavior:** Added pure parsing of already-buffered XML in the exact CAP 1.2 namespace with `saxes@6.0.0`. It preserves CAP status, message type, scope, linkage, multilingual info and source-described area fields; keeps `sent`, `effective`, `onset`, `expires`, and caller `retrievedAt` separate; validates only source-provided polygons and reorders their coordinate pairs to CRS84. It rejects all DOCTYPE declarations, does not resolve external entities, applies configured bounds (including 64 characters for caller `retrievedAt`), returns fixed redacted errors, and never returns partial output. CAP identifiers allow `>` while still rejecting whitespace, comma, `<`, and `&`.
- **Synthetic tests:** 15 focused CAP tests pass. Fixtures are authored and labeled synthetic; they contain no copied OASIS or BMKG sample content.
- **Checks:** In WSL Ubuntu-26.04 using the native Linux runtime, `npx --no-install tsx --test apps/worker/test/bmkg-cap.test.ts` passed 15/15; `npm test --workspace=@waspada/worker` passed 282/282; full `npm test` exited 0, including 20/20 database test files and 12/12 evaluation casebook tests; `npm run typecheck` exited 0; `npm run build` exited 0 (Vite production build and Wrangler dry-run); and `git diff --check` exited 0.
- **Versions:** Node.js `v24.21.0`; npm `11.19.0`; `saxes` `6.0.0`; TypeScript `7.0.2`; Vite `8.3.0`; Wrangler `4.137.0`.
- **Limitations and decisions remaining:** Parsing establishes syntax and field extraction only. It does not establish issuer identity, source rights, truth, Jakarta relevance, freshness, current danger, or signature authenticity. No BMKG field mapping or source activation is established; the connector remains disabled pending source registry and rights gates. Missing `xml:lang` stays `null`; missing CAP times stay `null`; no time or geometry is inferred. Root review and integration remain outstanding.
- **Dependency/configuration impact:** Added the exact `saxes@6.0.0` direct Worker dependency and lockfile entries, and registered the Worker test file. No database/domain schema, migration, public API, model/provider, deployment, or runtime-binding configuration changed.
