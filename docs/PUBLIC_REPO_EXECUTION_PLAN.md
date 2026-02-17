# Public Repo Execution Plan (PR-First)

This plan enables duplicate triage on a public GitHub repository without requiring GitHub App installation on that repository.

## Goals

- Analyze open pull requests in a public repo for likely duplicates.
- Preserve existing deterministic, evidence-first scoring behavior.
- Reuse production-first channelized similarity where production dominates and tests/docs are capped.
- Avoid GitHub write actions in public-read mode.

## Scope

In scope (PR-first):
- Public read-only ingest of open pull requests
- Idempotent PR-head processing
- Existing Phase 2 signature/scoring/evidence pipeline reuse
- Dashboard/API readout from stored results

Out of scope (later):
- Issue dedupe
- PR↔Issue linking
- Clusters/base inference
- LLM rerank

## Architecture Additions

1. Public scan command
- `pnpm public:scan --owner <owner> --repo <repo> [--limit N]`
- Enqueues one `public-pr-scan` job with snapshot metadata.

2. Public scan worker job (`public-pr-scan`)
- Fetch repository metadata from public GitHub REST API.
- Enumerate open PRs (number, id, head SHA).
- Upsert repository metadata in DB using a synthetic internal installation (`installation_id=0`).
- Enqueue per-PR ingest jobs keyed by `(repo_id, pr_id, head_sha)`.

3. Public PR ingest path (`ingest-pr` with `installationId=0`)
- Fetch full PR metadata/files/patch from public API.
- Reuse same classification, signature extraction, candidate generation, scoring, and evidence persistence.
- Disable GitHub Check Run publishing when processing in public-read mode.

## Data and Idempotency

- Scan job idempotency key:
- `public-pr-scan-<owner>-<repo>-<snapshot>`

- PR ingest job idempotency key:
- `ingest-pr-<repoId>-<prId>-<headSha>`

- Determinism keys (stored per run):
- `signature_version`
- `algorithm_version`
- `config_version`

- Re-runs:
- Same PR head SHA dedupes at queue/job-id level.
- New head SHA enqueues fresh analysis.

## Public-Read Authentication Model

- Preferred: optional `GITHUB_TOKEN` for higher rate limits.
- Fallback: unauthenticated public API requests (lower rate limits).
- No admin permission or app installation required for read-only analysis.

## Output Policy in Public Mode

- Persist analysis artifacts in Postgres:
- `pr_channel_signatures`, `pr_analysis_runs`, `pr_candidate_edges`.

- Do not publish GitHub Check Runs/comments/labels in public-read mode.
- Read results via existing queue endpoint and DB-backed dashboard routes.

## Rollout Steps

Phase A (implemented first)
1. Add public GitHub REST client and open-PR listing.
2. Add `public-pr-scan` job queue and CLI enqueue command.
3. Route public ingest through existing deterministic PR analyzer.
4. Guard output actions (skip check-run publish in public mode).

Phase B
1. Add scan summary reporting endpoint/CLI output.
2. Add repository-level backfill options (`--max-prs`, `--since`).
3. Add operational metrics (scanned PR count, failures by reason).

Phase C (issues)
1. Add public issue scan/ingest jobs.
2. Add issue duplicate heuristics, then optional embedding layer.

## Acceptance Criteria (PR-First)

1. Public scan executes without GitHub App installation on target repo.
2. Open PRs are ingested and processed for dedupe candidates.
3. Re-running scan does not duplicate same-head jobs.
4. Candidate edges always include evidence bundles.
5. Tests/docs overlap does not trigger duplicate decisions without production support.
6. No GitHub write action is attempted in public-read mode.

## Operational Notes

- For local use, keep secrets in `.env` only (never commit).
- `GITHUB_TOKEN` is optional but recommended for larger repositories.
- If running worker in public-only mode, App credentials may be placeholders as long as public mode jobs are used.
