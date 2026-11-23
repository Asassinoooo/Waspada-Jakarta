# Evidence index, 20 November 2026

This folder holds the records behind the register update of 20 November 2026 (TG-DOCS-09: `SYSTEM-TEST.md`, `test-cases.csv`, `DEFECTS.md` F-39 to F-50 and `TEST-SUMMARY.md` section 7D). Each section says what was run, when, the result, and which register rows it supports.

No credential value is recorded here. Where a command needs a database or service credential, it reads the git-ignored env file (`.env.local`), and that is all this index says about it.

## deploy/

- **What was run.** `npm run hosted:bootstrap` (main `5d4dc3c`), then `npm run deploy:prod` (builds the web app, then deploys the Worker). Output as printed: `bootstrap-and-deploy.txt`.
- **When.** 20 Nov 2026.
- **Result.** Migration 062 applied (1 applied, 61 already present, 62 files). 16 of 16 sources ready. Purge function present. Worker version `007fbaa5-12d0-40e0-a999-db3af53eb11b`. Schedule `7,37 * * * *`.
- **Supports.** ST-N-07 (retention purge deployed), ST-N-04 (the deployed build), and the deploy references in `DEFECTS.md` F-39 to F-48.

## ci/

- **What was run.** GitHub Actions run 44539519014 on `5d4dc3c` (push to main), job 135613780034. `gh run view 44539519014 --log` returned an empty file, so the job log was read with `gh api repos/<owner>/Waspada-Jakarta/actions/jobs/135613780034/logs`.
- **Result.** Conclusion success; 16 steps, all success. `ci-44539519014-cited-tests.txt` gives the totals per step and the passing lines for each cited test file (23 files, 130 titles). The job log has no failing line.
- **Supports.** The rows marked Evidence exists on 20 Nov 2026 in `test-cases.csv` and listed in section 7D of `TEST-SUMMARY.md`.

## nfr07/

- **What was run.** Two hosted ingest runs, filtered to the ingest lines: `ingest-44651206557.txt` (before the bootstrap) and `ingest-44692616661.txt` (after it). A ZAP 2.17.0 active scan of a local copy, with `plan-active.yaml` and the reports `zap-active-local-report.html`, `zap-active-local-report.json` and `zap-active-local.log`. `README.txt` in this folder gives the same results in prose.
- **When.** 20 Nov 2026. The first run started 01:07 UTC; the second's filtered lines start at 07:14 UTC.
- **Result.** 44651206557: `Retention purge: failed.`; feeds_ok=13 feeds_failed=3; petabencana and source-bmkg-gempa `error=poll_error`; source-detik-utama `error=fetch_error`; exit 0. 44692616661: feeds_ok=16 feeds_failed=0; purge counts all 0. ZAP on the Worker API (127.0.0.1:8787): informational alerts only. ZAP on the Vite dev server (127.0.0.1:5173, not deployed): Medium CSP not set and anti-clickjacking header missing; Low X-Content-Type-Options missing. Production was not actively scanned.
- **Supports.** ST-N-07; F-39 to F-43.

## nfr04/

- **What was run.** PERF-01 re-timing against the hosted public routes after the deploy, in three measurements per file: cold (first request after 5 minutes idle, 3 rounds), warm sequential (30 requests per route, 250 ms apart) and concurrent (5 clients x 20 requests per route). The script is not kept in this folder.
- **Run 3** (`timing-run3-after-perf01.txt`, started 07:25 UTC). Result: warm GET routes met p50 under 500 ms and p95 under 1 s; `POST /api/v1/briefings` p50 869 ms, 13 of 30 failed (503); 40 of 100 `GET /api/v1/events` failed (503) under 5 clients; 2 of 100 briefing requests failed; cold maximum 1,012 ms (briefings).
- **Interrupted run** (`timing-run3-interrupted-network.txt`, started 01:26 UTC). Stopped after cold round 1 with a network timeout (ETIMEDOUT). Kept for the record; not a result.
- **CPU** (`cpu-tail-after-perf01.txt`, wrangler tail, 20 Nov 2026). 16 sampled `GET /api/v1/events` on `007fbaa5`: CPU p50 35 ms, max 52 ms. The file records 37 to 113 ms before the fix (19 Nov). A burst of 6 clients x 8 requests gave 5 x 503 with `error code: 1102`.
- **Supports.** ST-N-04 (stays Partial); F-47 and F-50.

## Cited from 19 November 2026 (not copied here)

- `docs/testing/evidence/2026-11-19/nfr06/restore-report-v2.json` and `manifest-v2.json`: ST-N-06. The v2 files supersede the v1 README in that folder.
- `docs/testing/evidence/2026-11-19/nfr04/timing-run2-before-perf-fix.txt`: the ST-N-04 baseline and F-47.
- `docs/report/screenshots/ch5/fig-5-flow-390.png` and `fig-5-embedding-390.png`: ST-F-08. They show the empty state at 390 px; page-level horizontal scroll is not measured.
