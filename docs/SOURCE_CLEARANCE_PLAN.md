# Waspada Jakarta — Source Reuse and Retention Clearance Gate

**Status:** Prepared for Team 12 review. No source owner has been contacted, no request has been sent, and no source is approved for automated collection or durable content processing.
**Reviewed:** 8 October 2026
**Related:** [Source feasibility and retention](SOURCE_FEASIBILITY.md), [permission request drafts](SOURCE_PERMISSION_REQUESTS.md), [source verification plan](../SOURCE_VERIFICATION_PLAN.md), and [ADR-005](decisions/ADR-005-source-retention.md).

## Purpose

This gate turns published source terms into an auditable decision before Waspada acquires or retains real incident content. An endpoint being public, an RSS feed being readable, or a catalog row being marked `Terbuka` does not by itself permit automated intake, model processing, public redistribution, or long-term storage. Unknown or conflicting terms mean the relevant connector stays disabled and the demo continues to use clearly labelled synthetic fixtures.

The 8 October review checked first-party terms, API/RSS documentation, and catalog metadata. It did not fetch incident reports or dataset exports, contact a publisher, determine legal status, or enable a connector. The source-specific findings and links are recorded in [SPEC-01](SOURCE_FEASIBILITY.md) and [REFERENCES.md](../REFERENCES.md).

## Clearance order

Use this order to obtain a small, diverse set of sources for the independent EVAL-01 casebook. Approval for one publisher or use case does not transfer to another source.

| Priority | Candidate | Useful scope | Current gate and request |
| --- | --- | --- | --- |
| 1 | **BMKG nowcast API/CAP** | Official weather warnings with issuer, affected area, publication and explicit validity fields. A useful, bounded first integration candidate, but it will not cover the full incident casebook. | Request written permission for the exact official API, public third-party display, request interval, required complete alert presentation/attribution, permitted fields, model transfer, retention, and correction/cancellation handling. The terms prohibit scraping the public-service interface and require official API access for automated access. |
| 2 | **PetaBencana Jakarta reports** | Timestamped community observations and documented geometry for flooding and other reported hazards. | Obtain written clarification of which license governs the current API and user-contributed material: the current user agreement states CC BY-NC 4.0 for non-commercial use, while the organization's licensing file states CC BY 4.0 for collected data. Also ask about automated API access, rate limits, public display, model transfer/embeddings, retention, and deletion. Keep intake and content retention off while the conflict remains unresolved. |
| 3 | **ANTARA Metro and Metro Kriminalitas** | Independent reporting candidates for crime, demonstrations, and public disruptions. | Obtain written consent for Waspada's intended RSS discovery, article retrieval, extraction/model processing, public summaries/excerpts, storage, and attribution. RSS documentation describes syndicated summaries and links, but the terms restrict other reproduction, public communication, and distribution without ANTARA's written consent. |
| 4 | **Satu Data Jakarta crime dataset** | Potential historical aggregate context; it may not describe event-level incidents. | Ask the dataset steward for the exact current file/API, schema, time and geographic granularity, data definition, license, attribution, API limits, retention, redistribution, and model-processing terms. `Terbuka` is not a dataset-specific license. Do not use aggregate records as evidence of an individual crime or current danger. |
| 5 | **Korlantas traffic feed** | Candidate discovery for road restrictions and traffic incidents. | Ask for RSS/article reuse, polling, attribution, excerpt, AI-processing, retention, and correction terms. The accessible feed and robots file do not establish a reuse license. Keep automated retrieval off pending a recorded permission basis. |
| Later | **Transit operators, public-order notices, and other issuers** | Service changes, demonstrations, campus notices, and other category-specific facts. | The source verification plan identifies candidate publishers, but their terms have not been cleared as a group. Review the exact publisher and channel before each source is approved. Public social posts remain manual discovery leads only; no automated social collection is planned. |

## Questions every permission record must answer

Record a separate answer for each source and exact endpoint or publication channel:

1. **Who and what:** accountable publisher, source remit, exact URL/API/account, approved access method, fields, and geographic/time coverage.
2. **Collection:** whether automated requests are permitted, required credentials/User-Agent, rate and interval limits, redirect rules, and any fees. The project has no budget for a paid source or paid processing fallback.
3. **Transformation and model use:** whether text can be extracted, summarized, embedded, or temporarily sent to a third-party inference provider; whether the provider or processing region is restricted; whether any training/fine-tuning is allowed. A model provider has not been selected.
4. **Display and attribution:** whether Waspada may display original titles, short excerpts, derived summaries, source links, source timestamps, logos, or source geometry; required attribution wording and placement; whether an alert must be displayed in full.
5. **Retention and deletion:** permitted storage duration for raw payloads, excerpts, metadata, derived claims, embeddings, caches, backups, and evaluation copies; treatment of corrections, retractions, license termination, privacy requests, and backup deletion replay.
6. **Rights scope:** whether permission covers a publicly reachable, no-fee academic demonstration hosted on Cloudflare Workers Free and Neon Free. Hosting on a free tier does not itself settle whether the use qualifies as non-commercial.
7. **Decision record:** exact terms/permission URL or retained written reply, date reviewed, expiry/review date, allowed use, denied use, open conditions, reviewer, and source-registry status.

An answer covering access alone is insufficient. A source can be approved for discovery while article-body retrieval, model processing, public display, or archival storage remains disabled. In that case the source registry must express those narrower permissions and the pipeline must enforce them.

## Retention baseline to ask publishers to accept or replace

The proposed engineering defaults in ADR-005 are subordinate to source-specific terms, privacy duties, and deletion requests:

- No durable raw HTML/XML/PDF/image copy by default. If expressly permitted for parsing, delete within 24 hours; parser-failure quarantine is at most 7 days.
- Keep permitted excerpts/extracted text only while the linked event version is current, plus at most 90 days afterward and never beyond 365 days from fetch.
- Expire embeddings, chunks, summaries, and caches with the text they derive from. On deletion, retraction, or source revocation, stop serving dependent material immediately and purge active indexes/caches within 24 hours where the source's terms allow retention in the first place.
- Keep minimal non-content provenance and audit metadata for at most 24 months, only where allowed.
- A 30-day encrypted off-provider backup remains an unimplemented target. Neon Free alone does not satisfy it. Until a no-cost backup/export and deletion-replay process is tested, use synthetic/historical data only and do not enable live-source persistence.

If a source requires shorter retention, that source-specific limit wins. If source terms do not permit a required model transfer, retain no text/vector for that path and do not send it to the model. Do not treat a hash or embedding as automatically free of source restrictions.

## Team workflow and exit criteria

1. Team 12 chooses a source and confirms the draft describes the real public demo, storage, and model flow. Fill in the sender's official team/university contact and supervisor details in [the draft requests](SOURCE_PERMISSION_REQUESTS.md); verify the recipient through the publisher's first-party site.
2. A team member sends the request outside this repository and preserves the original response or links to the exact published terms. The drafts are not permission and have not been sent by the project planner.
3. Review the reply against every question above. Record an explicit `approved`, `approved_with_limits`, `rejected`, or `pending` decision in a source-specific registry record; attach the terms, scope, allowed fields, attribution, access limits, retention, model-processing rule, deletion process, and review date.
4. Update the source feasibility matrix and, if the accepted architecture/policy changes, its ADR. Implement only the allowed path; add tests that prove denied fields, retention, model transfer, and source status are enforced. Do not activate a connector merely because a permission email arrived if material terms remain unanswered.
5. Separately build EVAL-01 from at least 40 rights-cleared reports across at least 12 incidents, with at least three reports per case. Perry Tjahya and Jesaya Hamonangan Gaudensius Malau remain the two independent reviewers identified by Team 12. Synthetic data does not count toward this casebook.

The clearance gate is complete for a connector only when its permission basis and operational limits are recorded and enforced. The evaluation gate is complete only when the casebook is rights-cleared, independently labeled, split by incident, and accepted under EVAL-01. Neither gate grants permission for another source, source class, deployment use, or model provider.

## Current decision

**No live source is cleared.** Use synthetic fixtures for demos and tests. BMKG is the recommended first written request because its official CAP interface is narrow and documented; PetaBencana should follow to resolve its license conflict. ANTARA, Satu Data, and Korlantas requests remain source-specific. No requests have been sent and this plan does not authorize contacting source owners on behalf of Team 12.
