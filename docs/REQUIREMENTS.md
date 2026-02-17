# Requirements

## Problem
Repository receives a very high volume of PRs/issues. Many PRs are duplicates:
- identical code change re-submitted from forks
- same feature implemented multiple ways
- same tests/spec submitted with different implementation
- large test/docs/agent-metadata additions overwhelm naive similarity

We need automated triage support that:
- reliably identifies duplicates with high precision
- suggests "base/original" PR within a cluster
- surfaces scope/vision mismatches as suggestions
- remains performant at thousands of open PRs

## Users
- Maintainers/triagers: need dedupe suggestions and "what to keep" guidance
- Contributors: benefit from early feedback ("similar PR exists") without spam
- Automation: optional checks/labels to reduce manual scanning

## Functional requirements

### PR ingest
- FR-PR-1: Ingest PR opened/synchronized/edited/reopened/closed events
- FR-PR-2: Fetch PR metadata: base sha, head sha, files changed, PR body/title
- FR-PR-3: Fetch PR patch/diff text
- FR-PR-4: Classify changed files into channels: production, tests, docs, meta

### PR duplicate detection
- FR-DUP-1: Detect exact duplicate changes (canonical diff hash; production-only)
- FR-DUP-2: Detect near-duplicate changes (MinHash/LSH; production-only)
- FR-DUP-3: Detect same-feature PRs (TS symbols/exports/imports + optional LLM rerank)
- FR-DUP-4: Detect competing implementations (high test-intent similarity + low production similarity)
- FR-DUP-5: Provide evidence for every suggestion (files overlap, symbol overlap, etc.)
- FR-DUP-6: Infer base/original PR in a cluster using containment on production change sets

### Issue dedupe + PR↔Issue link
- FR-ISS-1: Ingest issue opened/edited/reopened/closed events
- FR-ISS-2: Detect likely duplicate issues using embeddings + rerank
- FR-LINK-1: Suggest links between PRs and issues (PR summary embedding vs issue embedding)

### Vision/scope assist
- FR-VIS-1: Load a "vision document" (text/markdown) and optional scope rules (paths)
- FR-VIS-2: Produce assist-only scope alignment signal per PR (in-scope/out-of-scope/uncertain)
- FR-VIS-3: Provide explainable reasons (paths, exports, keywords, policy flags)

### Output/actions
- FR-ACT-1: Store ranked candidates and cluster assignments
- FR-ACT-2: Create a GitHub Check Run with a triage summary (preferred)
- FR-ACT-3: Optional comment/label only for high-confidence duplicates (configurable)
- FR-ACT-4: Provide a dashboard queue for maintainers to confirm/reject suggestions
- FR-ACT-5: Capture maintainer feedback as labels/training data

## Non-functional requirements

### Precision-first
- NFR-PREC-1: Must avoid noisy false positives. Default thresholds tuned for precision.
- NFR-PREC-2: Any automated public-facing action (comment/label) requires high confidence.

### Performance
Assume:
- ~3k+ open PRs
- frequent webhook events (synchronize pushes)
- patch sizes range from tiny to multi-thousand lines (tests/docs heavy)

- NFR-PERF-1: Typical PR ingest + scoring should finish in < 10s on commodity VM for small/medium PRs.
- NFR-PERF-2: Candidate generation must be sublinear (LSH / indices), not O(N) comparisons.
- NFR-PERF-3: Defer expensive analysis (git fetch, AST parse, LLM) to top-K candidates.

### Reliability
- NFR-REL-1: Idempotent processing: repeated webhook deliveries must not corrupt state.
- NFR-REL-2: Backoff and retry on GitHub API rate limiting.
- NFR-REL-3: Observability: structured logs, job metrics, error tracking.

### Security
- NFR-SEC-1: Use GitHub App auth; store private key securely.
- NFR-SEC-2: Never log tokens, private key material, or full patch content (configurable redaction).
- NFR-SEC-3: Principle of least privilege: read-only where possible; write only for checks/comments/labels if enabled.

### Data retention
- NFR-DATA-1: Store derived signatures + minimal metadata by default.
- NFR-DATA-2: Storing raw patch/diff text is optional and configurable (privacy/cost tradeoff).

## Success metrics (initial)
- SM-1: ≥ 80% of maintainer-confirmed duplicates are surfaced in top 5 suggestions (recall in review queue)
- SM-2: ≥ 95% precision for any auto-posted comment/label actions
- SM-3: Median webhook-to-result time under target (e.g., < 30s end-to-end with worker queue)
