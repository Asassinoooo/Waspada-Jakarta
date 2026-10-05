# DATA-02-LOCATION-CANDIDATE-CORE handoff

- **Branch:** `work/DATA-02-LOCATION-CANDIDATE-CORE`
- **Worktree:** `.codex-build/worktrees/data-02-location-candidate-core` (`/mnt/d/Projects/RPL/.codex-build/worktrees/data-02-location-candidate-core` in WSL)
- **Assigned base:** `4cefc063db68d0d9092761676cff713a98538b66`
- **Implementation commits:**
  - `185fad662f0ecb4761d4dc3b080569f1cffb827c` — `feat(DATA-02-LOCATION-CANDIDATE-CORE): add bounded gazetteer matcher`
  - `0c03c1a4e9981ad7026e11a6d361371b6dee6e31` — `test(DATA-02-LOCATION-CANDIDATE-CORE): keep gazetteer fixtures synthetic`
  - `7aa6276e1aa3bc4ba63cc6e9533582cba38178a5` — `fix(DATA-02-LOCATION-CANDIDATE-CORE): normalize aliases with NFKC`
- **Changed paths:** `apps/worker/src/layers/l1-data-knowledge/location-candidates.ts`; `apps/worker/test/location-candidates.test.ts`; this handoff.

## Behavior

The new pure Layer 1 matcher accepts an already prepared text record and an explicitly supplied, versioned, dataset-scoped snapshot of place IDs and aliases. It validates the text identity, exact SHA-256, existing normalization version, dataset agreement, snapshot fields, Unicode, and configured bounds. It uses a trie to find case-insensitive complete-token phrases and returns zero-based, end-exclusive Unicode code-point spans into the exact supplied text. Punctuation separates tokens. Ambiguous aliases return all distinct place IDs in stable order, and nested/overlapping phrases remain separate. Results sort deterministically by span and place IDs.

To match the existing prepared-text NFKC policy without changing the source text or span positions, aliases are NFKC-normalized before case canonicalization and tokenization. Case matching uses locale-independent lowercasing with Greek final-sigma equivalence.

The matcher caps prepared text at 200,000 code points; snapshots at 500 places, 10,000 aliases, and 20,000 aggregate alias tokens; aliases at 256 code points and 16 tokens; and output at 512 unique spans and 4,096 place/span links. Invalid input yields stable fixed error codes. Exceeding an output bound returns an unavailable result with no partial/truncated candidates. An unmatched text returns an empty candidate result and makes no claim about location coverage or safety. Returned data is limited to dataset/revision/hash/normalization and snapshot identity, spans, offset unit, and place IDs.

Ten focused synthetic tests cover token boundaries, phrases and punctuation, Unicode/case behavior and code-point spans, nested and ambiguous matches, stable ordering, unmatched text, no source-text leakage, immutable inputs, malformed/cross-dataset inputs, hash/version and surrogate validation, all input limits, both output limits, and fail-closed behavior. The fixtures use invented names only, including a compatibility-ligature alias regression test. The matcher does not select a location, validate it, geocode, create coordinates or geometry, persist, access a live gazetteer, or change any public or database contract.

## Verification

Checks ran in WSL Ubuntu-26.04 with the existing dependency tree. At implementation start the recorded versions were Node `v24.21.0`, npm `11.19.0`, tsx `4.23.15`, TypeScript `7.0.2`, Wrangler `4.137.0`, Saxes `6.0.0`, Vite `8.3.0`, and PGlite `0.5.8`.

- Direct focused test, `tsx --test test/location-candidates.test.ts`: 10/10 passed after the NFKC change.
- `npm run typecheck`: passed after the NFKC change.
- `npm run build`: passed after the NFKC change (production Vite build and Wrangler dry-run; no deployment).
- First `npm test` execution exited 0 and its captured full log reports all included Worker/DB/repository suites passing. This run was started before the NFKC fix and is retained at `/tmp/data02-location-npm-test.log`; it is intermediate evidence only.
- Final-state `npm test` rerun: exited 0; every listed Worker, DB, repository, and synthetic contract test passed. Captured at `/tmp/data02-location-npm-test-final.log`.
- `git diff --check 4cefc063db68d0d9092761676cff713a98538b66..HEAD`: passed after all commits, including this handoff.

## Limits and impact

The matcher consumes only a caller-supplied snapshot and establishes phrase-to-ID candidates, not that an alias is authoritative or a candidate is the incident location. Source-specific gazetteer selection and data rights remain gated. No schema, API, manifest, lockfile, dependency, migration, configuration, persistence, or deployment change was made. There is no migration or configuration action. No source-specific decisions are introduced; separate evidence-backed policy must validate any later location use. Root review and acceptance remain pending.
