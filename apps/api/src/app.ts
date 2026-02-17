import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  JOB_NAMES,
  WEBHOOK_PROCESSABLE_PR_ACTIONS,
  buildIngestPrJobId,
  buildPublicPrScanJobId,
  type PublicPrScanJobPayload,
  type RuntimeConfig,
  type TriageCategory,
} from "@clawtriage/core";
import { verifyWebhookSignature } from "@clawtriage/github";
import { Storage, type TriageQueueItem } from "@clawtriage/storage";
import {
  buildDuplicateSets,
  compareDuplicateSets,
  decodeDuplicateSetCursor,
  encodeDuplicateSetCursor,
  type DuplicateSetCursor,
  type DuplicateSetSummary,
} from "./duplicate-sets.js";

type StorageLike = Pick<
  Storage,
  | "listRepositories"
  | "listTriageQueue"
  | "getPullRequestByNumber"
  | "getPullRequestChannelCounts"
  | "getLatestAnalysisRunId"
  | "getCandidatesForAnalysisRun"
  | "listDuplicateSetNodes"
  | "listDuplicateSetEdges"
  | "recordWebhookDeliveryReceived"
  | "markWebhookDeliveryStatus"
  | "upsertInstallation"
  | "upsertRepository"
>;

interface QueueLike {
  addIngestPr(
    name: string,
    data: unknown,
    opts?: {
      jobId?: string;
      removeOnComplete?: number | boolean;
      removeOnFail?: number | boolean;
    },
  ): Promise<unknown>;
  addPublicPrScan(
    name: string,
    data: PublicPrScanJobPayload,
    opts?: {
      jobId?: string;
      removeOnComplete?: number | boolean;
      removeOnFail?: number | boolean;
    },
  ): Promise<unknown>;
}

interface CreateApiAppParams {
  runtime: RuntimeConfig;
  storage: StorageLike;
  queue: QueueLike;
}

const ALL_TRIAGE_CATEGORIES: TriageCategory[] = [
  "SAME_CHANGE",
  "SAME_FEATURE",
  "COMPETING_IMPLEMENTATION",
  "RELATED",
  "NOT_RELATED",
  "UNCERTAIN",
];

const DUPLICATE_SET_MAX_NODES = 2000;

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).toLowerCase();
  return normalized !== "false";
}

function parseState(value: unknown): "OPEN" | "CLOSED" | "MERGED" | null {
  const state = String(value ?? "OPEN").toUpperCase();
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
    return null;
  }
  return state;
}

function parseRepoId(value: string): number | null {
  const repoId = Number(value);
  if (!Number.isInteger(repoId) || repoId <= 0) {
    return null;
  }
  return repoId;
}

function parsePrNumber(value: string): number | null {
  const prNumber = Number(value);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return null;
  }
  return prNumber;
}

function parseOrderBy(value: unknown): "LAST_ANALYZED_AT" | "UPDATED_AT" | null {
  const parsed = String(value ?? "LAST_ANALYZED_AT").toUpperCase();
  if (parsed !== "LAST_ANALYZED_AT" && parsed !== "UPDATED_AT") {
    return null;
  }
  return parsed;
}

function parseMinScore(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (parsed < 0) {
    return 0;
  }

  if (parsed > 1) {
    return 1;
  }

  return parsed;
}

function parseIncludeCategories(value: unknown): TriageCategory[] | null {
  const raw = String(value ?? "ALL_ABOVE_THRESHOLD").trim();
  if (raw === "" || raw.toUpperCase() === "ALL_ABOVE_THRESHOLD") {
    return [...ALL_TRIAGE_CATEGORIES];
  }

  const categories = raw
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);

  const uniqueCategories = Array.from(new Set(categories));
  if (uniqueCategories.length === 0) {
    return [...ALL_TRIAGE_CATEGORIES];
  }

  for (const category of uniqueCategories) {
    if (!ALL_TRIAGE_CATEGORIES.includes(category as TriageCategory)) {
      return null;
    }
  }

  return uniqueCategories as TriageCategory[];
}

function shouldRequireDashboardToken(runtime: RuntimeConfig): boolean {
  if (runtime.dashboardAuthMode === "disabled") {
    return false;
  }

  if (runtime.dashboardAuthMode === "required") {
    return true;
  }

  return process.env.NODE_ENV === "production";
}

function requireDashboardToken(runtime: RuntimeConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!shouldRequireDashboardToken(runtime)) {
      next();
      return;
    }

    if (!runtime.dashboardToken) {
      res.status(500).json({
        error: {
          code: "CONFIG_ERROR",
          message: "DASHBOARD_TOKEN is required when dashboard auth is enabled",
        },
      });
      return;
    }

    const tokenHeader = req.header("authorization") ?? req.header("x-admin-token");
    const token = tokenHeader?.replace(/^Bearer\s+/i, "").trim();

    if (!token || token !== runtime.dashboardToken) {
      res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid dashboard token",
        },
      });
      return;
    }

    next();
  };
}

function requireOpsTriggerToken(runtime: RuntimeConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!runtime.opsTriggerToken) {
      res.status(500).json({
        error: {
          code: "CONFIG_ERROR",
          message: "OPS_TRIGGER_TOKEN is required for ops trigger endpoints",
        },
      });
      return;
    }

    const tokenHeader = req.header("authorization") ?? req.header("x-admin-token");
    const token = tokenHeader?.replace(/^Bearer\s+/i, "").trim();

    if (!token || token !== runtime.opsTriggerToken) {
      res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid ops trigger token",
        },
      });
      return;
    }

    next();
  };
}

interface PublicScanRequestBody {
  owner?: unknown;
  repo?: unknown;
  maxOpenPrs?: unknown;
  snapshot?: unknown;
}

function parseOwnerOrRepo(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function parseOptionalMaxOpenPrs(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1000) {
    return null;
  }
  return parsed;
}

function parseOptionalSnapshot(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    return null;
  }

  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function makeSnapshotId(now: Date): string {
  return now.toISOString().replace(/[^0-9a-z]/gi, "-").toLowerCase();
}

function normalizeRepoKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function resolveDashboardStaticDir(runtime: RuntimeConfig): string | null {
  const explicit = runtime.dashboardStaticDir?.trim();
  if (explicit) {
    const indexPath = path.join(explicit, "index.html");
    return existsSync(indexPath) ? explicit : null;
  }

  const fallback = path.resolve(process.cwd(), "apps/dashboard/dist");
  const fallbackIndex = path.join(fallback, "index.html");
  return existsSync(fallbackIndex) ? fallback : null;
}

function normalizeQueueItem(item: TriageQueueItem) {
  return {
    repoId: item.repoId,
    prNumber: item.prNumber,
    prId: item.prId,
    headSha: item.headSha,
    prUrl: item.prUrl,
    title: item.title,
    authorLogin: item.authorLogin,
    state: item.state,
    updatedAt: item.updatedAt.toISOString(),
    lastAnalyzedAt: item.lastAnalyzedAt ? item.lastAnalyzedAt.toISOString() : null,
    analysisStatus: item.analysisStatus,
    analysisRunId: item.analysisRunId,
    topSuggestion: item.topSuggestion,
    needsReview: item.needsReview,
  };
}

export function createApiApp(params: CreateApiAppParams): express.Express {
  const { runtime, storage, queue } = params;
  const dashboardTokenMiddleware = requireDashboardToken(runtime);
  const opsTriggerTokenMiddleware = requireOpsTriggerToken(runtime);
  const dashboardStaticDir = resolveDashboardStaticDir(runtime);
  const app = express();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post(
  "/api/ops/public-scan",
  express.json({ limit: "16kb" }),
  opsTriggerTokenMiddleware,
  async (req, res) => {
    const body = (req.body ?? {}) as PublicScanRequestBody;

    const owner = parseOwnerOrRepo(body.owner);
    const repo = parseOwnerOrRepo(body.repo);
    const maxOpenPrs = parseOptionalMaxOpenPrs(body.maxOpenPrs);
    const snapshotInput = parseOptionalSnapshot(body.snapshot);

    if (!owner || !repo) {
      res.status(400).json({
        error: {
          code: "BAD_REQUEST",
          message: "owner and repo are required and must match [A-Za-z0-9_.-]+",
        },
      });
      return;
    }

    if (maxOpenPrs === null) {
      res.status(400).json({
        error: {
          code: "BAD_REQUEST",
          message: "maxOpenPrs must be a positive integer between 1 and 1000 when provided",
        },
      });
      return;
    }

    if (snapshotInput === null) {
      res.status(400).json({
        error: {
          code: "BAD_REQUEST",
          message: "snapshot must be a string containing only [A-Za-z0-9._:-] and <= 120 chars",
        },
      });
      return;
    }

    const repoKey = normalizeRepoKey(owner, repo);
    if (!runtime.publicScanAllowedRepos.includes(repoKey)) {
      res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: `Repository ${repoKey} is not allowed for ops-triggered public scans`,
        },
      });
      return;
    }

    const payload: PublicPrScanJobPayload = {
      owner,
      repo,
      maxOpenPrs,
      snapshot: snapshotInput ?? makeSnapshotId(new Date()),
    };
    const jobId = buildPublicPrScanJobId(payload);

    try {
      await queue.addPublicPrScan(JOB_NAMES.publicPrScan, payload, {
        jobId,
        removeOnComplete: 100,
        removeOnFail: 100,
      });

      res.status(202).json({
        enqueued: true,
        jobId,
        owner: payload.owner,
        repo: payload.repo,
        snapshot: payload.snapshot,
      });
    } catch (error) {
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: (error as Error).message,
        },
      });
    }
  },
);

app.get("/api/repos", dashboardTokenMiddleware, async (_req, res) => {
  try {
    const repos = await storage.listRepositories();
    res.json({
      repos: repos.map((repo) => ({
        repoId: repo.repoId,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        isActive: repo.isActive,
        installationId: repo.installationId,
      })),
    });
  } catch (error) {
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: (error as Error).message,
      },
    });
  }
});

app.get("/api/repos/:repoId/triage-queue", dashboardTokenMiddleware, async (req, res) => {
  try {
    const repoId = parseRepoId(req.params.repoId);
    if (!repoId) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid repoId" },
      });
      return;
    }

    const state = parseState(req.query.state);
    if (!state) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid state" },
      });
      return;
    }

    const orderBy = parseOrderBy(req.query.orderBy);
    if (!orderBy) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid orderBy" },
      });
      return;
    }

    const needsReview = parseBoolean(req.query.needsReview, true);
    const limit = parsePositiveInt(req.query.limit, 50, 200);
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

    const result = await storage.listTriageQueue({
      repoId,
      state,
      needsReview,
      limit,
      cursor,
      reviewThreshold: runtime.reviewScoreThreshold,
      orderBy,
    });

    res.json({
      items: result.items.map((item) => normalizeQueueItem(item)),
      nextCursor: result.nextCursor,
    });
  } catch (error) {
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: (error as Error).message,
      },
    });
  }
});

app.get("/api/repos/:repoId/prs/:prNumber", dashboardTokenMiddleware, async (req, res) => {
  try {
    const repoId = parseRepoId(req.params.repoId);
    const prNumber = parsePrNumber(req.params.prNumber);

    if (!repoId || !prNumber) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid repoId or prNumber" },
      });
      return;
    }

    const pr = await storage.getPullRequestByNumber(repoId, prNumber);
    if (!pr) {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "PR not found" },
      });
      return;
    }

    const channels = await storage.getPullRequestChannelCounts(pr.prId, pr.headSha);

    res.json({
      repoId: pr.repoId,
      prNumber: pr.prNumber,
      prId: pr.prId,
      state: pr.state,
      isDraft: pr.isDraft,
      title: pr.title,
      body: pr.body,
      authorLogin: pr.authorLogin,
      url: pr.url,
      baseRef: pr.baseRef,
      baseSha: pr.baseSha,
      headRef: pr.headRef,
      headSha: pr.headSha,
      createdAt: pr.createdAt.toISOString(),
      updatedAt: pr.updatedAt.toISOString(),
      closedAt: pr.closedAt ? pr.closedAt.toISOString() : null,
      mergedAt: pr.mergedAt ? pr.mergedAt.toISOString() : null,
      analysis: {
        lastAnalyzedAt: pr.lastAnalyzedAt ? pr.lastAnalyzedAt.toISOString() : null,
        status: pr.analysisStatus,
        analysisRunId: pr.analysisRunId,
        signatureVersion: pr.signatureVersion,
        algorithmVersion: pr.algorithmVersion,
        configVersion: pr.configVersion,
        degradedReasons: pr.degradedReasons,
        finishedAt: pr.analysisFinishedAt ? pr.analysisFinishedAt.toISOString() : null,
        analysisError: pr.analysisError,
      },
      size: {
        changedFiles: pr.changedFiles,
        additions: pr.additions,
        deletions: pr.deletions,
      },
      channels,
    });
  } catch (error) {
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: (error as Error).message,
      },
    });
  }
});

app.get("/api/repos/:repoId/prs/:prNumber/candidates", dashboardTokenMiddleware, async (req, res) => {
  try {
    const repoId = parseRepoId(req.params.repoId);
    const prNumber = parsePrNumber(req.params.prNumber);

    if (!repoId || !prNumber) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid repoId or prNumber" },
      });
      return;
    }

    const limit = parsePositiveInt(req.query.limit, 10, 50);
    const minScore = parseMinScore(req.query.minScore, 0);
    const explicitHeadSha = req.query.headSha ? String(req.query.headSha) : null;

    const pr = await storage.getPullRequestByNumber(repoId, prNumber);
    if (!pr) {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "PR not found" },
      });
      return;
    }

    const targetHeadSha = explicitHeadSha ?? pr.lastAnalyzedHeadSha ?? pr.headSha;
    const analysisRunId = await storage.getLatestAnalysisRunId(repoId, pr.prId, targetHeadSha);

    if (!analysisRunId) {
      res.json({
        analysisRunId: null,
        prNumber: pr.prNumber,
        headSha: targetHeadSha,
        candidates: [],
      });
      return;
    }

    const candidates = await storage.getCandidatesForAnalysisRun(analysisRunId, limit, minScore);

    res.json({
      analysisRunId,
      prNumber: pr.prNumber,
      headSha: targetHeadSha,
      candidates: candidates.map((candidate) => ({
        candidatePrNumber: candidate.candidatePrNumber,
        candidatePrId: candidate.candidatePrId,
        candidateHeadSha: candidate.candidateHeadSha,
        candidateUrl: candidate.candidateUrl,
        rank: candidate.rank,
        category: candidate.category,
        finalScore: candidate.finalScore,
        scores: candidate.scores,
        evidence: candidate.evidence,
      })),
    });
  } catch (error) {
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: (error as Error).message,
      },
    });
  }
});

app.get("/api/repos/:repoId/duplicate-sets", dashboardTokenMiddleware, async (req, res) => {
  try {
    const repoId = parseRepoId(req.params.repoId);
    if (!repoId) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid repoId" },
      });
      return;
    }

    const state = parseState(req.query.state);
    if (!state) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid state" },
      });
      return;
    }

    const needsReview = parseBoolean(req.query.needsReview, true);
    const minScore = parseMinScore(req.query.minScore, runtime.reviewScoreThreshold);
    const limit = parsePositiveInt(req.query.limit, 20, 100);
    const includeCategories = parseIncludeCategories(req.query.includeCategories);

    if (!includeCategories) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid includeCategories" },
      });
      return;
    }

    const cursorRaw = req.query.cursor ? String(req.query.cursor) : null;
    const cursor = cursorRaw ? decodeDuplicateSetCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid cursor" },
      });
      return;
    }

    const nodes = await storage.listDuplicateSetNodes({
      repoId,
      state,
      needsReview,
      reviewThreshold: runtime.reviewScoreThreshold,
      maxNodes: DUPLICATE_SET_MAX_NODES,
    });

    const analysisRunIds = nodes.map((node) => node.analysisRunId);
    const edges = await storage.listDuplicateSetEdges({
      repoId,
      analysisRunIds,
      minScore,
      includeCategories,
    });

    let sets = buildDuplicateSets(nodes, edges);

    if (cursor) {
      const cursorSet: DuplicateSetSummary = {
        setId: cursor.setId,
        size: 0,
        maxScore: cursor.maxScore,
        categories: [],
        lastAnalyzedAt: new Date(cursor.lastAnalyzedAt),
        members: [],
        strongestEdges: [],
      };
      sets = sets.filter((set) => compareDuplicateSets(set, cursorSet) > 0);
    }

    const hasMore = sets.length > limit;
    const pageItems = hasMore ? sets.slice(0, limit) : sets;
    const last = pageItems.at(-1);

    res.json({
      sets: pageItems.map((set) => ({
        setId: set.setId,
        size: set.size,
        maxScore: set.maxScore,
        categories: set.categories,
        lastAnalyzedAt: set.lastAnalyzedAt.toISOString(),
        members: set.members.map((member) => ({
          prId: member.prId,
          prNumber: member.prNumber,
          headSha: member.headSha,
          title: member.title,
          url: member.url,
          state: member.state,
          lastAnalyzedAt: member.lastAnalyzedAt.toISOString(),
        })),
        strongestEdges: set.strongestEdges.map((edge) => ({
          fromPrNumber: edge.fromPrNumber,
          fromPrUrl: edge.fromPrUrl,
          toPrNumber: edge.toPrNumber,
          toPrUrl: edge.toPrUrl,
          category: edge.category,
          score: edge.score,
          evidence: edge.evidence,
        })),
      })),
      nextCursor:
        hasMore && last
          ? encodeDuplicateSetCursor({
              maxScore: last.maxScore,
              lastAnalyzedAt: last.lastAnalyzedAt.toISOString(),
              setId: last.setId,
            })
          : null,
    });
  } catch (error) {
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: (error as Error).message,
      },
    });
  }
});

app.post("/webhooks/github", express.raw({ type: "*/*" }), async (req, res) => {
  const deliveryId = req.header("x-github-delivery");
  const eventName = req.header("x-github-event");
  const signatureHeader = req.header("x-hub-signature-256") ?? undefined;

  if (!deliveryId || !eventName) {
    res.status(400).json({
      error: { code: "BAD_REQUEST", message: "Missing GitHub headers" },
    });
    return;
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""), "utf8");

  const verified = verifyWebhookSignature({
    rawBody,
    signatureHeader,
    secret: runtime.webhookSecret,
  });

  if (!verified) {
    res.status(401).json({
      error: { code: "INVALID_SIGNATURE", message: "Webhook signature verification failed" },
    });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    res.status(400).json({
      error: { code: "BAD_REQUEST", message: "Webhook payload must be valid JSON" },
    });
    return;
  }

  const repository = (payload.repository ?? null) as
    | {
        id?: number;
        owner?: { login?: string; type?: string };
        name?: string;
        default_branch?: string;
      }
    | null;

  const repoId = repository?.id ? Number(repository.id) : null;
  const action = payload.action ? String(payload.action) : null;

  try {
    const delivery = await storage.recordWebhookDeliveryReceived({
      deliveryId,
      repoId,
      eventName,
      action,
      payloadSha256: Storage.payloadSha256(rawBody),
    });

    if (!delivery.inserted && delivery.existingStatus !== "FAILED") {
      res.status(202).json({ duplicate: true });
      return;
    }

    if (!delivery.inserted && delivery.existingStatus === "FAILED") {
      await storage.markWebhookDeliveryStatus(deliveryId, "RECEIVED");
    }

    if (eventName !== "pull_request") {
      await storage.markWebhookDeliveryStatus(deliveryId, "SKIPPED");
      res.status(202).json({ skipped: true });
      return;
    }

    if (!action || !WEBHOOK_PROCESSABLE_PR_ACTIONS.has(action)) {
      await storage.markWebhookDeliveryStatus(deliveryId, "SKIPPED");
      res.status(202).json({ skipped: true });
      return;
    }

    const installation = (payload.installation ?? null) as
      | {
          id?: number;
          account?: { login?: string; type?: string };
        }
      | null;

    const pullRequest = (payload.pull_request ?? null) as
      | {
          id?: number;
          number?: number;
          head?: { sha?: string };
        }
      | null;

    if (
      !installation?.id ||
      !repository?.id ||
      !repository.owner?.login ||
      !repository.name ||
      !pullRequest?.id ||
      !pullRequest.number ||
      !pullRequest.head?.sha
    ) {
      await storage.markWebhookDeliveryStatus(deliveryId, "SKIPPED", "missing required pull_request payload fields");
      res.status(202).json({ skipped: true });
      return;
    }

    await storage.upsertInstallation({
      installationId: Number(installation.id),
      accountLogin: installation.account?.login ?? repository.owner.login,
      accountType: installation.account?.type ?? repository.owner.type ?? "Organization",
    });

    await storage.upsertRepository({
      repoId: Number(repository.id),
      installationId: Number(installation.id),
      owner: repository.owner.login,
      name: repository.name,
      defaultBranch: repository.default_branch ?? "main",
      isActive: true,
    });

    const jobPayload = {
      deliveryId,
      installationId: Number(installation.id),
      repoId: Number(repository.id),
      owner: repository.owner.login,
      repo: repository.name,
      prNumber: Number(pullRequest.number),
      prId: Number(pullRequest.id),
      headSha: pullRequest.head.sha,
      action,
    };

    await queue.addIngestPr(JOB_NAMES.ingestPr, jobPayload, {
      jobId: buildIngestPrJobId(jobPayload),
      removeOnComplete: 500,
      removeOnFail: 1000,
    });

    await storage.markWebhookDeliveryStatus(deliveryId, "PROCESSED");

    res.status(202).json({ enqueued: true });
  } catch (error) {
    await storage.markWebhookDeliveryStatus(deliveryId, "FAILED", (error as Error).message);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: (error as Error).message,
      },
    });
  }
});

if (dashboardStaticDir) {
  app.use(
    express.static(dashboardStaticDir, {
      index: false,
      maxAge: "1h",
    }),
  );

  app.get("*", (req, res, next) => {
    if (
      req.path.startsWith("/api/") ||
      req.path === "/api" ||
      req.path.startsWith("/webhooks/")
    ) {
      next();
      return;
    }

    res.sendFile(path.join(dashboardStaticDir, "index.html"));
  });
}

  return app;
}
