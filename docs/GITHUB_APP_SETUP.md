# GitHub App Setup

## Permissions (minimum viable)
Required:
- Pull requests: Read (to fetch metadata/files)
- Contents: Read (to fetch repo content via git; optional via API)
- Issues: Read (for issue dedupe)
- Checks: Read & Write (to publish check runs) [recommended]
Optional:
- Pull requests: Write (if applying labels/comments)
- Issues: Write (if applying labels/closing duplicates — NOT recommended initially)

Events (webhooks):
- pull_request
- issues
- issue_comment (optional; to detect user linking + feedback)
- pull_request_review (optional; to use approvals as canonical scoring)
- check_run (optional; if you want to update your check)

## Auth model
Use GitHub App installation tokens:
- short-lived tokens, generated per installation
- cache token until expiry to reduce overhead

## Fetching PR data
Recommended:
- GraphQL for metadata and file lists
- REST for patch/diff (when needed)

Worker should support:
- graceful fallback when patch is too large or truncated:
  - use local git mirror diff instead of API patch

## Git mirror strategy (fork-safe)
- Keep a bare mirror of upstream repo only.
- For PR N:
  - git fetch origin pull/N/head:refs/pr/N
Then you can access:
- base sha: from PR metadata
- head ref: refs/pr/N

Never fetch forks directly.

## Rate limits
- Implement a token bucket and automatic retry/backoff.
- Prefer GraphQL batching where possible.
- Cache stable PR data (files list) keyed by (pr_id, head_sha).

## Idempotency
Store:
- GitHub delivery id (header: X-GitHub-Delivery)
- event type + action + pr/issue id
Ensure processing is idempotent:
- upsert by (repo_id, pr_number, head_sha) for PR signature computation
