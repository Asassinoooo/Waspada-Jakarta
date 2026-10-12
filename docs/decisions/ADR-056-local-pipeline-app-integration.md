# ADR-056 — Local pipeline integration into the development app

Status: implementation assigned12 October2026. Owner: Team12.

The accepted pipeline has durable local evidence/proposals but the existing app cannot inspect them. Integrate through a separate Node loopback service that owns one disposable synthetic PGlite instance and exposes only a bounded read-only local DTO. Vite proxies that path during development. A demo/development-only view shows versioned source evidence, job states and private model proposals. Public Worker routes, map geometry, Layer4 publication and hosted schemas stay unchanged. This is a local system integration, not a production private moderation/authentication API.

The service can run finite mock polling concurrently with reads; real gateway state is inspection-only. Real model processing remains an explicit once/resume CLI command, at most three provider requests and existing25/26-second bounds. The diagnostic's extraction output-limit omission may be explicitly selected and becomes part of the state profile identity; it does not disable production deadlines or12,000-token application validation. Do not reinterpret one6.499-second diagnostic as proof of model quality or permanent upstream reliability.

Loopback binding, fixed Host/Origin validation, no permissive CORS, closed DTO validation, synthetic namespace/source ownership and no-store responses protect the local surface. They do not replace hosted authentication. Source/claim text is escaped data; raw errors, secrets, URLs, vectors, arbitrary JSON and lease tokens are excluded. Invalid stored lineage fails closed. Latest20 snapshot versions have an explicit truncation flag; database totals are distinguished from visible rows.

No live source is activated until access, retention and model-transfer terms are documented. No public event or moderator mutation occurs. Hosted Cloudflare/Neon transport, access controls, source quality, scalable retrieval, L3 dispatch and publication are later tasks under existing stable backlog IDs.
