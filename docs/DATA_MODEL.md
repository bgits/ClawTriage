# Data Model (Postgres)

This schema is designed for:
- high-volume webhook ingest (idempotent)
- deterministic, versioned signatures
- fast candidate retrieval (indices, not table scans)
- explainable triage (evidence bundles stored)

Raw diffs/patches are **not required** to persist. Default is to store **derived** signatures + minimal metadata. Persisting raw patch text is optional.

---

## Design rules

1) **Everything is versioned**
- `signature_version`: bumps when normalization/tokenization changes
- `algorithm_version`: bumps when scoring/category logic changes
- `config_version`: bumps when thresholds/rules change

2) **Keys include `head_sha`**
PR analysis is tied to a specific PR head commit. Re-pushes must create a new analysis row.

3) **Precision-first**
Storing evidence is mandatory; acting publicly is optional and gated.

---

## Enums

### `pr_state`
- `OPEN`
- `CLOSED`
- `MERGED`

### `file_status`
- `ADDED`
- `MODIFIED`
- `REMOVED`
- `RENAMED`

### `file_channel`
- `PRODUCTION`
- `TESTS`
- `DOCS`
- `META`

### `triage_category`
- `SAME_CHANGE`
- `SAME_FEATURE`
- `COMPETING_IMPLEMENTATION`
- `RELATED`
- `NOT_RELATED`
- `UNCERTAIN`

### `analysis_status`
- `PENDING`
- `RUNNING`
- `DONE`
- `DEGRADED` (some signals missing; still produced output)
- `FAILED`

---

## Core tables

### 1) `github_installations`
Tracks GitHub App installations.

| column | type | notes |
|---|---:|---|
| `installation_id` | BIGINT | PK (GitHub installation id) |
| `account_login` | TEXT | org/user login |
| `account_type` | TEXT | `Organization` / `User` |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

Indexes:
- PK on `installation_id`
- index on `(account_login)`

---

### 2) `repositories`
Tracked repos under an installation.

| column | type | notes |
|---|---:|---|
| `repo_id` | BIGINT | PK (GitHub repo id) |
| `installation_id` | BIGINT | FK -> github_installations |
| `owner` | TEXT | |
| `name` | TEXT | |
| `default_branch` | TEXT | |
| `is_active` | BOOLEAN | disable without deleting |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

Constraints:
- unique `(owner, name)`

Indexes:
- PK on `repo_id`
- index on `(installation_id)`
- index on `(owner, name)`

---

### 3) `webhook_deliveries`
Idempotency log. Stores every delivery id and processing outcome.

| column | type | notes |
|---|---:|---|
| `delivery_id` | TEXT | PK (X-GitHub-Delivery) |
| `repo_id` | BIGINT | nullable for installation-level events |
| `event_name` | TEXT | e.g. `pull_request`, `issues` |
| `action` | TEXT | e.g. `opened`, `synchronize` |
| `payload_sha256` | TEXT | hash of raw payload for auditing |
| `received_at` | TIMESTAMPTZ | |
| `processed_at` | TIMESTAMPTZ | nullable |
| `status` | TEXT | `RECEIVED|PROCESSED|SKIPPED|FAILED` |
| `error` | TEXT | nullable |

Indexes:
- PK on `delivery_id`
- index on `(repo_id, received_at DESC)`

---

## Pull Requests

### 4) `pull_requests`
PR metadata and current state.

| column | type | notes |
|---|---:|---|
| `pr_id` | BIGINT | PK (GitHub pull request id) |
| `repo_id` | BIGINT | FK -> repositories |
| `number` | INT | PR number within repo |
| `state` | pr_state | |
| `is_draft` | BOOLEAN | |
| `title` | TEXT | |
| `body` | TEXT | optional; can be truncated |
| `author_login` | TEXT | nullable |
| `url` | TEXT | |
| `base_ref` | TEXT | base branch name |
| `base_sha` | TEXT | base commit sha |
| `head_ref` | TEXT | head branch name |
| `head_repo_full_name` | TEXT | fork or same repo |
| `head_sha` | TEXT | current PR head sha |
| `additions` | INT | |
| `deletions` | INT | |
| `changed_files` | INT | |
| `created_at` | TIMESTAMPTZ | from GitHub |
| `updated_at` | TIMESTAMPTZ | from GitHub |
| `closed_at` | TIMESTAMPTZ | nullable |
| `merged_at` | TIMESTAMPTZ | nullable |
| `last_ingested_delivery_id` | TEXT | last webhook processed |
| `last_analyzed_head_sha` | TEXT | head sha last analyzed |
| `last_analyzed_at` | TIMESTAMPTZ | |
| `analysis_status` | analysis_status | |
| `analysis_error` | TEXT | nullable |

Constraints:
- unique `(repo_id, number)`

Indexes:
- PK on `pr_id`
- index on `(repo_id, number)`
- index on `(repo_id, state, updated_at DESC)`
- index on `(repo_id, last_analyzed_at DESC)`

---

### 5) `pr_files`
Per-file change metadata for a specific PR head sha.

Key point: file list depends on `head_sha`. Keep it versioned by head.

| column | type | notes |
|---|---:|---|
| `repo_id` | BIGINT | |
| `pr_id` | BIGINT | FK -> pull_requests |
| `head_sha` | TEXT | |
| `path` | TEXT | current path |
| `previous_path` | TEXT | for renames |
| `status` | file_status | |
| `additions` | INT | |
| `deletions` | INT | |
| `patch_truncated` | BOOLEAN | GitHub patch can be truncated |
| `channel` | file_channel | computed classification |
| `detected_language` | TEXT | optional |
| `created_at` | TIMESTAMPTZ | |

Primary key:
- `(pr_id, head_sha, path)`

Indexes:
- index on `(repo_id, path)`
- index on `(repo_id, channel)`
- index on `(pr_id, head_sha, channel)`
- optional index on `(repo_id, path, channel)`

---

## Derived signatures (channelized)

### 6) `pr_channel_signatures`
One row per (PR, head_sha, channel, signature_version).

This is the core store for derived features. Keep it compact.

| column | type | notes |
|---|---:|---|
| `pr_id` | BIGINT | FK |
| `repo_id` | BIGINT | denormalize for indexing |
| `head_sha` | TEXT | |
| `channel` | file_channel | |
| `signature_version` | INT | normalization/tokenization version |
| `computed_at` | TIMESTAMPTZ | |
| `canonical_diff_hash` | TEXT | production only; nullable |
| `simhash64` | BIGINT | nullable |
| `minhash` | BYTEA | nullable; packed 128x uint32 recommended |
| `minhash_shingle_count` | INT | |
| `winnow_fingerprints` | BYTEA | nullable; packed uint64 list |
| `winnow_count` | INT | |
| `exports_json` | JSONB | production only; e.g. [{name, kind}] |
| `symbols_json` | JSONB | production only |
| `imports_json` | JSONB | production/tests; module specifiers |
| `test_intent_json` | JSONB | tests only; suite/test names, matchers, importsUnderTest |
| `doc_structure_json` | JSONB | docs only; headings, code fences, references |
| `size_metrics_json` | JSONB | optional; per-channel churn summary |
| `errors_json` | JSONB | parse/git failures for this channel |

Primary key:
- `(pr_id, head_sha, channel, signature_version)`

Indexes:
- index on `(repo_id, channel, computed_at DESC)`
- index on `(repo_id, pr_id, head_sha)`
- index on `(repo_id, canonical_diff_hash)` WHERE channel=PRODUCTION
- optional GIN on `exports_json` / `symbols_json` if you refuse separate index tables (not recommended for MVP)

Notes:
- Prefer explicit index tables for symbols/paths (below) over heavy JSONB GIN.

---

## Retrieval indices (fast candidate search)

### 7) `pr_changed_paths`
Precomputed path prefixes to avoid expensive LIKE queries.

| column | type | notes |
|---|---:|---|
| `repo_id` | BIGINT | |
| `pr_id` | BIGINT | |
| `head_sha` | TEXT | |
| `channel` | file_channel | |
| `path` | TEXT | |
| `dir_prefix_1` | TEXT | e.g. `src` |
| `dir_prefix_2` | TEXT | e.g. `src/compiler` |
| `dir_prefix_3` | TEXT | e.g. `src/compiler/parser` |
| `created_at` | TIMESTAMPTZ | |

Primary key:
- `(pr_id, head_sha, channel, path)`

Indexes:
- index on `(repo_id, path)` (exact path matches)
- index on `(repo_id, dir_prefix_2)` (most useful)
- index on `(repo_id, channel, dir_prefix_2)`
- index on `(repo_id, channel, created_at DESC)`

---

### 8) `pr_symbols`
Normalized symbols for production channel.

| column | type | notes |
|---|---:|---|
| `repo_id` | BIGINT | |
| `pr_id` | BIGINT | |
| `head_sha` | TEXT | |
| `symbol` | TEXT | function/class/type/etc |
| `kind` | TEXT | `decl` / `export` / `import` (or split tables) |
| `created_at` | TIMESTAMPTZ | |

Primary key:
- `(pr_id, head_sha, kind, symbol)`

Indexes:
- index on `(repo_id, kind, symbol)`
- index on `(repo_id, kind, symbol, created_at DESC)`
- index on `(repo_id, pr_id, head_sha)`

Use:
- candidate generation by shared exports/symbols/imports

---

## Similarity results

### 9) `pr_analysis_runs`
A run groups all computations for a PR head sha under a specific algorithm/config.

| column | type | notes |
|---|---:|---|
| `analysis_run_id` | UUID | PK |
| `repo_id` | BIGINT | |
| `pr_id` | BIGINT | |
| `head_sha` | TEXT | |
| `signature_version` | INT | |
| `algorithm_version` | INT | scoring logic version |
| `config_version` | INT | thresholds/rules version |
| `status` | analysis_status | |
| `started_at` | TIMESTAMPTZ | |
| `finished_at` | TIMESTAMPTZ | nullable |
| `degraded_reasons` | JSONB | nullable |
| `error` | TEXT | nullable |

Indexes:
- PK on `analysis_run_id`
- index on `(repo_id, pr_id, head_sha, started_at DESC)`

---

### 10) `pr_candidate_edges`
Pairwise comparisons (A is the analyzed PR head; B is a candidate PR head).

| column | type | notes |
|---|---:|---|
| `analysis_run_id` | UUID | FK -> pr_analysis_runs |
| `repo_id` | BIGINT | |
| `pr_id_a` | BIGINT | |
| `head_sha_a` | TEXT | |
| `pr_id_b` | BIGINT | |
| `head_sha_b` | TEXT | |
| `rank` | INT | 1..K |
| `category` | triage_category | |
| `final_score` | REAL | |
| `scores_json` | JSONB | per-signal numbers |
| `evidence_json` | JSONB | mandatory evidence bundle |
| `created_at` | TIMESTAMPTZ | |

Primary key:
- `(analysis_run_id, pr_id_b, head_sha_b)`

Indexes:
- index on `(repo_id, pr_id_a, head_sha_a)`
- index on `(repo_id, pr_id_b, head_sha_b)`
- index on `(repo_id, created_at DESC)`

Evidence bundle (minimum):
- overlapping production paths (top 10)
- overlapping exports/symbols (top 20)
- tests intent overlaps (top 10 suite/test names, matchers)
- docs overlaps (headings, code fence languages)
- all computed similarity values used for category decision

---

## Clusters + base inference (optional in MVP, required later)

### 11) `pr_clusters`
Cluster container.

| column | type | notes |
|---|---:|---|
| `cluster_id` | UUID | PK |
| `repo_id` | BIGINT | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |
| `algorithm_version` | INT | |
| `signature_version` | INT | |
| `state` | TEXT | `OPEN_ONLY` or `MIXED` |
| `summary_json` | JSONB | optional |

Indexes:
- index on `(repo_id, updated_at DESC)`

---

### 12) `pr_cluster_members`
Membership at a specific head sha.

| column | type | notes |
|---|---:|---|
| `cluster_id` | UUID | FK |
| `repo_id` | BIGINT | |
| `pr_id` | BIGINT | |
| `head_sha` | TEXT | |
| `role` | TEXT | `BASE_SUGGESTED|CANONICAL_SUGGESTED|MEMBER` |
| `created_at` | TIMESTAMPTZ | |

Primary key:
- `(cluster_id, pr_id, head_sha)`

Indexes:
- index on `(repo_id, pr_id)`
- index on `(repo_id, cluster_id)`

---

### 13) `pr_containment_edges`
Directed containment edges used for base inference.

| column | type | notes |
|---|---:|---|
| `repo_id` | BIGINT | |
| `cluster_id` | UUID | |
| `from_pr_id` | BIGINT | |
| `from_head_sha` | TEXT | |
| `to_pr_id` | BIGINT | |
| `to_head_sha` | TEXT | |
| `basis` | TEXT | `PROD_SHINGLES|PROD_WINNOW|PROD_SYMBOLS` |
| `containment` | REAL | 0..1 |
| `created_at` | TIMESTAMPTZ | |

Primary key:
- `(cluster_id, from_pr_id, from_head_sha, to_pr_id, to_head_sha, basis)`

Indexes:
- index on `(repo_id, cluster_id)`
- index on `(repo_id, from_pr_id)`
- index on `(repo_id, to_pr_id)`

---

## Maintainer feedback (training data)

### 14) `triage_feedback`
Human decisions, used for evaluation and tuning.

| column | type | notes |
|---|---:|---|
| `feedback_id` | UUID | PK |
| `repo_id` | BIGINT | |
| `pr_id` | BIGINT | |
| `head_sha` | TEXT | |
| `candidate_pr_id` | BIGINT | nullable |
| `candidate_head_sha` | TEXT | nullable |
| `decision` | TEXT | `DUPLICATE|SAME_FEATURE|COMPETING|RELATED|NOT_RELATED|OUT_OF_SCOPE|IN_SCOPE` |
| `base_pr_id` | BIGINT | nullable |
| `base_pr_number` | INT | nullable |
| `actor_login` | TEXT | |
| `notes` | TEXT | nullable |
| `created_at` | TIMESTAMPTZ | |

Indexes:
- index on `(repo_id, pr_id, created_at DESC)`
- index on `(repo_id, decision, created_at DESC)`

---

## Issues + embeddings (optional phases)

### 15) `issues`
| column | type | notes |
|---|---:|---|
| `issue_id` | BIGINT | PK (GitHub issue id) |
| `repo_id` | BIGINT | |
| `number` | INT | |
| `state` | TEXT | `OPEN|CLOSED` |
| `title` | TEXT | |
| `body` | TEXT | optional |
| `author_login` | TEXT | nullable |
| `url` | TEXT | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |
| `closed_at` | TIMESTAMPTZ | nullable |

Constraints:
- unique `(repo_id, number)`

Indexes:
- PK on `issue_id`
- index on `(repo_id, state, updated_at DESC)`

---

### 16) `embeddings` (pgvector optional)
If using pgvector, store vectors here.

| column | type | notes |
|---|---:|---|
| `embedding_id` | UUID | PK |
| `repo_id` | BIGINT | |
| `entity_type` | TEXT | `ISSUE|PR_SUMMARY|VISION_SECTION` |
| `entity_id` | TEXT | e.g. issue_id or pr_id:head_sha |
| `model` | TEXT | |
| `dims` | INT | |
| `vector` | VECTOR | pgvector column (dims fixed per row) |
| `content_sha256` | TEXT | dedupe/cache |
| `created_at` | TIMESTAMPTZ | |

Indexes:
- ivfflat/hnsw index on `vector` (pgvector)
- index on `(repo_id, entity_type, entity_id)`
- unique `(repo_id, entity_type, entity_id, model, content_sha256)`

---

## Config snapshots

### 17) `config_snapshots`
Persist the exact thresholds/rules used for a run.

| column | type | notes |
|---|---:|---|
| `config_version` | INT | PK |
| `repo_id` | BIGINT | nullable (global config if null) |
| `classification_rules_yaml` | TEXT | |
| `thresholds_yaml` | TEXT | |
| `created_at` | TIMESTAMPTZ | |
| `is_active` | BOOLEAN | |

Indexes:
- index on `(repo_id, is_active)`

---

## Notes on Redis vs Postgres for LSH
Recommended:
- Redis stores LSH buckets for speed.
- Postgres stores signatures; Redis buckets can be rebuilt from signatures if lost.
If you need durability for buckets, add:
- `lsh_bucket_entries(index_name, bucket_id, pr_id, head_sha, created_at)`
but expect it to grow quickly.

---

## Minimum viable subset (MVP)
To ship quickly, you can start with:
- repositories
- webhook_deliveries
- pull_requests
- pr_files
- pr_channel_signatures
- pr_changed_paths
- pr_symbols (at least exports + imports)
- pr_analysis_runs
- pr_candidate_edges
- triage_feedback (even if dashboard is minimal)

Everything else can be phased in.
