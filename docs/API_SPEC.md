# API Spec (Internal Dashboard + Ops)

This API is for:
- maintainers triage dashboard
- operational tooling

It is not a public stable API. Keep it behind auth.

Base URL: `/api`
Content-Type: `application/json`

---

## Authentication

Dashboard/API read routes support token auth with an explicit mode switch.

### Headers
One of:
- `Authorization: Bearer <DASHBOARD_TOKEN>`
- `X-Admin-Token: <DASHBOARD_TOKEN>`

### Server config
- `DASHBOARD_AUTH_MODE=auto|required|disabled`
- `DASHBOARD_TOKEN=<token>`

Mode behavior:
- `required`: token is always required
- `disabled`: token checks are bypassed
- `auto` (default): token is required only when `NODE_ENV=production`

---

## Common types

### `Repo`
```json
{
  "repoId": 123,
  "owner": "openclaw",
  "name": "openclaw",
  "defaultBranch": "main",
  "isActive": true,
  "installationId": 111111
}
```

### `TriageQueueItem`
```json
{
  "repoId": 123,
  "prNumber": 3101,
  "prId": 999999,
  "headSha": "abcd...",
  "prUrl": "https://github.com/openclaw/openclaw/pull/3101",
  "title": "Add feature X",
  "authorLogin": "someone",
  "state": "OPEN",
  "updatedAt": "2026-02-17T00:00:00Z",
  "lastAnalyzedAt": "2026-02-17T00:02:00Z",
  "analysisStatus": "DONE",
  "analysisRunId": "uuid",
  "topSuggestion": {
    "category": "SAME_FEATURE",
    "candidatePrNumber": 2700,
    "candidatePrUrl": "https://github.com/openclaw/openclaw/pull/2700",
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
  "candidateUrl": "https://github.com/openclaw/openclaw/pull/2700",
  "rank": 1,
  "category": "SAME_FEATURE",
  "finalScore": 0.82,
  "scores": {
    "prodDiffExact": 0,
    "prodMinhash": 0.62,
    "prodFiles": 0.7,
    "prodExports": 0.85,
    "prodSymbols": 0.78,
    "prodImports": 0.66,
    "testsIntent": 0.4,
    "docsStruct": 0.1
  },
  "evidence": {
    "overlappingProductionPaths": ["src/foo.ts", "src/bar.ts"],
    "overlappingExports": ["createFoo", "FooOptions"],
    "overlappingSymbols": ["FooBuilder", "parseFoo"],
    "overlappingImports": ["./foo"],
    "testsIntentOverlap": {
      "suiteNames": ["foo parser"],
      "testNames": ["handles empty input"],
      "matchers": ["toEqual", "toThrow"]
    },
    "docsOverlap": {
      "headings": ["Design", "Non-goals"],
      "codeFences": ["ts", "bash"]
    },
    "similarityValues": {
      "prodDiffExact": 0,
      "prodMinhash": 0.62,
      "prodFiles": 0.7,
      "prodExports": 0.85,
      "prodSymbols": 0.78,
      "prodImports": 0.66,
      "testsIntent": 0.4,
      "docsStruct": 0.1
    }
  }
}
```

### `DuplicateSet`
```json
{
  "setId": "f3a57f9f0b8cf9f9",
  "size": 3,
  "maxScore": 0.94,
  "categories": ["SAME_CHANGE", "SAME_FEATURE"],
  "lastAnalyzedAt": "2026-02-17T00:00:00Z",
  "members": [
    {
      "prId": 999,
      "prNumber": 3101,
      "headSha": "abcd...",
      "title": "Add feature X",
      "url": "https://github.com/openclaw/openclaw/pull/3101",
      "state": "OPEN",
      "lastAnalyzedAt": "2026-02-17T00:00:00Z"
    }
  ],
  "strongestEdges": [
    {
      "fromPrNumber": 3101,
      "fromPrUrl": "https://github.com/openclaw/openclaw/pull/3101",
      "toPrNumber": 2700,
      "toPrUrl": "https://github.com/openclaw/openclaw/pull/2700",
      "category": "SAME_FEATURE",
      "score": 0.82,
      "evidence": { "overlappingProductionPaths": ["src/foo.ts"] }
    }
  ]
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

HTTP status codes:
- `200 OK`
- `400 Bad Request`
- `401 Unauthorized`
- `404 Not Found`
- `500 Internal Error`

---

## Endpoints

### Health
`GET /api/health`

Response:
```json
{ "ok": true }
```

### Repositories
`GET /api/repos`

Response:
```json
{
  "repos": [
    {
      "repoId": 123,
      "owner": "openclaw",
      "name": "openclaw",
      "defaultBranch": "main",
      "isActive": true,
      "installationId": 111111
    }
  ]
}
```

### Triage queue
`GET /api/repos/:repoId/triage-queue`

Query params:
- `state`: `OPEN|CLOSED|MERGED` (default `OPEN`)
- `needsReview`: `true|false` (default `true`)
- `limit`: default `50`, max `200`
- `cursor`: opaque pagination token
- `orderBy`: `LAST_ANALYZED_AT|UPDATED_AT` (default `LAST_ANALYZED_AT`)

Response:
```json
{
  "items": [/* TriageQueueItem[] */],
  "nextCursor": "opaque"
}
```

### PR details
`GET /api/repos/:repoId/prs/:prNumber`

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
  "url": "https://github.com/...",
  "baseRef": "main",
  "baseSha": "...",
  "headRef": "feature-x",
  "headSha": "...",
  "createdAt": "...",
  "updatedAt": "...",
  "closedAt": null,
  "mergedAt": null,
  "analysis": {
    "lastAnalyzedAt": "...",
    "status": "DONE",
    "analysisRunId": "uuid",
    "signatureVersion": 1,
    "algorithmVersion": 1,
    "configVersion": 1,
    "degradedReasons": null,
    "finishedAt": "...",
    "analysisError": null
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

### Candidate results
`GET /api/repos/:repoId/prs/:prNumber/candidates`

Query params:
- `headSha` optional; defaults to latest analyzed head (or current head)
- `limit` default `10`, max `50`
- `minScore` optional

Response:
```json
{
  "analysisRunId": "uuid",
  "prNumber": 3101,
  "headSha": "....",
  "candidates": [/* Candidate[] */]
}
```

### Duplicate sets (derived, not persisted clusters)
`GET /api/repos/:repoId/duplicate-sets`

Query params:
- `state`: `OPEN|CLOSED|MERGED` (default `OPEN`)
- `needsReview`: `true|false` (default `true`)
- `minScore`: similarity floor (default `REVIEW_SCORE_THRESHOLD`)
- `limit`: default `20`, max `100`
- `cursor`: opaque pagination token
- `includeCategories`: comma-separated categories or `ALL_ABOVE_THRESHOLD` (default)

Response:
```json
{
  "sets": [/* DuplicateSet[] */],
  "nextCursor": "opaque"
}
```

### GitHub webhook ingest
`POST /webhooks/github`

- Verifies `X-Hub-Signature-256`
- Idempotent by `X-GitHub-Delivery`
- Enqueues ingest for processable PR actions

Response examples:
```json
{ "enqueued": true }
```
```json
{ "duplicate": true }
```
```json
{ "skipped": true }
```

---

## Future endpoints (not yet implemented)
- cluster endpoints (`/clusters/...`)
- feedback write/read endpoints
- explicit rescore endpoint
