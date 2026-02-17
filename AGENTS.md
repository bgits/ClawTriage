# AGENTS.md — ClawTriage (agent index + build rules)

This repo builds an automated triage system for GitHub PRs/issues:
- detect duplicate PRs (same change / same feature / competing implementations)
- infer base/original PR in a cluster
- reduce maintainer load without spamming comments
- handle the reality that tests/docs/agent metadata can be much larger than the feature

You are expected to follow this file as the entry point and use the referenced docs as the source of truth.

---

## Non‑negotiable constraints

1) **Channelized similarity (required)**
PRs must be treated as channels:
- production
- tests
- docs
- meta (agent exhaust)

Duplicate decisions must be **production-first** with caps so tests/docs never dominate.

2) **Never fetch contributor forks**
Use a **single upstream bare mirror** and fetch PR heads via `pull/<N>/head`.
Do not add fork remotes.

3) **Quiet by default**
Preferred output: **GitHub Check Run** + dashboard queue.
Comments/labels only for extremely high confidence cases and behind config flags.

4) **No LLM over raw diffs/tests**
If LLM is enabled, it only sees evidence bundles (extracted overlaps + short summaries), never full diffs.

5) **Determinism + versioning**
Signature computation must be deterministic and versioned.
Any change to normalization/tokenization requires bumping `signature_version` and documenting it.

---

## Document index (read in this order)

### Product + behavior
- `docs/REQUIREMENTS.md`
  - What the system must do, success metrics, constraints.
- `docs/ARCHITECTURE.md`
  - Component layout, data flow, git strategy, indices, output strategy.

### Algorithms (implementation must match this)
- `docs/ALGORITHMS.md`
  - Channel classification, production/test/doc signatures, scoring categories, base inference, rewrite mode.

### Data + API (implementation must match this)
- `docs/DATA_MODEL.md`
  - Postgres tables, keys, required indices, evidence bundle storage.
- `docs/API_SPEC.md`
  - Internal dashboard/ops endpoints and payload shapes.

### Build sequence + agent rules
- `docs/EXECUTION_PLAN.md`
  - Phased delivery plan and acceptance criteria.
- `docs/CODEX_GUIDE.md`
  - Strict implementation rules, what not to do, determinism requirements.
- `docs/GITHUB_APP_SETUP.md`
  - GitHub App permissions/events/auth and rate-limit/idempotency rules.

### Optional / later
- `docs/LLM_USAGE.md` and `docs/LLM_PROMPTS.md`
  - Only if/when LLM is enabled.

---

## What to build first (do not jump ahead)

### Phase 0–2 only (ship MVP dedupe quietly)
1) Repo scaffolding + docker compose + config loader
2) GitHub ingest (PR webhooks), idempotency, DB persistence
3) Channel classification + **production-only** duplicate detection:
   - canonical diff hash (exact dupes)
   - production MinHash + LSH (near dupes)
   - candidate generation (sublinear)
   - scoring for SAME_CHANGE
   - persist ranked candidates + evidence bundle
   - publish Check Run summary

Stop after Phase 2 unless explicitly asked to continue.

---

## Local development expectations (agent-friendly)

- Provide `docker-compose.yml` for Postgres + Redis.
- Provide `.env.example`.
- Provide `pnpm` scripts:
  - `pnpm dev` (api + worker)
  - `pnpm test`
  - `pnpm lint`
  - `pnpm db:migrate` (or equivalent)

---

## Evidence bundle requirement (mandatory)

For every suggested candidate edge, store evidence including:
- overlapping production paths (top N)
- overlapping exports/symbols/imports (top N)
- tests intent overlaps (top N suite/test names + matchers) when applicable
- docs overlaps (headings / code fence languages) when applicable
- the numeric similarity values used for the decision

If evidence is missing, the suggestion is invalid.

---

## Safety and security guardrails

- Do not execute untrusted code from PRs.
- Do not log secrets or raw full diff contents by default.
- Backoff/retry on GitHub rate limits.
- Processing must be idempotent (webhooks can be delivered multiple times).

---

## Output policy (default)

- Create/update a GitHub Check Run:
  - “No likely duplicates found” OR top 3–5 candidates with reasons + scores
- Do not comment unless:
  - exact production diff hash match OR extremely high-confidence SAME_CHANGE
  - and config enables comments

---

## If you must make a design choice not specified
- Prefer the simplest approach that preserves the constraints above.
- If you diverge from any doc, update the doc in the same PR and explain why.
