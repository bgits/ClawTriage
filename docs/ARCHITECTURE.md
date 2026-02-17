# Architecture

## Overview
ClawTriage is a GitHub App + event-driven analysis pipeline. It ingests PR/issue events, computes multi-channel signatures, searches for likely duplicates using indices (LSH + symbol/path indices), ranks results, optionally runs evidence-bounded LLM comparisons, then publishes a quiet output (Check Run + dashboard queue; minimal commenting).

### Key constraint
PRs frequently include:
- large tests (new files; larger than feature)
- docs
- agent metadata dumps
Therefore: similarity is computed per channel and aggregated with caps so tests/docs cannot drown production signals.

## Components

### 1) GitHub App (Webhook Receiver) - `apps/api`
Responsibilities:
- Receive webhooks (PR, issue, push optional)
- Verify signatures (HMAC)
- Normalize events into jobs (ingest PR/issue, re-score, backfill)
- Provide admin/dashboard API endpoints (auth gated)

Outputs:
- Enqueue jobs to Redis (BullMQ / similar)
- Store event receipt for idempotency (delivery_id)

### 2) Worker / Analyzer - `apps/worker`
Responsibilities:
- Fetch PR/issue data from GitHub API (GraphQL + REST)
- Manage local bare git mirror of upstream repo
- Compute signatures:
  - production: diff hash, minhash, simhash, TS symbols/exports/imports
  - tests: test-intent signature
  - docs: structural signature
  - meta: ignored or minimal extraction
- Candidate generation:
  - LSH indices (MinHash/SimHash)
  - path index (files/dirs)
  - symbol/export index
  - embedding index (issues + PR summaries)
- Scoring and clustering:
  - pairwise scoring for candidates
  - cluster detection + base inference (containment DAG)
- Output actions:
  - store top ranked candidates
  - optionally create GitHub Check Run summary
  - optionally apply labels/comments (high confidence only)

### 3) Storage - `packages/storage`
Recommended:
- Postgres for durable storage (metadata, signatures, results, feedback)
- Redis for:
  - job queue
  - LSH buckets / fast ephemeral indices (optional; can also be Postgres)

Optional:
- pgvector extension for embeddings (issues + PR structured summaries)

### 4) Dashboard (optional early; recommended)
- Minimal UI for maintainers:
  - list "triage queue" items (new PRs with suggestions)
  - show evidence and suggested actions
  - allow mark: duplicate, not duplicate, base PR, out of scope, etc.
These decisions feed back into thresholds and evaluation.

## Data flow (PR event)

1. Webhook: pull_request.opened / synchronize / edited
2. API enqueues `ingest_pr(pr_number)`
3. Worker:
   - fetch PR metadata (GraphQL)
   - fetch patch/diff (REST)
   - classify files into channels (rules + TS AST)
   - compute channel signatures
   - update indices
   - generate candidate PRs from indices
   - compute similarity scores (cheap first)
   - if needed, fetch PR refs to bare clone and compute AST features (TS)
   - if still ambiguous, run LLM compare for top K (optional)
   - persist results, cluster assignments, base inference
   - publish Check Run summary (preferred) and optionally label/comment if high confidence
4. Dashboard shows PR in queue with ranked candidates and evidence.

## Git strategy (fork-safe)
Avoid cloning forks.
Maintain one bare mirror of upstream:
- `git clone --mirror git@github.com:<owner>/<repo>.git repos/<repo>.git`
For a PR number N:
- `git fetch origin pull/N/head:refs/pr/N`
This fetches PR head even if it comes from a fork.

Use local git to:
- compute diffs when patch content is missing/too large
- map changed line ranges to file contents for AST parsing
- run `git diff --find-renames` to detect rewrite/move situations

## Channel model

Every file change is assigned to exactly one channel:
- production
- tests
- docs
- meta (agent exhaust)

Rules are configured in `config/classification_rules.yaml`, refined by content/AST.

Signatures are computed per channel. Aggregation is production-first with caps:
- production dominates duplicate decision
- tests/docs rerank and explain intent
- meta is ignored or only used as a tie-breaker explanation signal

## Indices

### LSH indices
- production MinHash LSH: candidate generation for near-duplicate code changes
- tests intent MinHash LSH: candidate generation for same-spec tests
- optional SimHash buckets for ultra-cheap approximate retrieval

Implementation options:
- Redis sets keyed by bucket id
- Postgres table `(bucket_id, pr_id)` with hash index

### Symbol/export index
- map `exported_symbol -> PR ids (recent + open)` for fast retrieval

### Path index
- map `file_path` and `dir_prefix` -> PR ids

### Embedding index (optional initially)
- vector index for issue dedupe and PR summary similarity
- store embeddings in pgvector

## Scoring + decision policy

Compute pairwise score S(A,B) using channel scores:
- production signals:
  - exact diff hash match -> auto duplicate
  - minhash similarity
  - file overlap
  - TS symbols/exports/imports overlap
- tests signals:
  - test-intent similarity (names/matchers/imports)
- docs signals:
  - heading/code-block similarity
- meta:
  - ignored by default

Decision categories:
- SAME_CHANGE (very high confidence): auto label/check; optional comment
- SAME_FEATURE (high confidence): dashboard + check summary; no comment by default
- COMPETING_IMPLEMENTATION: dashboard suggestion; explicitly not "duplicate"
- RELATED / NOT_RELATED

Base/original inference:
- Build containment DAG using production change set containment
- Choose root(s) as base candidates
- Choose canonical PR separately (CI green, approvals, smaller conflicts)

## Output mechanisms

Preferred:
- GitHub Check Runs (non-noisy; visible in PR UI)
Optional:
- Labels (e.g., `triage:possible-duplicate`, `triage:competing`)
- Comment (only for SAME_CHANGE with very high confidence; configurable)

## Observability
- Job timing metrics (ingest, signature, candidate, scoring, actions)
- Error classification (rate limit, network, parse failure, git fetch failure)
- Sampling logs, with redaction for patch content

## Security boundaries
- GitHub App private key stored in secret manager
- Worker has outbound internet access to GitHub only (ideal)
- No untrusted code execution from PR content (do not run tests/build from forks)
