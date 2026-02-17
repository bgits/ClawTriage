import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@clawtriage/core";
import { createApiApp } from "./app.js";
import { decodeDuplicateSetCursor } from "./duplicate-sets.js";

function makeRuntime(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    port: 3000,
    databaseUrl: "postgres://postgres:postgres@localhost:5432/clawtriage",
    redisUrl: "redis://localhost:6379",
    githubMode: "public",
    webhookSecret: undefined,
    githubAppId: undefined,
    githubPrivateKeyPem: undefined,
    dashboardToken: "dashboard-token",
    dashboardAuthMode: "disabled",
    dashboardStaticDir: undefined,
    opsTriggerToken: "ops-trigger-token",
    publicScanAllowedRepos: ["openclaw/openclaw"],
    workerConcurrency: 1,
    checkRunName: "ClawTriage Duplicate Triage",
    signatureVersion: 1,
    algorithmVersion: 1,
    reviewScoreThreshold: 0.55,
    ...overrides,
  };
}

function makeStorageMock(): Record<string, unknown> {
  return {
    listRepositories: vi.fn(async () => []),
    listTriageQueue: vi.fn(async () => ({ items: [], nextCursor: null })),
    getPullRequestByNumber: vi.fn(async () => null),
    getPullRequestChannelCounts: vi.fn(async () => ({
      productionFiles: 0,
      testFiles: 0,
      docFiles: 0,
      metaFiles: 0,
    })),
    getLatestAnalysisRunId: vi.fn(async () => null),
    getCandidatesForAnalysisRun: vi.fn(async () => []),
    listDuplicateSetNodes: vi.fn(async () => []),
    listDuplicateSetEdges: vi.fn(async () => []),
    recordWebhookDeliveryReceived: vi.fn(async () => ({ inserted: true, existingStatus: null })),
    markWebhookDeliveryStatus: vi.fn(async () => undefined),
    upsertInstallation: vi.fn(async () => undefined),
    upsertRepository: vi.fn(async () => undefined),
  };
}

function makeApp(params?: {
  runtimeOverrides?: Partial<RuntimeConfig>;
  storageOverrides?: Record<string, unknown>;
}) {
  const storage = {
    ...makeStorageMock(),
    ...(params?.storageOverrides ?? {}),
  } as Record<string, unknown>;

  const queue = {
    addIngestPr: vi.fn(async () => undefined),
    addPublicPrScan: vi.fn(async () => undefined),
  };

  const app = createApiApp({
    runtime: makeRuntime(params?.runtimeOverrides),
    storage: storage as any,
    queue,
  });

  return { app, storage, queue };
}

function makeDuplicateSetSortFixtures() {
  const makeNode = (
    prId: number,
    prNumber: number,
    headSha: string,
    analyzedAt: string,
    analysisRunId: string,
  ) => ({
    prId,
    prNumber,
    headSha,
    title: `PR ${prNumber}`,
    url: `https://github.com/org/repo/pull/${prNumber}`,
    state: "OPEN" as const,
    lastAnalyzedAt: new Date(analyzedAt),
    analysisRunId,
  });

  return {
    nodes: [
      makeNode(1, 101, "a001", "2026-02-17T12:00:00Z", "run-1"),
      makeNode(2, 102, "a002", "2026-02-17T12:05:00Z", "run-2"),
      makeNode(3, 103, "b001", "2026-02-17T12:10:00Z", "run-3"),
      makeNode(4, 104, "b002", "2026-02-17T12:11:00Z", "run-4"),
      makeNode(5, 105, "b003", "2026-02-17T12:12:00Z", "run-5"),
      makeNode(6, 106, "c001", "2026-02-17T12:20:00Z", "run-6"),
      makeNode(7, 107, "c002", "2026-02-17T12:21:00Z", "run-7"),
      makeNode(8, 108, "c003", "2026-02-17T12:22:00Z", "run-8"),
      makeNode(9, 109, "d001", "2026-02-17T12:30:00Z", "run-9"),
      makeNode(10, 110, "d002", "2026-02-17T12:31:00Z", "run-10"),
    ],
    edges: [
      {
        prIdA: 1,
        headShaA: "a001",
        prIdB: 2,
        headShaB: "a002",
        category: "SAME_FEATURE" as const,
        finalScore: 1,
        evidence: { overlappingProductionPaths: ["src/a.ts"] },
      },
      {
        prIdA: 3,
        headShaA: "b001",
        prIdB: 4,
        headShaB: "b002",
        category: "SAME_FEATURE" as const,
        finalScore: 1,
        evidence: { overlappingProductionPaths: ["src/b.ts"] },
      },
      {
        prIdA: 4,
        headShaA: "b002",
        prIdB: 5,
        headShaB: "b003",
        category: "SAME_FEATURE" as const,
        finalScore: 0.97,
        evidence: { overlappingProductionPaths: ["src/b.ts"] },
      },
      {
        prIdA: 6,
        headShaA: "c001",
        prIdB: 7,
        headShaB: "c002",
        category: "SAME_FEATURE" as const,
        finalScore: 1,
        evidence: { overlappingProductionPaths: ["src/c.ts"] },
      },
      {
        prIdA: 7,
        headShaA: "c002",
        prIdB: 8,
        headShaB: "c003",
        category: "RELATED" as const,
        finalScore: 0.92,
        evidence: { overlappingProductionPaths: ["src/c.ts"] },
      },
      {
        prIdA: 9,
        headShaA: "d001",
        prIdB: 10,
        headShaB: "d002",
        category: "RELATED" as const,
        finalScore: 0.9,
        evidence: { overlappingProductionPaths: ["src/d.ts"] },
      },
    ],
  };
}

describe("dashboard API routes", () => {
  it("returns config error for webhook ingest when github app mode is not configured", async () => {
    const { app } = makeApp({
      runtimeOverrides: {
        githubMode: "public",
        webhookSecret: undefined,
        githubAppId: undefined,
        githubPrivateKeyPem: undefined,
      },
    });

    await request(app)
      .post("/webhooks/github")
      .set("x-github-delivery", "delivery-1")
      .set("x-github-event", "pull_request")
      .send("{}")
      .expect(503);
  });

  it("requires ops token for public scan trigger", async () => {
    const { app } = makeApp();

    await request(app).post("/api/ops/public-scan").send({ owner: "openclaw", repo: "openclaw" }).expect(401);

    await request(app)
      .post("/api/ops/public-scan")
      .set("Authorization", "Bearer ops-trigger-token")
      .send({ owner: "openclaw", repo: "openclaw" })
      .expect(202);
  });

  it("enforces public scan allowlist", async () => {
    const { app } = makeApp({
      runtimeOverrides: {
        publicScanAllowedRepos: ["openclaw/openclaw"],
      },
    });

    await request(app)
      .post("/api/ops/public-scan")
      .set("Authorization", "Bearer ops-trigger-token")
      .send({ owner: "otherorg", repo: "repo" })
      .expect(403);
  });

  it("enqueues public scan job with deterministic id", async () => {
    const { app, queue } = makeApp({
      runtimeOverrides: {
        publicScanAllowedRepos: ["openclaw/openclaw"],
      },
    });

    const response = await request(app)
      .post("/api/ops/public-scan")
      .set("Authorization", "Bearer ops-trigger-token")
      .send({
        owner: "openclaw",
        repo: "openclaw",
        snapshot: "2026-02-17t120000z",
        maxOpenPrs: 25,
      })
      .expect(202);

    expect(queue.addPublicPrScan).toHaveBeenCalledWith(
      "public-pr-scan",
      expect.objectContaining({
        owner: "openclaw",
        repo: "openclaw",
        snapshot: "2026-02-17t120000z",
        maxOpenPrs: 25,
      }),
      expect.objectContaining({
        jobId: "public-pr-scan-openclaw-openclaw-2026-02-17t120000z",
      }),
    );
    expect(response.body.enqueued).toBe(true);
  });

  it("enforces dashboard token when auth mode is required", async () => {
    const { app } = makeApp({
      runtimeOverrides: {
        dashboardAuthMode: "required",
        dashboardToken: "secret-token",
      },
    });

    await request(app).get("/api/repos").expect(401);

    const response = await request(app)
      .get("/api/repos")
      .set("Authorization", "Bearer secret-token")
      .expect(200);

    expect(response.body).toEqual({ repos: [] });
  });

  it("returns enriched triage queue payload", async () => {
    const queueItem = {
      repoId: 123,
      prNumber: 3101,
      prId: 999,
      headSha: "abcdef1234567890",
      prUrl: "https://github.com/openclaw/openclaw/pull/3101",
      title: "Add feature X",
      authorLogin: "someone",
      state: "OPEN" as const,
      updatedAt: new Date("2026-02-17T00:00:00Z"),
      lastAnalyzedAt: new Date("2026-02-17T00:05:00Z"),
      analysisStatus: "DONE" as const,
      analysisRunId: "run-123",
      topSuggestion: {
        category: "SAME_FEATURE" as const,
        candidatePrNumber: 2700,
        candidatePrUrl: "https://github.com/openclaw/openclaw/pull/2700",
        score: 0.82,
      },
      needsReview: true,
    };

    const { app, storage } = makeApp({
      storageOverrides: {
        listTriageQueue: vi.fn(async () => ({
          items: [queueItem],
          nextCursor: "cursor-1",
        })),
      },
    });

    const response = await request(app)
      .get("/api/repos/123/triage-queue")
      .query({ orderBy: "LAST_ANALYZED_AT" })
      .expect(200);

    expect(storage.listTriageQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 123,
        orderBy: "LAST_ANALYZED_AT",
      }),
    );
    expect(response.body.items[0].prUrl).toBe(queueItem.prUrl);
    expect(response.body.items[0].analysisRunId).toBe("run-123");
    expect(response.body.items[0].topSuggestion.candidatePrUrl).toBe(
      queueItem.topSuggestion.candidatePrUrl,
    );
  });

  it("returns PR detail and channels", async () => {
    const { app } = makeApp({
      storageOverrides: {
        getPullRequestByNumber: vi.fn(async () => ({
          repoId: 123,
          prId: 999,
          prNumber: 3101,
          state: "OPEN" as const,
          isDraft: false,
          title: "Add feature X",
          body: "body",
          authorLogin: "someone",
          url: "https://github.com/openclaw/openclaw/pull/3101",
          baseRef: "main",
          baseSha: "base",
          headRef: "feature-x",
          headSha: "head",
          createdAt: new Date("2026-02-10T00:00:00Z"),
          updatedAt: new Date("2026-02-17T00:00:00Z"),
          closedAt: null,
          mergedAt: null,
          additions: 10,
          deletions: 2,
          changedFiles: 3,
          analysisStatus: "DONE" as const,
          analysisError: null,
          lastAnalyzedHeadSha: "head",
          lastAnalyzedAt: new Date("2026-02-17T00:05:00Z"),
          analysisRunId: "run-1",
          signatureVersion: 1,
          algorithmVersion: 1,
          configVersion: 1,
          degradedReasons: null,
          analysisFinishedAt: new Date("2026-02-17T00:06:00Z"),
        })),
        getPullRequestChannelCounts: vi.fn(async () => ({
          productionFiles: 2,
          testFiles: 1,
          docFiles: 0,
          metaFiles: 0,
        })),
      },
    });

    const response = await request(app).get("/api/repos/123/prs/3101").expect(200);

    expect(response.body.analysis.analysisRunId).toBe("run-1");
    expect(response.body.channels.productionFiles).toBe(2);
    expect(response.body.url).toBe("https://github.com/openclaw/openclaw/pull/3101");
  });

  it("returns candidate list for latest analysis run", async () => {
    const { app, storage } = makeApp({
      storageOverrides: {
        getPullRequestByNumber: vi.fn(async () => ({
          repoId: 123,
          prId: 999,
          prNumber: 3101,
          state: "OPEN" as const,
          isDraft: false,
          title: "Add feature X",
          body: null,
          authorLogin: "someone",
          url: "https://github.com/openclaw/openclaw/pull/3101",
          baseRef: "main",
          baseSha: "base",
          headRef: "feature-x",
          headSha: "head",
          createdAt: new Date("2026-02-10T00:00:00Z"),
          updatedAt: new Date("2026-02-17T00:00:00Z"),
          closedAt: null,
          mergedAt: null,
          additions: 10,
          deletions: 2,
          changedFiles: 3,
          analysisStatus: "DONE" as const,
          analysisError: null,
          lastAnalyzedHeadSha: "head",
          lastAnalyzedAt: new Date("2026-02-17T00:05:00Z"),
          analysisRunId: "run-1",
          signatureVersion: 1,
          algorithmVersion: 1,
          configVersion: 1,
          degradedReasons: null,
          analysisFinishedAt: new Date("2026-02-17T00:06:00Z"),
        })),
        getLatestAnalysisRunId: vi.fn(async () => "run-1"),
        getCandidatesForAnalysisRun: vi.fn(async () => [
          {
            analysisRunId: "run-1",
            prNumber: 3101,
            headSha: "head",
            candidatePrNumber: 2700,
            candidatePrId: 888,
            candidateHeadSha: "cand-head",
            candidateUrl: "https://github.com/openclaw/openclaw/pull/2700",
            rank: 1,
            category: "SAME_FEATURE" as const,
            finalScore: 0.82,
            scores: {
              prodDiffExact: 0,
              prodMinhash: 0.62,
              prodFiles: 0.7,
              prodExports: 0.85,
              prodSymbols: 0.78,
              prodImports: 0.66,
              testsIntent: 0.4,
              docsStruct: 0.1,
            },
            evidence: {
              overlappingProductionPaths: ["src/foo.ts"],
              overlappingExports: ["createFoo"],
              overlappingSymbols: ["FooBuilder"],
              overlappingImports: ["./foo"],
              testsIntentOverlap: {
                suiteNames: ["suite"],
                testNames: ["test"],
                matchers: ["toEqual"],
              },
              docsOverlap: {
                headings: ["Design"],
                codeFences: ["ts"],
              },
              similarityValues: {
                prodDiffExact: 0,
                prodMinhash: 0.62,
                prodFiles: 0.7,
                prodExports: 0.85,
                prodSymbols: 0.78,
                prodImports: 0.66,
                testsIntent: 0.4,
                docsStruct: 0.1,
              },
            },
          },
        ]),
      },
    });

    const response = await request(app)
      .get("/api/repos/123/prs/3101/candidates")
      .query({ minScore: 0.7 })
      .expect(200);

    expect(storage.getCandidatesForAnalysisRun).toHaveBeenCalledWith("run-1", 10, 0.7);
    expect(response.body.candidates[0].candidateUrl).toBe(
      "https://github.com/openclaw/openclaw/pull/2700",
    );
  });

  it("derives duplicate sets from edge graph and honors minScore", async () => {
    const { app } = makeApp({
      storageOverrides: {
        listDuplicateSetNodes: vi.fn(async () => [
          {
            prId: 1,
            prNumber: 101,
            headSha: "aaaa",
            title: "PR 101",
            url: "https://github.com/org/repo/pull/101",
            state: "OPEN" as const,
            lastAnalyzedAt: new Date("2026-02-17T12:00:00Z"),
            analysisRunId: "run-1",
          },
          {
            prId: 2,
            prNumber: 102,
            headSha: "bbbb",
            title: "PR 102",
            url: "https://github.com/org/repo/pull/102",
            state: "OPEN" as const,
            lastAnalyzedAt: new Date("2026-02-16T12:00:00Z"),
            analysisRunId: "run-2",
          },
          {
            prId: 3,
            prNumber: 103,
            headSha: "cccc",
            title: "PR 103",
            url: "https://github.com/org/repo/pull/103",
            state: "OPEN" as const,
            lastAnalyzedAt: new Date("2026-02-15T12:00:00Z"),
            analysisRunId: "run-3",
          },
        ]),
        listDuplicateSetEdges: vi.fn(async () => [
          {
            prIdA: 1,
            headShaA: "aaaa",
            prIdB: 2,
            headShaB: "bbbb",
            category: "SAME_CHANGE" as const,
            finalScore: 0.93,
            evidence: { overlappingProductionPaths: ["src/a.ts"] },
          },
          {
            prIdA: 2,
            headShaA: "bbbb",
            prIdB: 3,
            headShaB: "cccc",
            category: "RELATED" as const,
            finalScore: 0.74,
            evidence: { overlappingProductionPaths: ["src/b.ts"] },
          },
        ].filter((edge) => edge.finalScore >= 0.8)),
      },
    });

    const response = await request(app)
      .get("/api/repos/123/duplicate-sets")
      .query({ minScore: 0.8, includeCategories: "SAME_CHANGE,RELATED" })
      .expect(200);

    expect(response.body.sets).toHaveLength(1);
    expect(response.body.sets[0].size).toBe(2);
    expect(response.body.sets[0].categories).toEqual(["SAME_CHANGE"]);
    expect(response.body.sets[0].members.map((entry: { prNumber: number }) => entry.prNumber)).toEqual(
      [101, 102],
    );
  });

  it("sorts duplicate sets by score, chip count, and PR count", async () => {
    const fixtures = makeDuplicateSetSortFixtures();
    const { app } = makeApp({
      storageOverrides: {
        listDuplicateSetNodes: vi.fn(async () => fixtures.nodes),
        listDuplicateSetEdges: vi.fn(async () => fixtures.edges),
      },
    });

    const response = await request(app).get("/api/repos/123/duplicate-sets").expect(200);

    expect(
      response.body.sets.map(
        (set: { maxScore: number; size: number; categories: string[] }) => ({
          maxScore: set.maxScore,
          size: set.size,
          categories: set.categories,
        }),
      ),
    ).toEqual([
      { maxScore: 1, size: 2, categories: ["SAME_FEATURE"] },
      { maxScore: 1, size: 3, categories: ["SAME_FEATURE"] },
      { maxScore: 1, size: 3, categories: ["RELATED", "SAME_FEATURE"] },
      { maxScore: 0.9, size: 2, categories: ["RELATED"] },
    ]);
  });

  it("encodes duplicate-set cursor with chip count and PR count sort keys", async () => {
    const fixtures = makeDuplicateSetSortFixtures();
    const { app } = makeApp({
      storageOverrides: {
        listDuplicateSetNodes: vi.fn(async () => fixtures.nodes),
        listDuplicateSetEdges: vi.fn(async () => fixtures.edges),
      },
    });

    const response = await request(app)
      .get("/api/repos/123/duplicate-sets")
      .query({ limit: 2 })
      .expect(200);

    const decoded = decodeDuplicateSetCursor(response.body.nextCursor);
    expect(decoded).toEqual({
      maxScore: 1,
      categoryCount: 1,
      size: 3,
      lastAnalyzedAt: "2026-02-17T12:12:00.000Z",
      setId: expect.any(String),
    });
  });
});
