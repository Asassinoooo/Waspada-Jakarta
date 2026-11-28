# ADR-065 — Hosted topology: Cloudflare Worker and Neon Free, with ingestion on the owner's PC

- **Status:** Accepted on 16 November 2026 by owner decision (HOSTED-01). **Deployed 17 November 2026 (HOSTED-23)** at `https://waspada-jakarta.waspada-worker.workers.dev`, with ingestion moved from the owner's PC to a scheduled GitHub Actions job (HOSTED-13; see the 17 Nov amendment below). The original text below is kept as decided on 16 Nov.
- **Date:** 2026-11-16
- **Owner:** Team 12
- **Scope:** deployment topology and hosted-only publication settings. It amends the hosted rule of the 11 Nov 2026 amendment to [ADR-061](ADR-061-agent-driven-publication.md); the 11 Nov amendment said that any change to that rule needs a new ADR, and this is that ADR. It builds on [ADR-010](ADR-010-cloudflare-neon-free.md) (Cloudflare Workers and Neon Free). Affects `apps/web/dist` (static assets), the planned `serve:hosted-ingest` entry point, `AUTO_PUBLISH_SOURCE_PERMISSION`, the password hash in `apps/worker/src/accounts/password.ts` ([ADR-060](ADR-060-password-accounts.md)), and [SOURCE_CLEARANCE_PLAN.md](../SOURCE_CLEARANCE_PLAN.md). No migration, no change to the public DTOs, and no change to the publication gate's checks.

## Context

- The repository has no public deployment. The course assignment needs a public URL this week.
- ADR-010 chose Cloudflare Workers and Neon Free, and nothing may require a paid tier. The Worker in this repository defines no cron trigger (`apps/worker/wrangler.toml`), so scheduled ingestion does not run in deployment today (`docs/testing/TEST-SUMMARY.md`, section 7, item 11).
- Local live mode (`npm run serve:live`) runs ingestion, the AI runner and the pollers on the owner's PC. The 11 Nov 2026 amendment to ADR-061 said that hosted or public deployments must keep `AUTO_PUBLISH_SOURCE_PERMISSION=required`, so that a hosted site fails closed.

## Decision

1. **Topology.**
   - A Cloudflare Worker on Workers Free serves the public `/api/v1` routes and the static web assets built to `apps/web/dist`. A Hyperdrive binding connects the Worker to Neon.
   - Neon Free Postgres is the only database. Every connection uses `sslmode=require`.
   - Ingestion, the AI runner (`apps/intelligence`) and the pollers (PetaBencana, BMKG and the 14 RSS feeds) run on the owner's PC through `npm run serve:hosted-ingest`, which writes to Neon. This script is planned and not yet built.
   - The Worker has no cron trigger and no NineRouter access. Model calls happen only on the PC.
   - **Consequence:** the hosted site is only as live as the PC. While the PC is off, nothing new is collected or published. Freshness transitions are run by the PC job (the `serve:live` timer; the Worker has no cron). Whether a passed `review_due_at` still shows `needs_update` while the PC is off is not verified.
2. **Hosted auto-publish.** The hosted site runs auto-publish with `AUTO_PUBLISH_SOURCE_PERMISSION=local_relaxed` (owner decision, 16 Nov 2026). This amends the hosted rule in the 11 Nov amendment to ADR-061. The other automatic checks still apply: no discrepancy, a `primary_initial` or `corroborating` correlation, supported and quoted claims, allowed labels, an `https` source link, a valid schema, and a location and an event time from the source. Discrepancies still wait for a moderator. The moderator publish path has no waiver and is unchanged.
3. **Ingestion acceptance.** Each of the 16 sources below must have at least one successful fetch on staging, and again within the first hour of production. The table is filled in when each step is measured.

**Not chosen (owner decisions, 16 Nov 2026):** scheduled ingestion through a cron trigger on the Worker, and model calls from the Worker.

## Limitations (recorded by the owner, 16 Nov 2026)

1. **Rights: `local_relaxed` on hosted auto-publish.** The source-permission check is waived for all 14 RSS outlets, PetaBencana and BMKG. This is recorded as a rights limitation, not a clearance. It amends the ADR-061 note. `docs/SOURCE_CLEARANCE_PLAN.md` still says that BMKG and ANTARA need permission, and it does not cover the other RSS outlets. The SDP section 10 Rights line still says that hosted or public use is not permitted. This ADR does not change that line; the owner must decide its wording.
2. **No off-provider backup.** There is no 30-day encrypted off-provider backup and no deletion-replay rehearsal (SDP section 10, Phase 3 limitations; `docs/PLATFORM_COMPATIBILITY.md`, line 17). Neon Free's restore history is also limited (`docs/PLATFORM_COMPATIBILITY.md`, line 57).
3. **SSE is per isolate, so the web polls.** Server-sent event streams are held per Worker isolate, so the hosted web app polls the public routes instead of relying on SSE.
4. **No pipeline status on the hosted site.** `#alur-agen` shows no pipeline status on the hosted site.
5. **PBKDF2 cost: measured 17 Nov 2026 (see the amendment below).** The current cost is 100,000 iterations (`apps/worker/src/accounts/password.ts`, `PASSWORD_HASH_ITERATIONS`). The count is lowered only if a measured login CPU time is too high for the Workers Free CPU limit. A lowered count is applied with a rehash on the next login. This rehash procedure is decided but not implemented. The verifier rejects stored counts below 10,000 (`MIN_STORED_ITERATIONS`). **Measured outcome:** 25–38 ms CPU per login at 100,000 iterations, no CPU-limit failure; the count is unchanged (details in the 17 Nov amendment).
6. **Source revocation is unchanged.** Revoking a source also turns off its collection, which conflicts with FR-16 (SDP section 10). This is an owner decision that is still open. It is not decided here.

**Related, not one of the six owner limitations.** The F-04 publication check reads `investigation_id` and `case_status`. The L4 publication role cannot read these on hosted grants today, so the check fails closed on hosted (SDP section 10; `docs/testing/DEFECTS.md`, F-04).

## Ingestion acceptance (per source)

Source IDs are taken from `apps/worker/src/runtime/news-poll-runtime.ts` (`DEFAULT_NEWS_FEEDS`), `apps/worker/src/runtime/bmkg-poll-runtime.ts` and `apps/worker/src/layers/l1-data-knowledge/petabencana-ingest.ts` (PetaBencana). Staging evidence (16–17 Nov 2026): the hosted `--once` ingest runs against Neon logged 16 of 16 sources fetched (one later ANTARA Metro poll logged a `fetch_error`). The run log gives counts per source, not timestamps, so the staging cell names the run date. "Revisions" is the number of items that passed triage and were stored, read from `report_revisions` on 17 Nov 2026 04:45 UTC; zero revisions means the feed was fetched but nothing passed triage, not that the fetch failed. The production column (filled 18 Nov 2026) uses GitHub Actions ingest run 44071702304 (17 Nov 2026 11:11 UTC, against the production database after the HOSTED-23 deploy), which logged source health ok=16 failed=0. Per-source revision counts were not re-read for production.

| # | Source ID | Kind | First successful fetch, staging | First successful fetch, production | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `source-antara-metro` | RSS | 16 Nov 2026 (`--once` run, fetched; 0 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 2 | `source-antara-hukum` | RSS | 16 Nov 2026 (`--once` run, fetched; 0 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 3 | `source-antara-terkini` | RSS | 16 Nov 2026 (`--once` run, fetched; 2 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 4 | `source-antara-topnews` | RSS | 16 Nov 2026 (`--once` run, fetched; 0 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 5 | `source-antara-humaniora` | RSS | 16 Nov 2026 (`--once` run, fetched; 0 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 6 | `source-antara-wartabumi` | RSS | 16 Nov 2026 (`--once` run, fetched; 0 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 7 | `source-detik-news` | RSS | 16 Nov 2026 (`--once` run, fetched; 2 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 8 | `source-detik-utama` | RSS | 16 Nov 2026 (`--once` run, fetched; 1 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 9 | `source-cnn-nasional` | RSS | 16 Nov 2026 (`--once` run, fetched; 0 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 10 | `source-cnn-utama` | RSS | 16 Nov 2026 (`--once` run, fetched; 1 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 11 | `source-cnbc-news` | RSS | 16 Nov 2026 (`--once` run, fetched; 0 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 12 | `source-sindonews-nasional` | RSS | 16 Nov 2026 (`--once` run, fetched; 0 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 13 | `source-sindonews-daerah` | RSS | 16 Nov 2026 (`--once` run, fetched; 0 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 14 | `source-tempo-nasional` | RSS | 16 Nov 2026 (`--once` run, fetched; 0 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 15 | `petabencana` | PetaBencana | 16 Nov 2026 (`--once` run, fetched; 0 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |
| 16 | `source-bmkg-gempa` | BMKG | 16 Nov 2026 (`--once` run, fetched; 1 revisions) | 17 Nov 2026 (run 44071702304, fetched) | met |

Row 15 uses the poll runtime's default ID (`PETABENCANA_SOURCE_ID`). `apps/worker/src/layers/l1-data-knowledge/source-status.ts` uses `source-petabencana`, and the live seed registers only the RSS feeds. Confirmed on 17 Nov 2026: `source_registry` on Neon holds `petabencana`.

## Consequences

- The hosted site shows what the last ingest run published. (Original text: liveness depends on the PC. Superseded by the 17 Nov amendment and HOSTED-25: the GitHub Actions ingest, started by the Worker cron, now sets liveness.)
- Hosted auto-publish now waives the same rights check as local live mode. Every other gate check is unchanged.
- Hosted use of collected text stays a rights decision for the owner (see limitation 1).

## Not implemented and not verified

Status 18 Nov 2026: the Hyperdrive bindings, static assets, cron trigger (HOSTED-25), production deployment, Neon connection and PBKDF2 measurement now exist (see the amendments below). The list is kept as written on 16 Nov.


- Whether a passed `review_due_at` shows `needs_update` on the hosted site while the PC is off is not verified. The transitions run from the PC job, not from the Worker.
- `serve:hosted-ingest` is absent from `package.json` on `main` and on the HOSTED-02 to HOSTED-05 branches, which have no commits beyond `main` (checked 16 Nov 2026).
- `apps/worker/wrangler.toml` has no Hyperdrive binding, no static-assets binding and no cron trigger.
- No staging environment, no production deployment, no Neon connection check, and no PBKDF2 CPU measurement exist.
- This ADR is documentation only. No test, typecheck or build was run for it.

## Amendment, 17 November 2026: what was deployed (HOSTED-13 to HOSTED-23)

- **Ingestion moved off the PC.** `.github/workflows/ingest.yml` runs one bounded cycle (`npm run serve:hosted-ingest:once`) every 30 minutes: poll the 16 sources, drain the AI jobs, run every undecided proposal through the deterministic gate (`decideProposal`), then one freshness pass. Its logs are public and carry counts and fixed codes only. Model calls use Google AI Studio from that job; the Worker still makes none. GitHub may delay or skip scheduled runs, so liveness now depends on GitHub's scheduler instead of the PC.
- **One database.** The Worker and the scheduled ingest use the same Neon database (owner decision, 17 Nov). One Hyperdrive config, `waspada-public`, backs both `HYPERDRIVE` and `AUTH_HYPERDRIVE`; it connects as the Neon owner login, which switches into the NOLOGIN layer roles granted by `hosted:bootstrap`.
- **Gate changes recorded elsewhere.** An unknown event time is accepted with waiver `event_time_unknown` (HOSTED-21, ADR-061 amendment), so decision item 2's "an event time from the source" no longer holds for auto-publish. Publication writes source attribution (HOSTED-22, ADR-020 amendment).
- **Smoke (17 Nov 2026).** All public routes and event detail answered 200; a POST without `Origin` answered 403; self-registration returned role `user`; moderator and admin logins worked. Live UAT passed read-only: T4 15 of 15 steps, T5 23 of 23 steps, and a public phone check (PUB-01) with two copy/attribution findings (`docs/testing/UAT.md` section 9.2).
- **PBKDF2 measurement (limitation 5).** `wrangler tail` on three production logins at 100,000 iterations: CPU time 25, 32 and 38 ms, outcome `ok`, wall time 153–183 ms. For comparison, `GET /api/v1/events` used 55 ms. This is above the nominal 10 ms Workers Free CPU allowance, but no request failed with an exceeded-CPU outcome, so the count was not lowered (lowering is reserved for measured failures). Re-measure if login errors with an exceeded-CPU outcome appear.
- **Known gaps at deploy.** Events published before HOSTED-22 have no attribution rows and are skipped from the public list (3 at deploy). The hosted ingest does not write `source_registry` health columns. No production-hour fetch evidence exists until the schedule fires. No off-provider backup (limitation 2) and no rights clearance (limitation 1) are unchanged.

## Amendment, 18 November 2026: HOSTED-24 and HOSTED-25

- **Attribution backfill (HOSTED-24C).** Each ingest run attributes published versions that lack attribution rows. The 3 events skipped at deploy were attributed on 17 Nov 2026 and returned to the public list.
- **Source health (HOSTED-24B, HOSTED-25).** The ingest writes per-source health to `source_registry`. On the hosted database only GitHub Actions runs write it; a PC run logs `skipped`. Run 44071702304 logged ok=16 failed=0.
- **Worker cron starts the ingest (HOSTED-25).** GitHub's own schedule fired once in about 18 hours (run 44151179665, 17 Nov 18:44 UTC). The workflow's `schedule:` was removed. The production Worker cron (`7,37 * * * *`) now sends one `workflow_dispatch` request per slot, with a fine-grained token limited to this repository's Actions. First cron-started run: 44217189260, 18 Nov 2026 01:37 UTC. The Worker still does no ingest and makes no model calls.
- **Detail copy and source lines (HOSTED-24A).** UAT findings R-09 and R-10 were fixed (88bcf69) and verified on the live site.

## Amendment, 18 November 2026: owner decisions on the limitations

- **Limitation 1 (rights, `local_relaxed`): accepted as a known limitation** (owner, 18 Nov 2026). Hosted auto-publish keeps the waiver. It is recorded as a limitation of the course prototype, not as source clearance. `docs/SOURCE_CLEARANCE_PLAN.md` still governs any claim of permission.
- **Limitation 2 (no off-provider backup): accepted** (owner, 18 Nov 2026). Neon Free is the only copy. No backup job will be added for this release.
- **Limitation 4 (no pipeline status on the hosted site): to be fixed.** The owner chose to wire `#alur-agen` to the database (follow-up task).
- **Limitation 6 (source revocation): decided.** Revoking a source stops publication only; collection continues (FR-16). Implementation is a follow-up task; until it lands, the old behaviour applies.
- **Domain: no custom domain** (owner, 18 Nov 2026). The site stays on `*.workers.dev`. Some ISP resolvers block that hostname (`docs/testing/DEFECTS.md` F-17); this is an accepted limitation.
- **Password reset: out of scope** for this release (owner, 18 Nov 2026).

## Amendment, 23 November 2026: password reset and local notifications

- **Password reset: decided.** This replaces the 18 Nov 2026 line above. Owner decision, 23 Nov 2026: a password reset goes through the administrator. An administrator issues a one-time code of 10 Crockford base32 characters, valid for 30 minutes, usable once, and burned after 5 wrong attempts. Only its PBKDF2 hash is stored, and the audit row `password_reset_code_issued` never holds the code. There is no email. Delivered by AUTH-RESET-01 (merge `4b34b3d`); migration 063 was applied to the hosted Neon database on 23 Nov 2026.
- **Notifications: local only** (owner decision, 23 Nov 2026). "Area saya" notifications run on the device. There is no Firebase and no Web Push, and interests are never uploaded. Delivered by NOTIFY-01 (web `a7768db`, Android merge `51c3ed2`).

## Amendment (28 Nov 2026, HOSTED-26)

The owner cut the ingest cadence from every 30 minutes (`7,37 * * * *`) to once an hour (`7 * * * *`) to save Neon Free compute. Neon showed 25.77 CU-hours used, against a 100 CU-hour monthly allowance. Each run wakes the database for the run plus the roughly 5-minute idle suspend, so the ingest share of compute about halves. Trade-off: new reports reach the hosted site up to about an hour after publication instead of about 30 minutes.
