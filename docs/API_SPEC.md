# API Spec (Internal Dashboard + Ops)

This API is for:
- maintainers triage dashboard
- operational tooling (rescore/backfill)
It is **not** intended as a public stable API. Keep it behind auth.

Base URL: `/api`

Content-Type: `application/json`

---

## Authentication

### MVP (fast)
One of:
- `Authorization: Bearer <DASHBOARD_TOKEN>`
- or `X-Admin-Token: <DASHBOARD_TOKEN>`

Server config:
- `DASHBOARD_TOKEN` required in production

### Later (better)
GitHub OAuth for maintainers (session cookie) + repo permission checks.

---

## Common types

### `Repo`
```json
{
  "repoId": 123,
  "owner": "openclaw",
  "name": "openclaw",
  "defaultBranch": "main",
  "isActive": true
}
```

### `TriageQueueItem`

```json
{
  "repoId": 123,
  "prNumber": 3101,
  "prId": 999999,
  "headSha": "abcd...",
  "title": "Add feature X",
  "authorLogin": "someone",
  "state": "OPEN",
  "updatedAt": "2026-02-17T00:00:00Z",
  "analysisStatus": "DONE",
  "topSuggestion": {
    "category": "SAME_FEATURE",
    "candidatePrNumber": 2700,
    "score": 0.82
  },
  "needsReview": true
}
```

### `Candidate`

```json
{
  "candidatePrNumber": 2700,
  "candidatePrId": 888888,
  "candidateHeadSha": "dcba...",
  "rank": 1,
  "category": "SAME_FEATURE",
  "finalScore": 0.82,
  "scores": {
    "prodMinhash": 0.62,
    "prodFiles": 0.70,
    "prodExports": 0.85,
    "prodSymbols": 0.78,
    "prodImports": 0.66,
    "testsIntent": 0.40,
    "docsStruct": 0.10
  },
  "evidence": {
    "overlappingProductionPaths": ["src/foo.ts", "src/bar.ts"],
    "overlappingExports": ["createFoo", "FooOptions"],
    "overlappingSymbols": ["FooBuilder", "parseFoo"],
    "testsIntentOverlap": {
      "suiteNames": ["foo parser"],
      "testNames": ["handles empty input"],
      "matchers": ["toEqual", "toThrow"]
    },
    "docsOverlap": {
      "headings": ["Design", "Non-goals"],
      "codeFences": ["ts", "bash"]
    }
  }
}
```

### `Error format`

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "PR not found"
  }
}
```

### HTTP status codes:
	•	200 OK
	•	400 Bad Request
	•	401 Unauthorized
	•	403 Forbidden
	•	404 Not Found
	•	409 Conflict (idempotency / stale head sha)
	•	429 Too Many Requests
	•	500 Internal Error

### Endpoints

Health

GET /api/health
Returns basic liveness.

Response:
```json
{ "ok": true }
```

Repositories

GET /api/repos
List tracked repos.

Response:

```json
{
  "repos": [
    { "repoId": 123, "owner": "openclaw", "name": "openclaw", "defaultBranch": "main", "isActive": true }
  ]
}
```

POST /api/repos/:repoId/resync
Triggers a repo metadata refresh (optional).

Body:

```json
{ "force": false }
```

```json
{ "enqueued": true }
```

PR queue + details

GET /api/repos/:repoId/triage-queue
List PRs requiring review.

Query params:
	•	state: OPEN|CLOSED|MERGED (default OPEN)
	•	needsReview: true|false (default true)
	•	limit: default 50, max 200
	•	cursor: opaque string for pagination
	•	updatedSince: ISO timestamp (optional)

Response:
```json
{
  "items": [ /* TriageQueueItem[] */ ],
  "nextCursor": "opaque"
}
```

Definition of needsReview (default logic):
	•	analysis exists for current head sha
	•	at least one candidate above the “review threshold”
	•	and no maintainer feedback recorded for that (pr, head_sha) OR analysis changed since feedback

GET /api/repos/:repoId/prs/:prNumber
Return PR detail + summary stats.

Response:

```json
{
  "repoId": 123,
  "prNumber": 3101,
  "prId": 999999,
  "state": "OPEN",
  "isDraft": false,
  "title": "Add feature X",
  "body": "...",
  "authorLogin": "someone",
  "url": "https://github.com/..",
  "baseSha": "....",
  "headSha": "....",
  "createdAt": "....",
  "updatedAt": "....",
  "analysis": {
    "lastAnalyzedAt": "....",
    "status": "DONE",
    "analysisRunId": "uuid",
    "signatureVersion": 1,
    "algorithmVersion": 1,
    "configVersion": 1,
    "degradedReasons": null
  },
  "size": {
    "changedFiles": 12,
    "additions": 340,
    "deletions": 20
  },
  "channels": {
    "productionFiles": 4,
    "testFiles": 6,
    "docFiles": 2,
    "metaFiles": 0
  }
}
```

GET /api/repos/:repoId/prs/:prNumber/files
Return file list with channels.

Query params:
	•	headSha optional; default current PR head

Response:

```json
{
  "prNumber": 3101,
  "headSha": "....",
  "files": [
    { "path": "src/foo.ts", "status": "MODIFIED", "additions": 10, "deletions": 2, "channel": "PRODUCTION" },
    { "path": "src/foo.test.ts", "status": "ADDED", "additions": 400, "deletions": 0, "channel": "TESTS" }
  ]
}
```

Candidate results

GET /api/repos/:repoId/prs/:prNumber/candidates
Return ranked candidates for the latest analysis run.

Query params:
	•	headSha optional; default current
	•	limit default 10, max 50
	•	minCategory optional (e.g. exclude RELATED)
	•	minScore optional

Response:

```json
{
  "analysisRunId": "uuid",
  "prNumber": 3101,
  "headSha": "....",
  "candidates": [ /* Candidate[] */ ]
}
```

POST /api/repos/:repoId/prs/:prNumber/rescore
Enqueue a re-analysis for current head sha.

Body:

```json
{ "force": false }
```

Response:

```json
{ "enqueued": true }
```

Clusters (Phase 5+)

GET /api/repos/:repoId/clusters
Query params:
	•	state: default OPEN_ONLY
	•	limit default 50
	•	cursor optional

Response:

```json
{
  "clusters": [
    {
      "clusterId": "uuid",
      "size": 4,
      "updatedAt": "....",
      "baseSuggested": { "prNumber": 2700, "headSha": "...." },
      "canonicalSuggested": { "prNumber": 2700, "headSha": "...." }
    }
  ],
  "nextCursor": "opaque"
}
```

GET /api/repos/:repoId/clusters/:clusterId
Response includes members + containment edges.

Response:

```json
{
  "clusterId": "uuid",
  "members": [
    { "prNumber": 2700, "headSha": "....", "role": "BASE_SUGGESTED" },
    { "prNumber": 3101, "headSha": "....", "role": "MEMBER" }
  ],
  "containmentEdges": [
    {
      "fromPrNumber": 2700,
      "toPrNumber": 3101,
      "basis": "PROD_SHINGLES",
      "containment": 0.94
    }
  ]
}
```

Maintainer feedback

POST /api/repos/:repoId/prs/:prNumber/feedback
Record a maintainer decision. This is the primary learning signal.

Body:

```json
{
  "headSha": "....",
  "candidatePrNumber": 2700,
  "candidateHeadSha": "....",
  "decision": "DUPLICATE|SAME_FEATURE|COMPETING|RELATED|NOT_RELATED",
  "basePrNumber": 2700,
  "notes": "optional"
}
```

Rules:
	•	headSha required; reject if not current and force not provided (prevents stale feedback)
	•	candidatePrNumber optional for decisions like OUT_OF_SCOPE or general notes

Response:

```json
{ "saved": true, "feedbackId": "uuid" }
```

GET /api/repos/:repoId/prs/:prNumber/feedback
Query params:
	•	headSha optional; default current

Response:

```json
{
  "prNumber": 3101,
  "headSha": "....",
  "feedback": [
    {
      "decision": "DUPLICATE",
      "candidatePrNumber": 2700,
      "basePrNumber": 2700,
      "actorLogin": "maintainer",
      "createdAt": "....",
      "notes": "..."
    }
  ]
}
```
