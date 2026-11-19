# Evidence index, 19 November 2026

This folder holds the records behind the register update of 19 November 2026 (TG-DOCS-08, `SYSTEM-TEST.md`, `test-cases.csv`, `TEST-SUMMARY.md` section 7C and `DEFECTS.md` F-33 to F-45). Each section says what was run, when, the result, and which register rows it supports.

No credential value is recorded here. Where a command needs a database or service credential, it reads the git-ignored env file (`.env.local`), and that is all this index says about it.

Commands below are the forms the scripts take. Where a file in this folder does not record the exact invocation, the section says so.

## test-runs/

- **What was run.** 51 new or changed test files, one file per process, with `npx tsx --test <test file>` (the single-file form in `CLAUDE.md`). Code was `main` at `e68aefd`, Node v24.21.0. The shell wrapper used that day is not kept here.
- **When.** Started 19 Nov 2026, 09:41:54 UTC (header of `SUMMARY.txt`).
- **Result.** 51 of 51 files exit 0. Totals: 550 tests, 546 pass, 0 fail, 4 todo. The 4 todo are in `nfr07-malicious-source-gate.test.ts` (3) and `nfr07-source-text-isolation.test.ts` (1).
- **After the fix in `9f6a456`.** The same two files were recorded at 11 of 11 and 6 of 6 when this update was made. No run file for `9f6a456` is in this folder; CI run 44502344276 covers it (see `ci/`).
- **Included tests.** TEST-GAP-04 web and worker/db tests, the ST-F-09 source and role-change tests, the NFR-02 L3 budget tests (`l3-reasoning-budget`, `l3-tool-attempt-budget`), the NFR-05 repeated-delivery tests, the NFR-07 tests, the security-header tests, and `tools/hosted/restore-rehearsal.test.ts`.
- **Supports.** ST-F-02, ST-F-03, ST-F-04, ST-F-05, ST-F-07, ST-F-08, ST-F-09, ST-F-11, ST-F-12, ST-F-13, ST-F-15, ST-F-16, ST-N-02, ST-N-05, ST-N-06 (restore test), ST-N-07, BR-02 (header reflow).

## ci/

- **What was run.** GitHub Actions CI on `main`.
  - `run-44498555647.json`: the run for commit `e68aefd`, read with `gh run view` (fields: conclusion, createdAt, headSha, steps, updatedAt, url).
  - `log-counts.txt`: the per-step test summary lines from the job log, kept as text. The grep used to extract them is not recorded.
- **When.** Created 19 Nov 2026 09:40:17 UTC; finished 10:01:29 UTC.
- **Result.** Conclusion success, every step success (Set up job to Complete job). Counts: 2,917 tests, 2,913 pass, 0 fail, 4 todo. By step: database 436; web 514; worker 1,481 (3 todo); intelligence 239 (1 todo); pipeline 58; accounts 115; evaluation and AI tools 74.
- **Second run.** CI run 44502344276 on `9f6a456` concluded success. Checked on 19 Nov 2026 with `gh run view 44502344276 --json conclusion,headSha,url,name`. Not stored as a file.
- **Supports.** ST-N-08 (clean checkout, `npm ci`, typecheck, build), and the `ci_visibility` cells of the rows updated on 19 Nov 2026.

## nfr04/

- **What was run.** A timing script against the hosted public routes: 30 sequential requests per route, read from WSL. The script is not kept in this folder. `timing.txt` gives n, ok, p50, p95 and max per route, and whether p50 is under 500 ms and p95 under 1 s (the owner target of 19 Nov 2026).
- **When.** 19 Nov 2026 (the file gives no time).
- **Result.** 30 of 30 OK on each route. p50 and p95 in ms: page `/` 48 and 68; `GET /api/v1/events` 145 and 324 (max 808); event detail 48 and 58; history 46 and 58 (max 103); updates 63 and 73; context 38 and 47. All six routes meet the target.
- **Not covered.** Warm and cold requests are not separated, briefings (POST) are not timed, and concurrency is not measured.
- **Supports.** ST-N-04 (Partial, target met), ST-H-22.

## nfr06/

- **What was run.** A logical restore rehearsal of the hosted data, with the repository script (`tools/hosted/restore-rehearsal.ts`):
  - `npm run hosted:restore-rehearsal -- export --out .codex-build/restore/<run>` reads the hosted database URL from the git-ignored env file, inside one read-only transaction.
  - `npm run hosted:restore-rehearsal -- restore --from .codex-build/restore/<run>` applies the migrations to a fresh in-memory PGlite database and loads the dump. It writes `restore-report.json`.
  - The dump directory is not in this folder. `restore-report.json` and `manifest.json` are the records.
- **When.** Exported 19 Nov 2026 09:40:34 UTC; restored 09:41:01 UTC.
- **Result.** 64 tables exported and 10,386 rows (7,598,267 bytes; export 16.396 s). The manifest lists 69 tables; 5 account and session tables are excluded and recorded by count only. Restore 18.818 s; verify 0.461 s. Migrations 61 of 61 applied. `countsMatch` true; 22 of 22 public events matched; foreign keys restored; `ok` true.
- **Limits.** This is a logical restore, not a Neon point-in-time restore. The target is PGlite, not Postgres. The demo fixtures were not restored. Deletion tombstones are not recorded.
- **Supports.** ST-N-06 (Partial).

## st-f-08/

- **What was run.** A moderator's reads of the flow API before and after a scheduled ingest cycle, about 3 minutes apart (the file says "after (3 min)"). The file holds the login status, the cycle number, errors, the source health counts and the start of the page text. The read script is not kept. Screenshots `fig-5-flow-before.png` and `fig-5-flow-after.png` are in `docs/report/screenshots/ch5/`.
- **When.** 19 Nov 2026. Cycle 54 finished 08:47:24 UTC; cycle 55 finished 09:18:55 UTC.
- **Result.** Cycle 54: errors 1, RSS 13 of 14 healthy. Cycle 55: errors 0, RSS 14 of 14 healthy. PetaBencana and BMKG healthy in both. The page is read-only ("MODERATOR · BACA SAJA") and shows "Diperbarui 19 Nov 2026, 16.19 WIB".
- **Supports.** ST-F-08 (Partial), ST-H-21.

## nfr07/

- **What was run.**
  - `zap-plan.yaml`: an OWASP ZAP automation plan for a passive scan of the hosted site. It has the passive scan config and wait, ten GET requests, and a spider of up to 5 minutes at depth 5 with two threads, with no form posting. No active scan. Reports: `zap-before.html` and `.json` (before SEC-HEADERS-01), `zap-after.html` and `.json` (after). The ZAP invocation is not recorded in this folder.
  - `checklist-before.txt` and `checklist-after.txt`: the scripted checklist of 36 checks (headers, CORS, Origin and CSRF refusal, protected routes, session cookies, login errors, plain-HTTP redirect, input errors, login throttling). The script is not kept in this folder.
- **When.** The ZAP report headers give 19 Nov 2026 16:21:36 (before) and 18:50:15 (after), in the time zone the reports record. The checklists ran the same day.
- **Result.**
  - ZAP before: 0 High, 2 Medium (CSP not set; anti-clickjacking header missing), 3 Low (HSTS not set; X-Content-Type-Options missing; Timestamp Disclosure), 3 informational.
  - ZAP after: 0 High, 0 Medium, 1 Low (timestamp disclosure of public data), 3 informational.
  - Checklist before: 24 pass, 12 fail. After: 34 pass, 2 fail. The two after: Permissions-Policy absent on the JSON API response (not applicable to JSON), and plain-HTTP static pages not redirected (a Cloudflare zone setting is not available on workers.dev; HSTS limits exposure).
- **Supports.** ST-N-07 (Partial), ST-H-25, ST-H-26, F-38.

## sec-headers/

- **What was run.** Header reads with `curl`: `GET /` and `GET /api/v1/context` on the hosted site, and a plain-HTTP request to the API. Each block names the method and URL; re-recorded with GET after the deploy (both return 200; plain HTTP to the API returns 308 to HTTPS).
- **When.** 19 Nov 2026, after the SEC-HEADERS-01 deploy (Worker version `ea955b9f`).
- **Result.** `/` returns HSTS, CSP, Permissions-Policy, Referrer-Policy, X-Content-Type-Options and X-Frame-Options. The API responses return HSTS, a `default-src 'none'` CSP, Referrer-Policy, X-Frame-Options and X-Content-Type-Options. The plain-HTTP API request returns 308 to the HTTPS URL.
- **Supports.** F-38 (SEC-HEADERS-01), ST-N-07, ST-H-26.

## Screenshots outside this folder

These are in `docs/report/screenshots/ch5/`:

- `fig-5-detail-times.png`: the record page times and freshness label (ST-F-05, ST-H-23).
- `fig-5-csp-map.png` and `fig-5-csp-detail.png`: browser console check for CSP violations on the map and a record page (ST-H-24).
- `fig-5-flow-before.png` and `fig-5-flow-after.png`: the flow before and after the cycle (ST-F-08, ST-H-21).

Other `ch5` screenshots are for Chapter 5 and are not indexed here.

## Not in this folder

- ST-H-27, the matched update in Pembaruan on live data: an operator record of 19 Nov 2026. It was not observed, and no file was kept.
- The CI check of `9f6a456` (run 44502344276): see `ci/` above.
- Commit checks (`git show -s`, `git merge-base --is-ancestor`): recorded in `DEFECTS.md`.
