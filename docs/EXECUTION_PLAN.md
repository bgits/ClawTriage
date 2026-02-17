# Execution Plan

This plan is ordered to produce a useful system quickly without building unnecessary complexity upfront.

## Phase 0 — Repo scaffolding (0)
Deliverables:
- monorepo structure
- docker-compose (postgres + redis)
- basic API + worker apps
- DB migrations framework
- typed config loader (classification_rules.yaml, thresholds.yaml)

Acceptance:
- `pnpm dev` starts API + worker + dashboard
- can enqueue a dummy job and persist a row in Postgres

## Phase 1 — GitHub ingest (PRs) + storage
Build:
- GitHub App webhook receiver (pull_request events)
- installation token auth
- PR metadata fetch (GraphQL) and patch fetch (REST)
- persist:
  - PR record (repo_id, pr_number, base_sha, head_sha, title/body)
  - file list + statuses (added/modified/removed/renamed)

Acceptance:
- Open/sync a PR triggers ingest job
- PR files and patch metadata stored
- idempotency works (repeat webhook causes no duplicates)

## Phase 2 — Channel classification + production-only duplicate detection (MVP value)
Build:
- file classification using rules.yaml
- production canonical diff hash
- production MinHash/LSH (redis buckets)
- candidate generation + scoring for SAME_CHANGE
- store results: ranked candidates + evidence

Output:
- GitHub Check Run with summary:
  - "Possible duplicates" list + reasons (files overlap, similarity)
- no comments yet (unless exact diff hash match and configured)

Acceptance:
- Known duplicate PRs are detected
- Tests/docs-heavy PRs do not create noise

## Phase 2.5 — Web dashboard for recent runs + duplicate sets (read-only)
Build:
- dashboard web app (`apps/dashboard`, React + Vite)
- dashboard API read endpoints:
  - `GET /api/repos`
  - `GET /api/repos/:repoId/triage-queue` (with `orderBy` and richer fields)
  - `GET /api/repos/:repoId/prs/:prNumber`
  - `GET /api/repos/:repoId/prs/:prNumber/candidates`
  - `GET /api/repos/:repoId/duplicate-sets`
- duplicate-set derivation from latest candidate edges (connected components over filtered edges)
- direct PR links for fast human review in every panel
- dashboard auth mode switch (`DASHBOARD_AUTH_MODE=auto|required|disabled`)

Acceptance:
- Maintainer can select a repo and view recent run outcomes without leaving the dashboard
- Duplicate sets are human-readable (members + strongest evidence edges + scores)
- Every surfaced PR/candidate is directly linkable to GitHub
- No write actions are added (read-only only)
- Existing quiet output policy remains unchanged (Check Runs preferred)

## Phase 3 — TypeScript semantic signatures (same-feature)
Build:
- local bare mirror repo
- PR head fetch: `git fetch origin pull/N/head:refs/pr/N`
- TS parse for changed production files:
  - changed symbols
  - changed exports
  - changed imports
- integrate into scoring + evidence
- symbol/export indices for faster candidates

Acceptance:
- PRs implementing same feature with different code start clustering
- false positives remain low

## Phase 4 — Test-intent and docs structure signatures (competing impl detection)
Build:
- AST extraction for test names + matchers + imports-under-test
- docs headings/code block extraction
- dedicated LSH indices for test intent
- scoring rule for COMPETING_IMPLEMENTATION

Acceptance:
- Same tests/spec but different production code is flagged as competing, not duplicate
- Boilerplate tests similarity does not dominate

## Phase 5 — Base/original inference + cluster UI
Build:
- cluster builder (connected components over edges above threshold)
- containment DAG + base inference
- dashboard endpoints:
  - list clusters
  - show evidence + suggested base/canonical
  - record maintainer decisions

Acceptance:
- Maintainer can quickly pick base PR and mark others dup/competing
- Decisions are persisted for evaluation

## Phase 6 — Issue dedupe + PR↔Issue linking (optional next)
Build:
- issue ingest webhooks
- embeddings (pgvector) for issues
- PR structured summaries (non-LLM or optional LLM)
- link suggestions

Acceptance:
- Duplicate issues suggested in dashboard
- PRs show likely related issues

## Phase 7 — Vision alignment assist (optional)
Build:
- vision doc loader + excerpt index
- policy-as-code flags (paths/deps/size)
- optional LLM alignment (evidence bounded)
- dashboard + check run summary additions

Acceptance:
- Maintainers see scope risk reasons
- No auto-reject

## Phase 8 — Hardening
Build:
- rate limit handling
- backfill jobs
- metrics + alerts
- regression suite with golden cases

Acceptance:
- stable under event bursts
- reproducible scoring (deterministic signatures)
