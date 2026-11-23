# Hosted deployment: Cloudflare Workers + Neon Free

Status: **deployed 17 Nov 2026 (HOSTED-23).** The production Worker `waspada-jakarta` is live at `https://waspada-jakarta.waspada-worker.workers.dev`. The steps below record what was actually run. Routine CI never deploys; `ingest.yml` (section 7) writes data but deploys nothing.

Note for testers on Indonesian mobile ISPs: some resolvers (seen: XL Axiata) answer `*.workers.dev` with a block page, which shows up as a TLS "certificate name does not match" error. The site itself is fine. Use another resolver (for example Cloudflare WARP or 1.1.1.1) to reach it.

Hosted use runs under the rights limitation recorded in ADR-065 (limitation 1, `local_relaxed`). No source-rights clearance is claimed. `SOURCE_CLEARANCE_PLAN.md` still records BMKG and ANTARA as needing permission, and it does not cover the other RSS outlets.

## What runs where

- One Worker, `waspada-jakarta` (env `production`), serves the built SPA from `apps/web/dist` as static assets and the API under `/api/v1/*` on the same origin. The web app calls relative `/api/v1/*` paths, so no build-time base URL is needed. All Worker routes are under `/api/v1/*`, so `run_worker_first = ["/api/*"]` sends only API calls to the Worker.
- The Worker reads Neon Postgres through Hyperdrive. As deployed, **one** Hyperdrive config (`waspada-public`) backs both bindings, `HYPERDRIVE` and `AUTH_HYPERDRIVE`. It connects as the Neon owner login; the runtime switches into the NOLOGIN layer roles (including `waspada_auth_service`) that `hosted:bootstrap` granted to that login. No separate auth login exists.
- The production Worker and the scheduled ingest use **the same Neon database** (owner decision, 17 Nov 2026). There is no separate staging database any more.
- Live pollers (PetaBencana, BMKG, RSS) do not run inside the Worker. They run in the scheduled GitHub Actions ingest (section 7), which writes to Neon.
- Production values: `DATASET_MODE=live`, `SOURCE_PREVIEW_ENABLED=false`, `AUTH_ENABLED=true`. The demo routes (`/api/v1/demo/*`) answer 404 in production. The default block in `wrangler.toml` keeps `DATASET_MODE=demo` for `npm run dev`.
- Because `[env.production]` now exists, a bare `wrangler deploy` prints a warning that no environment was chosen. Use `npm run deploy:prod`, which passes `--env production`.

## 1. Owner prerequisites

1. A Cloudflare account on the Workers Free plan.
2. Log in from WSL with `npx wrangler login`. It opens a browser. Do not paste tokens into the terminal log or into chat.
3. A Neon Free project (Postgres 17 with `postgis` and `vector`). As deployed, one database serves both the ingest and the Worker.
4. Run `npm run hosted:bootstrap` once against it. It applies migrations 001–053, creates the layer roles (with the HOSTED-19 role-attribute compatibility for Neon's non-superuser owner), seeds the 16 sources and the admin and moderator accounts.

## 2. Hyperdrive configs

Enter each Neon connection string without echoing it or saving it in shell history:

```sh
read -rs NEON_URL && export NEON_URL
npx wrangler hyperdrive create waspada-public --connection-string="$NEON_URL"
read -rs NEON_URL_AUTH && export NEON_URL_AUTH   # string for the dedicated auth role
npx wrangler hyperdrive create waspada-auth --connection-string="$NEON_URL_AUTH"
unset NEON_URL NEON_URL_AUTH
```

As deployed (HOSTED-23) only the first command was run, with the direct (non-pooled) Neon host; Hyperdrive pools on its own. The second config is optional and was not created. Wrangler prints an id for each config. Paste them into `apps/worker/wrangler.toml`:

- `[[env.production.hyperdrive]]` with `binding = "HYPERDRIVE"` replaces `REPLACE_WITH_HYPERDRIVE_ID`.
- `[[env.production.hyperdrive]]` with `binding = "AUTH_HYPERDRIVE"` replaces `REPLACE_WITH_AUTH_HYPERDRIVE_ID`. If you deliberately use one config for both bindings, paste the same id in both blocks.

## 3. Public origin and first deploy

`AUTH_APP_ORIGIN` in `[env.production.vars]` is a placeholder: `https://waspada-jakarta.REPLACE-ME.workers.dev`. Replace it with this Worker's exact https origin, with no trailing slash. Your account subdomain appears under Workers & Pages in the Cloudflare dashboard. If you do not know it yet, deploy with the placeholder and correct it afterwards. Auth accepts only that exact origin.

```sh
npm run deploy:prod
```

This runs the web build (`vite build` for `@waspada/web`) and then `wrangler deploy --env production`. If `AUTH_APP_ORIGIN` changes after this deploy, correct it and run `npm run deploy:prod` again.

## 4. Production secrets

Run this after step 3, because `wrangler secret put` needs the Worker to exist. Each value is generated into a shell variable and piped to Wrangler with `printf '%s'`, which adds no trailing newline. Nothing is written to a file in the repo.

```sh
PUBLIC_CURSOR_KEY=$(openssl rand -hex 32)
printf '%s' "$PUBLIC_CURSOR_KEY" | npx wrangler secret put PUBLIC_EVENT_LIST_CURSOR_HMAC_KEY_HEX --env production

INTERNAL_KEY=$(openssl rand -hex 32)
printf '%s' "$INTERNAL_KEY" | npx wrangler secret put INTERNAL_SERVICE_KEY --env production

WEBHOOK_KEY=$(openssl rand -hex 32)
printf '%s' "$WEBHOOK_KEY" | npx wrangler secret put WEBHOOK_SERVICE_KEY --env production
```

As deployed, `INTERNAL_SERVICE_KEY` and `WEBHOOK_SERVICE_KEY` are also kept in the git-ignored root `.env.local` as `PROD_INTERNAL_SERVICE_KEY` and `PROD_WEBHOOK_SERVICE_KEY`; nothing off-Worker uses them today, because the ingest writes to Neon directly. Save them in your password manager as well. Callers must present the same values. A webhook sender presents `WEBHOOK_SERVICE_KEY` as `x-service-key`. A PC node that notifies the Worker needs `INTERNAL_SERVICE_KEY` in the root `.env.local`, which is git-ignored. The cursor key is used only by the Worker, but keep a copy as well.

Until these secrets are set, the public event list answers with the bounded unavailable response (HTTP 503), and the machine routes answer 503 as well.

## 5. Ingest (superseded)

The PC ingest node (`npm run serve:hosted-ingest`) is no longer how the hosted site is fed. The scheduled GitHub Actions ingest in section 7 replaced it. The PC command still exists for local runs, but it has no lock, so never run it alongside the schedule.

## 6. Smoke checks

- `curl -sS -o /dev/null -w "%{http_code}\n" https://<your-origin>/api/v1/events` prints `200`.
- Open `https://<your-origin>/` in a browser. The SPA loads, and `#jelajah` shows only published data.
- Check the Worker logs in the Cloudflare dashboard for secret or connection errors. Do not paste their contents into chat.

Results on 17 Nov 2026 (HOSTED-23): `/`, `/api/v1/events`, `/api/v1/context`, `/api/v1/updates` and `/api/v1/events.geojson` answered 200, and event detail answered 200. The list held 1 event. A POST to `/api/v1/auth/register` without `Origin` answered 403. Registration with the web app's `Origin` and `x-waspada-request: 1` header returned role `user`. The moderator and admin logins answered 200 with roles `moderator` and `admin`. `wrangler tail` showed no exceptions. Login CPU time was 25–38 ms (see ADR-065, limitation 5).

## Known limitations

- No off-provider backup. Neon Free is the only copy of the hosted data. Export it yourself if you need one.
- The site is only as live as the ingest runs. GitHub's own schedule fired once in about 18 hours (17 to 18 Nov 2026), so since HOSTED-25 the Worker cron starts each run instead (section 7).
- Per-source health in `source_registry` (`health_status`, `last_checked_at`, `last_success_at`) is written by the GitHub Actions ingest only (HOSTED-24B, HOSTED-25). A PC run against the hosted database logs `skipped`, so a local network problem cannot mark a source degraded.
- SSE is per isolate. A client sees updates only from its own isolate, so the web app polls instead.
- The production Worker has a cron trigger (`7,37 * * * *`, HOSTED-25). With `SCHEDULED_MODE=github_dispatch` its `scheduled()` handler only sends one `workflow_dispatch` request to GitHub and logs `[ingest-dispatch] outcome=<code>`. It never polls or ingests in the Worker.
- Rollback to the previous Worker version: `npx wrangler rollback --env production`.

## 7. Scheduled hosted ingest (GitHub Actions, HOSTED-13)

This replaces the PC ingest node in section 5 for the hosted site. `.github/workflows/ingest.yml` runs every 30 minutes. The production Worker cron (`7,37 * * * *`, UTC) starts it through `workflow_dispatch`, and it can also be started by hand (`gh workflow run ingest.yml --ref main`). The workflow has no `schedule:` of its own any more, so runs are not doubled. The Worker needs the secret `GITHUB_DISPATCH_TOKEN`: a fine-grained GitHub token for this repository only, with **Actions: Read and write** and nothing else (`npx wrangler secret put GITHUB_DISPATCH_TOKEN --env production`). Without it the cron logs `outcome=not_configured` and nothing runs. On the hosted database only GitHub Actions runs write `source_registry` health; a PC run logs `skipped` instead (HOSTED-25). Each run does one bounded cycle against Neon and exits:

1. Coverage guard: the 16 live sources must exist in `source_registry`. If one is missing, the run exits 1.
2. One poll cycle: 14 RSS feeds, PetaBencana and BMKG. A source that fails is logged and the run goes on.
3. A drain of queued AI jobs. It stops when the queue is empty, when the time budget is used up, or after three jobs in a row that do not complete. The budget is `INGEST_TIME_BUDGET_MINUTES` (default 20, allowed 1 to 25) and counts from the start of the run. No new job starts after it.
4. One freshness pass. The session closes and the run exits 0. Exit 1 happens only when the database is unreachable or a fault is unexpected.

This path does not re-drive stranded jobs (`needs_review` with `model_failed` or `rate_limited`). Re-driving resets the attempt count, so a 30-minute schedule would retry them without a bound. The local `serve:hosted-ingest` mode still re-drives them when it starts.

Owner setup:

- Add two repository secrets in GitHub under Settings, then Secrets and variables, then Actions: `NEON_DATABASE_URL` (the direct, non-pooled Neon URL) and `GOOGLE_AI_API_KEY`. Do not store them as variables, and do not paste either value into an issue, a PR or chat.
- Enable Actions for the repository under Settings, then Actions, then General. Scheduled runs use the default branch.
- Merge HOSTED-12 (the Google AI provider) to `main` before you add the secrets. Until it is merged, `main` has no provider switch. The run then calls the NineRouter path, which is not reachable from GitHub, and jobs fail.
- Record the publication decision before you enable the schedule. The headless path publishes with `AUTO_PUBLISH_SOURCE_PERMISSION=local_relaxed`, the same as the local server. That relaxes the source-permission check against the public database. Hosted deployments otherwise use `required`. This is still an open owner decision.
- To run it by hand, open Actions, choose "Hosted live ingest", then "Run workflow". Manual runs share the same concurrency group.

What to check in a run log. The log is public, so it prints counts and fixed codes only:

- `✓ Source coverage: N of 16 live sources are ready; M skipped.`: how many of the 16 sources are ready. Skipped sources are listed under `[Coverage]`.
- `[Once] AI jobs: completed=N not_completed=M stop=...`: `stop` is `empty`, `budget`, or `consecutive_not_completed`.
- `[Once] Done: exit=0 elapsed=...s transaction_state_warnings=0`. A non-zero warning count needs a look.
- The `[RSS Feeds]` and `[Freshness]` lines for totals.

If a run fails, check the step's exit code first. Do not paste the log into an issue.

Lock and timing:

- The concurrency group `waspada-ingest` is the only lock. Runs never overlap, and a queued run waits for the one in progress.
- Local PC mode (`serve:live`, or `serve:hosted-ingest` without `--once`) has no lock. Do not run it on the PC while the schedule is on.
- GitHub's own `schedule:` trigger was unreliable (delayed or skipped runs) and is disabled for public repositories after 60 days without activity, so it is not used. `workflow_dispatch` from the Worker cron has neither problem. Rotate the token before it expires; an expired token shows as `outcome=rejected_auth`.
- A run is capped at 30 minutes. If a model call is still running at the cap, the run is stopped. Its job lease expires after 5 minutes, and a later run then reclaims that job.
- The workflow uploads no artifacts and caches only npm packages. Nothing from the database is written to a cache or an artifact.
- Neon Free compute: each run wakes the database for the coverage check, the poll cycle and the freshness pass. Watch the compute hours on the free plan.

## 8. Continuous deployment (GitHub Actions, CD-01, 23 Nov 2026)

Every push to `main` runs the `CI` workflow (`.github/workflows/ci.yml`). When the `test` job passes, the `deploy` job runs `npm run deploy:prod` (Vite build, then `wrangler deploy --env production`), and then checks that `/`, `/api/v1/context` and `/api/v1/events?limit=1` return 200. Pull requests run the checks but never deploy, and a failed check means no deploy. A manual run of `CI` on `main` (Actions → CI → Run workflow) re-runs the checks and redeploys the current commit. Deploys run one at a time; a newer commit waiting in the queue replaces an older one that has not started.

One-time setup, in GitHub → Settings → Secrets and variables → Actions → New repository secret:

1. `CLOUDFLARE_ACCOUNT_ID`: the account id shown on the Cloudflare dashboard (Workers & Pages, right column).
2. `CLOUDFLARE_API_TOKEN`: Cloudflare → My Profile → API Tokens → Create Token → template "Edit Cloudflare Workers". Add the permission Account → Hyperdrive → Edit (the Worker binds three Hyperdrive configs), keep Workers KV Storage → Edit, and limit Account Resources to this account. Without both secrets the deploy job fails at "Check deploy credentials" and nothing is deployed.

What CD does not do:

- It does not apply database migrations. Apply a new migration to Neon by hand before merging the code that needs it.
- It does not change Worker secrets (`wrangler secret put --env production` stays manual); a deploy keeps the existing ones.
- It does not build or publish the Android app.

Rollback: revert the commit on `main` and push (CD deploys the revert), or run `npx wrangler rollback --env production` from `apps/worker` for an immediate rollback to the previous Worker version.
