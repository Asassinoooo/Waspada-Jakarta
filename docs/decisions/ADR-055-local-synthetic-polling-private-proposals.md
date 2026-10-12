# ADR-055 — Local synthetic polling and private proposals

Accepted design and local synthetic implementation, 12 October 2026. Root pipeline27/27, regression suites, typecheck, build/dry-run and UI/API smoke pass; exact evidence/initial WASM test-run failure and remaining bounds are in [the local guide](../LOCAL_PRIVATE_PIPELINE.md).

Collection reads one authored, bounded JSON API fixture. A report's stable ID and canonical content hash identify changes against its current head; a monotonic version distinguishes A→B→A. First-capture time and immutable snapshot bind each source-poll job to its original content. An atomic inbox/queue write precedes processing. No HTTP source is activated.

L1 persists normalized/redacted text, unreviewed revision, context evidence and chunks before any model call. Completion atomically enqueues a separate local AI job. Extraction, embedding, retrieval/grounding and private proposal generation operate in that job; AI failures cannot hold the collection queue or change source health. Canonical domain repositories are reused; the inbox and AI job tables are local-tool bootstrap DDL, outside hosted migrations. The database has an explicit synthetic namespace and model-profile ownership marker.

Each AI stage uses an immutable validated receipt and lease-fenced SQL transaction for associated canonical writes. Model calls never hold a database transaction. Failed calls count toward the existing five-attempt policy; retry backoff and terminal failure retain L1 evidence. A timed-out model result cannot perform later writes. Receipt-before-ack replay avoids repeated committed stages, but cannot guarantee exactly-once calls when a process dies before recording a model result.

One authored source has unknown independence. Retrieval of the exact synthetic candidate is a private composition proof, not factual verification, quality evaluation or publication eligibility. Insufficient context stops without L3. L4, public events, moderator mutations and Worker/Cloudflare scheduling remain disconnected. Local scheduling is opt-in and collection runs independently of an outstanding AI call.

Routine models are deterministic doubles. Real 9router use is separately opt-in, synthetic-only, one-report/one-cycle, at most three adapter requests, with a pinned nonsecret curation epoch and isolated state. Prior extraction timeouts remain unresolved; enabling this local path does not establish real-source permissions, model quality, hosted concurrency or a complete live pipeline.
