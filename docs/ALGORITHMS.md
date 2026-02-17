# Algorithms

This doc defines the concrete algorithms used for dedupe and base inference, with special handling for large tests/docs/agent metadata.

## 1) File classification (channels)

### Path rules (fast)
Configured in `config/classification_rules.yaml`.

Examples:
- tests: `**/*.test.ts`, `**/*.spec.ts`, `**/__tests__/**`, `**/tests/**`, `**/fixtures/**`
- docs: `**/*.md`, `docs/**`
- meta: `.cursor/**`, `.aider/**`, `**/*trace*.*`, `**/*log*.*`, `**/*prompt*.*`
- production: default remainder

### Content/AST refinement (TypeScript)
If extension is `.ts/.tsx`:
- classify as tests if AST contains top-level calls to `describe/it/test` OR imports from known test frameworks
- else production

This prevents false production classification when tests live under src.

## 2) Production signatures (duplicate change + duplicate feature)

### 2.1 Canonical diff hash (exact duplicate change)
Input: unified diff for production files only.

Canonicalize:
- remove metadata lines: `diff --git`, `index`, `---`, `+++`, `@@` headers (keep file paths + actual +/− content)
- normalize whitespace (optional; default conservative)
- remove comment-only hunks (optional; off by default to avoid false positives)

Hash: SHA-256 over canonical text.

Decision:
- if hash matches prior PR hash -> SAME_CHANGE (auto)

### 2.2 MinHash on diff token shingles (near duplicate change)
Input: production diff +/− lines.

Steps:
1. Extract added/removed lines (ignore context).
2. Normalize:
   - trim
   - collapse whitespace
   - replace numeric literals with `<NUM>` (optional; config)
3. Tokenize (TS-ish tokenizer):
   - split into identifiers, keywords, operators, string literals (optionally normalize strings)
4. Shingling: k=5 tokens
5. Build set of shingles; compute MinHash signature (n=128)
6. Insert into LSH buckets.

Candidate query:
- union of bucket matches yields candidate PR ids.

Similarity:
- estimate Jaccard via MinHash, then compute exact Jaccard on shingle sets for top candidates.

### 2.3 TS symbol/export/import signature (same-feature signal)
Requires base/head file contents (use local bare mirror and fetch PR refs as needed).

For each changed production file:
- parse base and head using TypeScript compiler API
- map diff hunks to AST nodes (line range -> node containment)
- extract:
  - changed symbols: function/method/class/interface/type alias names
  - export surface: exported declarations, export specifiers
  - import modules: module specifiers (normalized)

Representations:
- `changedSymbols: Set<string>`
- `changedExports: Set<string>`
- `changedImports: Set<string>`

Similarity:
- Jaccard overlap per set; weighted combination.

Use case:
- detect semantically similar features even when code differs.

## 3) Tests signatures (intent without being dominated by boilerplate)

### 3.1 Test-intent extraction (AST)
For test files (channel=tests):
Extract:
- suite names: `describe("...")`
- test names: `it/test("...")`
- matcher histogram: `expect(...).toX(...)`
- imports-under-test: module specifiers (filter out test framework libs)

Normalize names:
- lowercase
- strip punctuation
- collapse whitespace

Signature:
- MinHash on tokens from {suite names, test names, matcher names, imports-under-test}

This avoids "800 lines of harness" dominating similarity.

## 4) Docs signatures (structure > content)
For markdown/docs:
Extract:
- headings (`#`, `##`, ...)
- fenced code block languages + first N tokens per block
- explicit references to issues/PRs (#1234 style)

Signature:
- MinHash on extracted tokens.

## 5) Meta channel
Default behavior:
- excluded from duplicate detection scoring
Optional:
- extract only explicit PR/issue references and a small keyword set
- use as explanation tie-breaker, never as primary trigger

## 6) Candidate generation (sublinear)
Candidates for a new PR are union of:
- production LSH matches (minhash buckets)
- same-file / same-dir recent PRs (path index)
- shared exports/symbols (symbol index)
- tests-intent LSH matches (for competing impl detection)

Target candidate set size:
- typically 20–200, not thousands

## 7) Pairwise scoring and categories

Compute per-channel similarity:
- prod_diff_exact: {0,1}
- prod_minhash_sim: [0,1]
- prod_files_sim: [0,1]
- prod_symbols_sim: [0,1]
- prod_exports_sim: [0,1]
- prod_imports_sim: [0,1]
- tests_intent_sim: [0,1]
- docs_struct_sim: [0,1]

Aggregate score (example; tune in thresholds.yaml):
- If prod_diff_exact == 1 => SAME_CHANGE
- Else:
  - prodScore = w1*prod_minhash + w2*prod_exports + w3*prod_symbols + w4*prod_files + w5*prod_imports
  - testScore = wt*tests_intent
  - docScore = wd*docs_struct
  - finalScore = prodScore + min(testScore, testCap) + min(docScore, docCap)

Category rules (precision-first):
- SAME_CHANGE:
  - prod_diff_exact == 1 OR (prod_minhash > 0.95 AND prod_files > 0.8)
- SAME_FEATURE:
  - prodScore high (exports/symbols/imports overlap) AND at least one supporting signal (tests or docs or moderate prod_minhash)
- COMPETING_IMPLEMENTATION:
  - tests_intent very high AND prodScore low/moderate
- RELATED:
  - moderate overlap but below thresholds
- NOT_RELATED:
  - low overlap

## 8) Base/original inference (within cluster)

Represent each PR by a production change set:
- patch mode: production shingle set
- rewrite mode: production winnowing fingerprints
- ts mode: production symbol/export sets

Containment:
- contain(A in B) = |A ∩ B| / |A|

Edge A → B if:
- contain(A in B) > containThreshold (e.g., 0.9)
- |B| >= |A|*(1+epsilon)
- B.created_at >= A.created_at (soft constraint)

Base candidates:
- low in-degree nodes (roots)

Canonical PR (recommended to keep) is separate:
- prefer CI green, approvals, smaller conflicts, scope alignment

## 9) Rewrite detection + move/rename tolerant signatures
Trigger rewrite mode if:
- lines changed > rewriteLineThreshold
- files changed > rewriteFileThreshold
- git diff reports many renames
- prod_minhash similarity is low but path overlap is high

Rewrite signature:
- winnowing fingerprints over token stream (per production file)
- compare overlap/containment

## 10) Evidence bundle (must be stored)
Every suggested duplicate must include evidence:
- overlapping files/dirs
- top overlapping exports/symbols
- tests intent matches (top suite/test names)
- doc heading/code-block matches
- computed similarity values
This evidence is what the dashboard and Check Run display.
