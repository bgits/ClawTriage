DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pr_state') THEN
    CREATE TYPE pr_state AS ENUM ('OPEN', 'CLOSED', 'MERGED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'file_status') THEN
    CREATE TYPE file_status AS ENUM ('ADDED', 'MODIFIED', 'REMOVED', 'RENAMED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'file_channel') THEN
    CREATE TYPE file_channel AS ENUM ('PRODUCTION', 'TESTS', 'DOCS', 'META');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'triage_category') THEN
    CREATE TYPE triage_category AS ENUM (
      'SAME_CHANGE',
      'SAME_FEATURE',
      'COMPETING_IMPLEMENTATION',
      'RELATED',
      'NOT_RELATED',
      'UNCERTAIN'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'analysis_status') THEN
    CREATE TYPE analysis_status AS ENUM ('PENDING', 'RUNNING', 'DONE', 'DEGRADED', 'FAILED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id BIGINT PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS github_installations_account_login_idx
  ON github_installations (account_login);

CREATE TABLE IF NOT EXISTS repositories (
  repo_id BIGINT PRIMARY KEY,
  installation_id BIGINT NOT NULL REFERENCES github_installations (installation_id),
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner, name)
);

CREATE INDEX IF NOT EXISTS repositories_installation_id_idx
  ON repositories (installation_id);

CREATE INDEX IF NOT EXISTS repositories_owner_name_idx
  ON repositories (owner, name);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  repo_id BIGINT,
  event_name TEXT NOT NULL,
  action TEXT,
  payload_sha256 TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_repo_received_idx
  ON webhook_deliveries (repo_id, received_at DESC);

CREATE TABLE IF NOT EXISTS pull_requests (
  pr_id BIGINT PRIMARY KEY,
  repo_id BIGINT NOT NULL REFERENCES repositories (repo_id),
  number INT NOT NULL,
  state pr_state NOT NULL,
  is_draft BOOLEAN NOT NULL DEFAULT FALSE,
  title TEXT NOT NULL,
  body TEXT,
  author_login TEXT,
  url TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  head_repo_full_name TEXT,
  head_sha TEXT NOT NULL,
  additions INT NOT NULL DEFAULT 0,
  deletions INT NOT NULL DEFAULT 0,
  changed_files INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  merged_at TIMESTAMPTZ,
  last_ingested_delivery_id TEXT,
  last_analyzed_head_sha TEXT,
  last_analyzed_at TIMESTAMPTZ,
  analysis_status analysis_status NOT NULL DEFAULT 'PENDING',
  analysis_error TEXT,
  UNIQUE (repo_id, number)
);

CREATE INDEX IF NOT EXISTS pull_requests_repo_number_idx
  ON pull_requests (repo_id, number);

CREATE INDEX IF NOT EXISTS pull_requests_repo_state_updated_idx
  ON pull_requests (repo_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS pull_requests_repo_last_analyzed_idx
  ON pull_requests (repo_id, last_analyzed_at DESC);

CREATE TABLE IF NOT EXISTS pr_files (
  repo_id BIGINT NOT NULL,
  pr_id BIGINT NOT NULL REFERENCES pull_requests (pr_id),
  head_sha TEXT NOT NULL,
  path TEXT NOT NULL,
  previous_path TEXT,
  status file_status NOT NULL,
  additions INT NOT NULL DEFAULT 0,
  deletions INT NOT NULL DEFAULT 0,
  patch_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  channel file_channel NOT NULL,
  detected_language TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pr_id, head_sha, path)
);

CREATE INDEX IF NOT EXISTS pr_files_repo_path_idx
  ON pr_files (repo_id, path);

CREATE INDEX IF NOT EXISTS pr_files_repo_channel_idx
  ON pr_files (repo_id, channel);

CREATE INDEX IF NOT EXISTS pr_files_pr_head_channel_idx
  ON pr_files (pr_id, head_sha, channel);

CREATE INDEX IF NOT EXISTS pr_files_repo_path_channel_idx
  ON pr_files (repo_id, path, channel);

CREATE TABLE IF NOT EXISTS pr_channel_signatures (
  pr_id BIGINT NOT NULL REFERENCES pull_requests (pr_id),
  repo_id BIGINT NOT NULL,
  head_sha TEXT NOT NULL,
  channel file_channel NOT NULL,
  signature_version INT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  canonical_diff_hash TEXT,
  simhash64 BIGINT,
  minhash BYTEA,
  minhash_shingle_count INT NOT NULL DEFAULT 0,
  winnow_fingerprints BYTEA,
  winnow_count INT NOT NULL DEFAULT 0,
  exports_json JSONB,
  symbols_json JSONB,
  imports_json JSONB,
  test_intent_json JSONB,
  doc_structure_json JSONB,
  size_metrics_json JSONB,
  errors_json JSONB,
  PRIMARY KEY (pr_id, head_sha, channel, signature_version)
);

CREATE INDEX IF NOT EXISTS pr_channel_signatures_repo_channel_computed_idx
  ON pr_channel_signatures (repo_id, channel, computed_at DESC);

CREATE INDEX IF NOT EXISTS pr_channel_signatures_repo_pr_head_idx
  ON pr_channel_signatures (repo_id, pr_id, head_sha);

CREATE INDEX IF NOT EXISTS pr_channel_signatures_prod_hash_idx
  ON pr_channel_signatures (repo_id, canonical_diff_hash)
  WHERE channel = 'PRODUCTION';

CREATE TABLE IF NOT EXISTS pr_changed_paths (
  repo_id BIGINT NOT NULL,
  pr_id BIGINT NOT NULL,
  head_sha TEXT NOT NULL,
  channel file_channel NOT NULL,
  path TEXT NOT NULL,
  dir_prefix_1 TEXT,
  dir_prefix_2 TEXT,
  dir_prefix_3 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pr_id, head_sha, channel, path)
);

CREATE INDEX IF NOT EXISTS pr_changed_paths_repo_path_idx
  ON pr_changed_paths (repo_id, path);

CREATE INDEX IF NOT EXISTS pr_changed_paths_repo_dir2_idx
  ON pr_changed_paths (repo_id, dir_prefix_2);

CREATE INDEX IF NOT EXISTS pr_changed_paths_repo_channel_dir2_idx
  ON pr_changed_paths (repo_id, channel, dir_prefix_2);

CREATE INDEX IF NOT EXISTS pr_changed_paths_repo_channel_created_idx
  ON pr_changed_paths (repo_id, channel, created_at DESC);

CREATE TABLE IF NOT EXISTS pr_symbols (
  repo_id BIGINT NOT NULL,
  pr_id BIGINT NOT NULL,
  head_sha TEXT NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pr_id, head_sha, kind, symbol)
);

CREATE INDEX IF NOT EXISTS pr_symbols_repo_kind_symbol_idx
  ON pr_symbols (repo_id, kind, symbol);

CREATE INDEX IF NOT EXISTS pr_symbols_repo_kind_symbol_created_idx
  ON pr_symbols (repo_id, kind, symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS pr_symbols_repo_pr_head_idx
  ON pr_symbols (repo_id, pr_id, head_sha);

CREATE TABLE IF NOT EXISTS pr_analysis_runs (
  analysis_run_id UUID PRIMARY KEY,
  repo_id BIGINT NOT NULL,
  pr_id BIGINT NOT NULL,
  head_sha TEXT NOT NULL,
  signature_version INT NOT NULL,
  algorithm_version INT NOT NULL,
  config_version INT NOT NULL,
  status analysis_status NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  degraded_reasons JSONB,
  error TEXT
);

CREATE INDEX IF NOT EXISTS pr_analysis_runs_repo_pr_head_started_idx
  ON pr_analysis_runs (repo_id, pr_id, head_sha, started_at DESC);

CREATE TABLE IF NOT EXISTS pr_candidate_edges (
  analysis_run_id UUID NOT NULL REFERENCES pr_analysis_runs (analysis_run_id) ON DELETE CASCADE,
  repo_id BIGINT NOT NULL,
  pr_id_a BIGINT NOT NULL,
  head_sha_a TEXT NOT NULL,
  pr_id_b BIGINT NOT NULL,
  head_sha_b TEXT NOT NULL,
  rank INT NOT NULL,
  category triage_category NOT NULL,
  final_score REAL NOT NULL,
  scores_json JSONB NOT NULL,
  evidence_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (analysis_run_id, pr_id_b, head_sha_b)
);

CREATE INDEX IF NOT EXISTS pr_candidate_edges_repo_a_idx
  ON pr_candidate_edges (repo_id, pr_id_a, head_sha_a);

CREATE INDEX IF NOT EXISTS pr_candidate_edges_repo_b_idx
  ON pr_candidate_edges (repo_id, pr_id_b, head_sha_b);

CREATE INDEX IF NOT EXISTS pr_candidate_edges_repo_created_idx
  ON pr_candidate_edges (repo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS triage_feedback (
  feedback_id UUID PRIMARY KEY,
  repo_id BIGINT NOT NULL,
  pr_id BIGINT NOT NULL,
  head_sha TEXT NOT NULL,
  candidate_pr_id BIGINT,
  candidate_head_sha TEXT,
  decision TEXT NOT NULL,
  base_pr_id BIGINT,
  base_pr_number INT,
  actor_login TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS triage_feedback_repo_pr_created_idx
  ON triage_feedback (repo_id, pr_id, created_at DESC);

CREATE INDEX IF NOT EXISTS triage_feedback_repo_decision_created_idx
  ON triage_feedback (repo_id, decision, created_at DESC);

CREATE TABLE IF NOT EXISTS config_snapshots (
  config_version INT PRIMARY KEY,
  repo_id BIGINT,
  classification_rules_yaml TEXT NOT NULL,
  thresholds_yaml TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS config_snapshots_repo_active_idx
  ON config_snapshots (repo_id, is_active);
