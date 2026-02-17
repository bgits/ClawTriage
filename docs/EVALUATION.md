# Evaluation

## Goals
- Keep automated output high precision
- Improve over time using maintainer feedback

## Dataset
Every maintainer decision becomes a labeled example:
- duplicate: true/false
- category: SAME_CHANGE / SAME_FEATURE / COMPETING / RELATED / NOT_RELATED
- base PR selection (if applicable)
- scope alignment decision (optional)

Store:
- pr_number, head_sha
- candidate_pr_number, candidate_head_sha
- evidence bundle
- final label

## Metrics
Two separate modes:

### Auto-actions (comments/labels)
- Precision must be extremely high (target ≥ 95%)
- Recall not required (silent failures acceptable)

### Dashboard suggestions
- Recall and ranking matter:
  - Top-5 hit rate: percentage of true duplicates that appear in top 5 suggestions
  - NDCG@K for ranking quality

## Threshold tuning
Start with conservative thresholds (precision-first).
Adjust using:
- confusion matrix from labeled examples
- per-directory thresholds (core paths stricter)
- per-channel caps (tests/docs caps)

## Regression tests
Add golden test cases:
- same patch, different tests
- same feature, different implementation
- massive tests boilerplate similarity (must not false-positive)
- agent metadata similarity (must not trigger)
