# Fly.io Deployment Execution Plan (Single App for API + Worker + Dashboard)

## Objective

Deploy ClawTriage to Fly.io with:
- one-command deploy
- exactly one running Fly machine for the app
- all services in one deployment app:
  - API
  - worker
  - dashboard frontend
- job execution triggered by either:
  - manual trigger by an authorized maintainer (typically after push)
  - scheduled cron interval

This plan is for review and implementation sequencing.

## Scope and assumptions

In scope:
- Fly app packaging and deployment flow
- trigger path for `public-pr-scan` jobs
- authorization and scheduling controls

Out of scope:
- multi-machine HA
- issue dedupe/LLM expansion
- any change to production-first scoring behavior

Assumption:
- "push from an authorized user" is implemented as an authorized maintainer calling the secured trigger endpoint after pushing.

## Target topology

Single Fly app, one process group, one machine:
- one container runs API + worker + embedded Postgres + embedded Redis
- dashboard frontend is built to static assets and served by the API process
- API serves `/api/health`, webhook ingest, dashboard/ops endpoints
- worker consumes BullMQ jobs and performs analysis
- browser traffic hits one hostname:
  - `/api/*` -> API routes
  - `/` and frontend routes -> static dashboard app

Data persistence:
- one Fly volume mounted at `/data`
- Postgres data under `/data/postgres`
- Redis append-only data under `/data/redis`

Rationale:
- keeps deployment to one app and one machine
- acceptable tradeoff for non-mission-critical derived data

## Phase 1: Production runtime packaging (single app)

1. Add production start commands:
- `@clawtriage/api`: `start` script (non-watch runtime)
- `@clawtriage/worker`: `start` script (non-watch runtime)
- root `start:fly` script to start both and fail fast if either process exits

2. Add dashboard production build step:
- build dashboard assets as part of image build (`pnpm dashboard:build`)
- output static files to `apps/dashboard/dist`

3. Serve dashboard from API process:
- mount static assets in Express (`apps/dashboard/dist`)
- keep JSON API under `/api/*`
- add SPA fallback to `index.html` for non-API routes

4. Add a process supervisor shell entrypoint:
- `scripts/start-fly.sh`
- initializes and starts Postgres and Redis on localhost
- runs DB migrations
- starts API + worker
- traps `SIGTERM`/`SIGINT` and shuts down all processes cleanly

5. Keep health probe on API:
- `GET /api/health` stays the liveness/readiness probe

## Phase 2: Fly app configuration for one machine

1. Add `fly.toml`:
- one process group only (`app`)
- single region (`primary_region`)
- HTTP service mapped to API `PORT`
- health checks to `/api/health`
- volume mount at `/data`
- `auto_stop_machines = "off"`
- `min_machines_running = 1`

2. Enforce machine count:
- after first deploy and each deploy, run `fly scale count app=1`
- verify with `fly scale show`

Notes:
- Fly can seed more than one machine on first deploy in some configurations; explicit `scale count` prevents drift.

## Phase 3: One-command deploy

1. Add root script:
- `pnpm deploy:fly`

2. Script behavior:
- `fly deploy --remote-only`
- `fly scale count app=1`
- `fly status`

3. Bootstrap command (one-time only):
- `fly launch --no-deploy` to create app + initial `fly.toml`

After bootstrap, regular deploys are always a single command:
- `pnpm deploy:fly`

The deployed app serves both:
- dashboard frontend at the Fly app URL
- API on the same origin under `/api`

## Phase 4: Secure manual/ops trigger endpoint

1. Add endpoint in API:
- `POST /api/ops/public-scan`

2. Auth and authorization:
- require `Authorization: Bearer <OPS_TRIGGER_TOKEN>`
- reject if token missing/invalid
- optional `X-Trigger-Actor` header for auditing

3. Payload:
- `owner`, `repo`, optional `maxOpenPrs`

4. Behavior:
- enqueue `public-pr-scan` job
- reuse idempotent job key strategy (`owner/repo/snapshot`)
- return accepted/enqueued response

5. Guardrails:
- default deny if `owner/repo` not in allowlist env var
- preserve quiet output policy (Check Run in app mode, no comment spam)

## Phase 5: Job execution via push and cron

Deployment model:
- manual deploy via Fly CLI (`pnpm deploy:fly` or `flyctl deploy`) from an authorized operator machine

Manual authorized trigger:
- call `POST https://<app>.fly.dev/api/ops/public-scan` with `Authorization: Bearer <OPS_TRIGGER_TOKEN>`
- helper command:
  - `FLY_APP_URL=https://<app>.fly.dev OPS_TRIGGER_TOKEN=<token> pnpm trigger:scan --owner <owner> --repo <repo>`

Scheduled cron trigger (Fly-native):
- create a scheduled Fly Machine that runs at the desired interval and calls the same endpoint
- use a small curl image and pass `OPS_TRIGGER_TOKEN` as a secret
- choose schedule granularity based on Fly supported intervals (`hourly|daily|weekly|monthly`)

Why this pattern:
- no GitHub Actions dependency
- one secured trigger path for both manual and scheduled runs
- app remains single-machine on Fly

## Phase 6: Secrets and configuration

Fly secrets:
- `GITHUB_MODE=public` (default mode for public scan workflow)
- `GITHUB_TOKEN` (optional but recommended for rate limits)
- `DASHBOARD_TOKEN`
- `OPS_TRIGGER_TOKEN`
- `PUBLIC_SCAN_ALLOWED_REPOS`

Only required when enabling GitHub App ingest (`GITHUB_MODE=app|hybrid`):
- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY_PEM`
- `GITHUB_WEBHOOK_SECRET`

Fly volume:
- `data` volume mounted to `/data` (required for persistence)

Frontend/API origin model in single-app mode:
- no separate dashboard host is required
- keep dashboard API calls same-origin (`/api`)
- `VITE_API_BASE_URL` should be unset in production unless intentionally overriding

## Rollout checklist

1. Create Fly app and set all required secrets.
2. Create `data` volume in the same region.
3. Deploy with `pnpm deploy:fly`.
4. Verify exactly one machine is running.
5. Verify `/api/health` and webhook endpoint are reachable.
6. Verify dashboard UI loads from the same Fly app URL.
7. Trigger one manual authorized scan and confirm enqueue.
8. Configure Fly scheduled trigger and wait one interval.
9. Verify scheduled run enqueues and processes successfully.

## Acceptance criteria

1. Deploy succeeds via single command: `pnpm deploy:fly`.
2. App runs with one Fly machine (`app=1`) after deploy.
3. Embedded Postgres and Redis start correctly in the same machine.
4. Dashboard frontend is served by the same Fly app (no separate frontend deployment).
5. Authorized manual trigger enqueues scan job.
6. Scheduled cron trigger enqueues scan job at configured interval.
7. Unauthorized token cannot trigger scan job.
8. Job processing remains idempotent and quiet by default.

## Risks and tradeoffs

1. Single machine is a single point of failure.
2. API, worker, dashboard, Postgres, and Redis share CPU/memory; large ingest bursts may impact latency.
3. Volume corruption/deletion loses local state; recovery is by re-ingest from GitHub.
4. Fly scheduler cadence is coarser than full cron expressions.

## Optional Fly-native scheduler alternative

If coarse scheduling is acceptable, Fly scheduled machines can be used instead of GitHub cron:
- `fly machine run --schedule hourly|daily|weekly|monthly`

Caveat:
- schedule timing is approximate and less flexible than cron expressions.

## References

- Fly deploy command: https://fly.io/docs/flyctl/deploy/
- Fly scale count behavior: https://fly.io/docs/launch/scale-count/
- Fly scheduled machines (`--schedule`): https://fly.io/docs/machines/flyctl/fly-machine-run/
- Fly task scheduling guide: https://fly.io/docs/blueprints/task-scheduling/
- Fly access tokens guidance: https://fly.io/docs/security/tokens/
