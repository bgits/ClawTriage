# LLM Usage (Optional, Evidence-Bounded)

LLMs are useful for:
- disambiguating SAME_FEATURE vs RELATED when syntactic signals disagree
- generating maintainer-facing explanations and suggested replies
They are NOT used for:
- initial candidate generation
- processing raw huge diffs/tests (too expensive and noisy)

## Guardrails
- LLM input must be evidence-bounded:
  - titles/bodies
  - extracted signatures and overlaps
  - small curated snippets (only if necessary)
- The model must cite evidence fields. If it can't, output is "UNCERTAIN".
- Never auto-comment based only on LLM output.

## When to call LLM
Trigger only if:
- candidate set contains at least 1 item above a medium threshold
- but rule-based category is ambiguous between SAME_FEATURE / COMPETING / RELATED
- and PR is high-impact (touches core paths, big change) OR maintainer requested

Hard caps:
- topK candidates = 3 (config)
- max tokens per call (config)

## Prompts
See docs/LLM_PROMPTS.md.

## Outputs
LLM returns JSON:
- classification: SAME_CHANGE | SAME_FEATURE | COMPETING_IMPLEMENTATION | RELATED | NOT_RELATED | UNCERTAIN
- base_pr_number (optional)
- confidence (0..1)
- rationale: list of bullet points referencing evidence fields
- suggested_maintainer_note (optional)

## Cost controls
- Cache LLM results by (pr_number, head_sha, candidate_pr_number, candidate_head_sha)
- Skip LLM if:
  - prod_diff_exact match exists
  - prodScore is clearly below relevance threshold
