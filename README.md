<p align="center">
  <a href="https://clawtriage.fly.dev/"><strong>Latest Deployment: clawtriage.fly.dev</strong></a>
</p>

<p align="center">
  <a href="https://github.com/bgits/ClawTriage/actions/workflows/ci.yml">
    <img src="https://github.com/bgits/ClawTriage/actions/workflows/ci.yml/badge.svg?branch=main&event=push" alt="CI status" />
  </a>
</p>

# ClawTriage - Pull Request Deduplication

A GitHub App + worker pipeline that triages PRs and issues at scale:
- detects duplicate PRs (same change / same feature / competing implementations)
- detects duplicate issues and links PRs ↔ issues
- infers "base/original" PR inside a duplicate cluster
- assists maintainers with scope alignment against a vision document (assist-only)

## Why this exists
Large repos can accumulate thousands of open PRs/issues. Agentic coding increases volume and adds large tests/docs/metadata blobs that can drown naive diff similarity. This system treats a PR as multiple channels (production/tests/docs/meta) and scores duplicates using production-first signals.

## What it does (MVP)
- Ingest PR/issue events via GitHub webhooks
- Compute fast fingerprints:
  - exact canonical diff hash (production)
  - MinHash/LSH on diff token shingles (production)
  - TS symbol/export/import signatures (production)
  - test-intent signatures (tests): suite/test names, matchers, imports-under-test
  - doc structure signatures (docs): headings + code fence snippets
- Generate candidates using indices (LSH + file/path + symbol indices)
- Rank and label:
  - Same change (high-confidence dup)
  - Same feature (semantically same intent)
  - Competing implementation (same tests/spec, different code)
- Persist results and expose a maintainer-facing dashboard queue
- Optionally create a GitHub Check Run with a triage summary (preferred to noisy comments)

## Web dashboard
- Read-only maintainer UI lives in `apps/dashboard`
- Highlights:
  - most recent analyzed PR runs
  - derived potential duplicate sets (from latest candidate edges)
  - strongest evidence edges and direct PR links for quick human review
- Run locally with `pnpm dev` (API + worker + dashboard)

## Non-goals (initially)
- Auto-closing PRs/issues
- Auto-merging
- Full automated scope rejection (only suggestions)

## Quickstart (dev)
See docs/CODEX_GUIDE.md. Local dev uses docker-compose for Postgres + Redis.

Typical local flow:
1. `pnpm install`
2. `docker compose up -d`
3. `pnpm db:migrate`
4. `pnpm dev`

Dashboard auth behavior is controlled by:
- `DASHBOARD_AUTH_MODE=auto|required|disabled`
- `DASHBOARD_TOKEN=<token>`
- `OPS_TRIGGER_TOKEN=<token>` for `POST /api/ops/public-scan`
- `PUBLIC_SCAN_ALLOWED_REPOS=<owner/repo,...>` allowlist for ops-triggered scans
- `GITHUB_MODE=public|app|hybrid` (default `public`)

Dashboard repository behavior is controlled by:
- `VITE_DASHBOARD_REPO_ID=<repo_id>` (fixed repository id for single-repo dashboard view)
- `VITE_DASHBOARD_REPO_OWNER=<owner>` and `VITE_DASHBOARD_REPO_NAME=<name>` (optional display label)

## Fly deployment (single app)
- Build + run API, worker, dashboard, Postgres, and Redis from one Fly app/machine (`fly.toml` + `Dockerfile`)
- One-command deploy: `pnpm deploy:fly`
- Runtime entrypoint: `pnpm start:fly`
- Deploy manually with Fly CLI (`flyctl`) instead of CI deploy workflow.
- Default deploy path uses `GITHUB_MODE=public` and `GITHUB_TOKEN` (no GitHub App required).
- GitHub App credentials are only required if you enable `GITHUB_MODE=app|hybrid`.
- Manual authorized trigger command:
  - `FLY_APP_URL=https://<app>.fly.dev OPS_TRIGGER_TOKEN=<token> pnpm trigger:scan --owner <owner> --repo <repo>`
- Fly-native scheduled trigger can call the same endpoint at a chosen interval.
- Create a Fly volume named `data` and mount to `/data` for Postgres/Redis persistence.
- `docker-compose.yml` is local-development only; Fly does not run Docker Compose services.

## Repo structure (recommended)
- apps/
  - api/          webhook receiver + dashboard API
  - worker/       analysis pipeline + git mirror manager
  - dashboard/    web UI for recent runs and duplicate sets
- packages/
  - core/         signatures, scoring, classification
  - github/       GitHub API client + webhook types
  - storage/      DB models + migrations
  - llm/          (optional) evidence-bounded compare + summary
- config/
  - classification_rules.yaml
  - thresholds.yaml
- docs/
  - ARCHITECTURE.md
  - EXECUTION_PLAN.md
  - FLY_DEPLOYMENT_EXECUTION_PLAN.md
  - FLY_BEGINNER_DEPLOYMENT_GUIDE.md
  - REQUIREMENTS.md
  - ALGORITHMS.md
  - GITHUB_APP_SETUP.md
  - LLM_USAGE.md
  - EVALUATION.md
  - CODEX_GUIDE.md

## Operating principle
Precision > recall. The bot must be quiet unless confidence is high.
