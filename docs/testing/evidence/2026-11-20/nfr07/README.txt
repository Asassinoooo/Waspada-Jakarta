Ingest 44651206557 (run started 01:07 UTC per the raw log) ran BEFORE the bootstrap. Three sources failed: petabencana and source-bmkg-gempa error=poll_error, source-detik-utama error=fetch_error (feeds_ok=13 feeds_failed=3, exit=0). 'Retention purge: failed.' is logged as a fixed line; migration 062, which adds the purge function, was not yet applied. The log gives no error text for the purge or for the three sources.
Ingest 44692616661 (filtered lines from 07:14 UTC) ran AFTER the bootstrap: feeds_ok=16 feeds_failed=0, purge counts all 0 (hosted data younger than every retention limit).

ZAP 2.17.0 active scan, 20 Nov 2026, LOCAL copy only (npm run dev: Worker on 127.0.0.1:8787 with demo data, Vite dev server on 127.0.0.1:5173). Production was not actively scanned.
Plan: plan-active.yaml (requestor for the public, auth, moderation, pipeline and briefing routes, spider, activeScan max 30 min). Reports: zap-active-local-report.html/.json, log zap-active-local.log.
Result, Worker API (8787): no High, Medium or Low alerts; informational only (authentication request identified, user agent fuzzer).
Result, Vite dev server (5173): Medium CSP header not set, Medium anti-clickjacking header missing, Low X-Content-Type-Options missing. These come from the local Vite dev server, which is not deployed; the hosted page sends these headers (SEC-HEADERS-01, ZAP after-scan 19 Nov 2026).

Follow-up on the ZAP insight "23 % of responses from 127.0.0.1:8787 had status 5xx" (20 Nov 2026, same local Worker, demo data, no database):
200 /api/v1/events, /events/synthetic-demo-01, /history, /context, /auth/session
400 /api/v1/events?cursor=x (INVALID_REQUEST cursor is invalid), ?limit=abc (limit must be an integer)
404 /api/v1/events/'"> , /api/v1/zzz , / (NOT_FOUND)
503 /api/v1/updates, /updates?since=zz, POST /briefings (valid, garbage and wrong bodies): TEMPORARILY_UNAVAILABLE "The public read could not be completed."
503 /api/v1/moderation/proposals ("This service requires an account database for this route."), /pipeline/flow, POST /auth/login
Conclusion: every 5xx is the designed fail-closed 503 of a database-backed route when no database is configured; no 500 and no stack trace was returned.
