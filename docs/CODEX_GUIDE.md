# Codex Build Guide (Do This Exactly)

This file is instructions for an implementation agent to build ClawTriage without thrashing.

## Ground rules
- Implement in TypeScript (Node 20+).
- Use the git CLI, not a fragile git library, for mirror/fetch/diff.
- Separate pure logic (signatures/scoring) from I/O (GitHub/db/git).
- Every computed suggestion must include an evidence bundle.
- Default behavior must be quiet (Check Runs + dashboard); avoid comments.
- Documentation safety rule: never include identifying local paths, usernames, machine hostnames, private repo/org names, tokens, or secrets in docs/examples. Use repo-relative paths and placeholders (for example `apps/api/src/index.ts`, `<your-app-name>`, `<owner>/<repo>`).

## Deliverables checklist (by phase)
Phase 0:
- repo scaffolding + docker compose + config loader

Phase 1:
- GitHub webhook receiver with signature verification
- installation token auth
- PR ingest job writes to DB

Phase 2:
- classification rules + production canonical diff hash
- MinHash + LSH index (Redis) + candidate search
- store similarity edges + evidence
- publish Check Run summary

Phase 3:
- bare mirror + fetch PR head refs
- TS parse + symbol/export/import extraction
- integrate scoring

Phase 4:
- test-intent extraction + LSH
- docs extraction

Phase 5:
- cluster + base inference + dashboard endpoints

## Local dev commands (recommended)
- `pnpm i`
- `docker compose up -d`
- `pnpm db:migrate`
- `pnpm dev`

## Coding standards
- TypeScript strict mode ON.
- No dynamic `any` in core logic.
- Unit tests for:
  - classification edge cases
  - canonical diff normalization
  - minhash + LSH correctness (determinism)
  - TS symbol extraction on fixtures
  - test-intent extraction on fixtures
  - scoring category rules

## Determinism requirements
- MinHash must be deterministic: fixed seed + fixed hash functions.
- Normalization must be deterministic and versioned:
  - store signature_version in DB
  - changing normalization rules bumps version and triggers recompute

## Error handling
- GitHub API:
  - retry on 502/503
  - backoff on rate limit
- git fetch failures:
  - mark analysis degraded; fall back to patch-based features
- TS parse errors:
  - record error; continue with diff-based signals

## What not to do
- Do NOT process raw full diffs with LLMs.
- Do NOT auto-close PRs or issues.
- Do NOT fetch contributor forks directly.
- Do NOT let test/doc/meta channels trigger duplicates alone.

## Acceptance criteria for "MVP shipped"
- New PR gets a Check Run with up to 5 likely duplicates (or "none found") within reasonable time.
- Duplicate PRs (same change) are correctly flagged with high confidence.
- Tests-heavy PRs do not cause noise.
- System remains stable under repeated webhook deliveries (idempotent).
