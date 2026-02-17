# Implementation Plan (Phase 0-2 Only)

This plan expands `docs/EXECUTION_PLAN.md` into concrete implementation work for the MVP duplicate triage pipeline only.

## Scope Boundaries

Included:
- Phase 0: scaffolding, config, local infra, migration runner
- Phase 1: GitHub PR webhook ingest, idempotency, queueing, PR/file persistence
- Phase 2: channel classification + production-first duplicate detection + evidence + Check Run output

Excluded:
- cluster/base inference tables usage
- issue dedupe, embeddings, LLM workflows
- auto comments/labels by default

## Step-by-Step Checklist

## Phase 0 Checklist

- [ ] Create monorepo workspace and package manifests
- [ ] Create package folders: `apps/api`, `apps/worker`, `packages/core`, `packages/github`, `packages/storage`
- [ ] Add root scripts: `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm db:migrate`
- [ ] Add TypeScript strict config shared across workspaces
- [ ] Add `docker-compose.yml` with Postgres + Redis
- [ ] Add `.env.example` with required runtime variables
- [ ] Implement typed YAML config loader for:
  - `config/classification_rules.yaml`
  - `config/thresholds.yaml`
- [ ] Implement DB migration runner and initial schema migration
- [ ] Verify local bootstrap:
  - `pnpm install`
  - `pnpm lint`
  - `pnpm test`

## Phase 1 Checklist

- [ ] Implement `POST /webhooks/github` in `apps/api`
- [ ] Verify `X-Hub-Signature-256` signature (HMAC SHA-256)
- [ ] Store webhook delivery in idempotency table (`webhook_deliveries`)
- [ ] Enforce delivery idempotency on `delivery_id` (skip duplicates)
- [ ] Upsert installation and repository metadata
- [ ] Enqueue ingest job to Redis/BullMQ (`ingest-pr`)
- [ ] Implement worker `ingest-pr` job handler
- [ ] Fetch PR metadata + changed files + patch via GitHub API
- [ ] Upsert `pull_requests` row for current `head_sha`
- [ ] Replace `pr_files` rows for `(pr_id, head_sha)`
- [ ] Maintain ingest status transitions (`RECEIVED -> PROCESSED/SKIPPED/FAILED`)

## Phase 2 Checklist

- [ ] Classify files into channels (`PRODUCTION`, `TESTS`, `DOCS`, `META`) from rules YAML
- [ ] Compute production canonical diff hash from normalized production patch lines
- [ ] Compute deterministic production MinHash signature
- [ ] Write production LSH buckets to Redis and query candidate buckets
- [ ] Generate candidates from:
  - production exact hash matches
  - production LSH buckets
  - production path overlap index (`pr_changed_paths`)
  - production symbol overlap index (`pr_symbols`)
- [ ] Score candidates using production-first rules with test/doc caps
- [ ] Apply conservative SAME_CHANGE classification thresholds
- [ ] Persist run + ranked edges + evidence bundles:
  - `pr_analysis_runs`
  - `pr_candidate_edges`
- [ ] Persist channel signatures and retrieval indices:
  - `pr_channel_signatures`
  - `pr_changed_paths`
  - `pr_symbols`
- [ ] Publish quiet GitHub Check Run summary (no comments by default)
- [ ] Implement minimal queue read route for dashboard:
  - `GET /api/repos/:repoId/triage-queue`

## Exact Folders and Files

Created/maintained for Phase 0-2:

- Root
  - `package.json`
  - `pnpm-workspace.yaml`
  - `tsconfig.base.json`
  - `tsconfig.json`
  - `.env.example`
  - `docker-compose.yml`

- `apps/api`
  - `apps/api/package.json`
  - `apps/api/tsconfig.json`
  - `apps/api/src/index.ts`

- `apps/worker`
  - `apps/worker/package.json`
  - `apps/worker/tsconfig.json`
  - `apps/worker/src/index.ts`

- `packages/core`
  - `packages/core/package.json`
  - `packages/core/tsconfig.json`
  - `packages/core/src/index.ts`
  - `packages/core/src/types.ts`
  - `packages/core/src/constants.ts`
  - `packages/core/src/env.ts`
  - `packages/core/src/config.ts`
  - `packages/core/src/jobs.ts`
  - `packages/core/src/classification.ts`
  - `packages/core/src/diff.ts`
  - `packages/core/src/minhash.ts`
  - `packages/core/src/extractors.ts`
  - `packages/core/src/scoring.ts`
  - `packages/core/test/classification.test.ts`
  - `packages/core/test/diff.test.ts`
  - `packages/core/test/minhash.test.ts`

- `packages/github`
  - `packages/github/package.json`
  - `packages/github/tsconfig.json`
  - `packages/github/src/index.ts`
  - `packages/github/src/types.ts`
  - `packages/github/src/webhook.ts`
  - `packages/github/src/client.ts`

- `packages/storage`
  - `packages/storage/package.json`
  - `packages/storage/tsconfig.json`
  - `packages/storage/src/index.ts`
  - `packages/storage/src/types.ts`
  - `packages/storage/src/db.ts`
  - `packages/storage/src/migrate.ts`
  - `packages/storage/src/storage.ts`
  - `packages/storage/migrations/001_phase0_2.sql`

## DB Migration Plan (Phase 0-2)

Migration file: `packages/storage/migrations/001_phase0_2.sql`

## Enums
- `pr_state`
- `file_status`
- `file_channel`
- `triage_category`
- `analysis_status`

## Tables and Indexes

1. `github_installations`
- PK: `installation_id`
- Index: `(account_login)`

2. `repositories`
- PK: `repo_id`
- Unique: `(owner, name)`
- Indexes: `(installation_id)`, `(owner, name)`

3. `webhook_deliveries`
- PK: `delivery_id`
- Index: `(repo_id, received_at DESC)`

4. `pull_requests`
- PK: `pr_id`
- Unique: `(repo_id, number)`
- Indexes:
  - `(repo_id, number)`
  - `(repo_id, state, updated_at DESC)`
  - `(repo_id, last_analyzed_at DESC)`

5. `pr_files`
- PK: `(pr_id, head_sha, path)`
- Indexes:
  - `(repo_id, path)`
  - `(repo_id, channel)`
  - `(pr_id, head_sha, channel)`
  - `(repo_id, path, channel)`

6. `pr_channel_signatures`
- PK: `(pr_id, head_sha, channel, signature_version)`
- Indexes:
  - `(repo_id, channel, computed_at DESC)`
  - `(repo_id, pr_id, head_sha)`
  - partial `(repo_id, canonical_diff_hash)` where `channel='PRODUCTION'`

7. `pr_changed_paths`
- PK: `(pr_id, head_sha, channel, path)`
- Indexes:
  - `(repo_id, path)`
  - `(repo_id, dir_prefix_2)`
  - `(repo_id, channel, dir_prefix_2)`
  - `(repo_id, channel, created_at DESC)`

8. `pr_symbols`
- PK: `(pr_id, head_sha, kind, symbol)`
- Indexes:
  - `(repo_id, kind, symbol)`
  - `(repo_id, kind, symbol, created_at DESC)`
  - `(repo_id, pr_id, head_sha)`

9. `pr_analysis_runs`
- PK: `analysis_run_id`
- Index: `(repo_id, pr_id, head_sha, started_at DESC)`

10. `pr_candidate_edges`
- PK: `(analysis_run_id, pr_id_b, head_sha_b)`
- Indexes:
  - `(repo_id, pr_id_a, head_sha_a)`
  - `(repo_id, pr_id_b, head_sha_b)`
  - `(repo_id, created_at DESC)`

11. `triage_feedback` (created for forward compatibility; not required by Phase 0-2 runtime)
- PK: `feedback_id`
- Indexes:
  - `(repo_id, pr_id, created_at DESC)`
  - `(repo_id, decision, created_at DESC)`

12. `config_snapshots` (created for deterministic config versioning)
- PK: `config_version`
- Index: `(repo_id, is_active)`

## Minimal API Routes (Phase 0-2)

1. `GET /api/health`
- Response: `{ "ok": true }`
- Purpose: liveness for local/dev/probes

2. `GET /api/repos/:repoId/triage-queue`
- Query:
  - `state` (default `OPEN`)
  - `needsReview` (default `true`)
  - `limit` (default 50, max 200)
  - `cursor` (optional)
- Returns triage queue items with top candidate summary and `nextCursor`

3. `POST /webhooks/github` (ingest endpoint)
- Signature-verified webhook receiver
- Idempotent delivery handling + job enqueue

## Worker Job Types and Idempotency Keys

Job queue: `ingest-pr`

1. Job type: `ingest-pr`
- Payload:
  - `deliveryId`
  - `installationId`
  - `repoId`
  - `owner`
  - `repo`
  - `prNumber`
  - `prId`
  - `headSha`
  - `action`
- Idempotency key (BullMQ `jobId`):
  - `ingest-pr:<repoId>:<prId>:<headSha>`
- Rationale:
  - same PR head push dedupes retries/re-deliveries
  - new push (new `headSha`) creates a fresh ingest/analyze run

Webhook idempotency key:
- `webhook_deliveries.delivery_id` (`X-GitHub-Delivery`)

Analysis determinism keys stored per run:
- `signature_version`
- `algorithm_version`
- `config_version`

## Acceptance Tests by Phase

## Phase 0 Acceptance

1. Workspace bootstrap
- Run `pnpm install`
- Run `pnpm lint`
- Run `pnpm test`
- Expected: all succeed

2. Local infra
- Run `docker compose up -d`
- Expected: Postgres + Redis healthy/reachable

3. Migration
- Run `pnpm db:migrate`
- Expected: schema and indexes created; repeat run is no-op

## Phase 1 Acceptance

1. Webhook signature validation
- Send signed request to `POST /webhooks/github`
- Expected: accepted and delivery recorded

2. Delivery idempotency
- Replay same `X-GitHub-Delivery`
- Expected: second call returns duplicate/skip; no duplicate queue enqueue

3. Ingest persistence
- Trigger `pull_request` opened/synchronize event
- Expected:
  - `pull_requests` upserted with current `head_sha`
  - `pr_files` replaced for `(pr_id, head_sha)`

## Phase 2 Acceptance

1. Channel classification
- PR with production + tests + docs + meta files
- Expected: each file assigned one channel deterministically

2. Canonical diff determinism
- Same production patch input analyzed twice
- Expected: identical canonical diff hash

3. MinHash determinism
- Same production patch tokens analyzed twice
- Expected: identical 128-value signature + same LSH bucket IDs

4. Candidate generation and scoring
- Seed known duplicate PR pair
- Expected:
  - candidate appears in top results
  - conservative SAME_CHANGE threshold behavior respected

5. Evidence bundle persistence
- For each stored candidate edge, verify `evidence_json` includes:
  - overlapping production paths
  - overlapping exports/symbols/imports
  - tests/doc overlap sections (when applicable)
  - numeric similarity values used for decision

6. Quiet output policy
- After analysis, Check Run exists with summary
- No comment/label posted by default

7. Production-first guardrail
- Test/docs-heavy overlap without production overlap
- Expected: no SAME_CHANGE trigger from tests/docs alone
