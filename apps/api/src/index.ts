import express, { type NextFunction, type Request, type Response } from "express";
import { Queue } from "bullmq";
import {
  JOB_NAMES,
  QUEUE_NAMES,
  WEBHOOK_PROCESSABLE_PR_ACTIONS,
  buildIngestPrJobId,
  loadRuntimeConfig,
} from "@clawtriage/core";
import { verifyWebhookSignature } from "@clawtriage/github";
import { Storage } from "@clawtriage/storage";

const runtime = loadRuntimeConfig();
const storage = new Storage();

function toBullMqConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  const db = parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) : 0;

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number.isFinite(db) ? db : 0,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null as number | null,
  };
}

const queue = new Queue(QUEUE_NAMES.ingestPr, {
  connection: toBullMqConnection(runtime.redisUrl),
});

const app = express();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

function requireDashboardToken(req: Request, res: Response, next: NextFunction): void {
  if (!runtime.dashboardToken) {
    next();
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
}

app.get("/api/repos/:repoId/triage-queue", requireDashboardToken, async (req, res) => {
  try {
    const repoId = Number(req.params.repoId);
    if (!Number.isInteger(repoId) || repoId <= 0) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid repoId" },
      });
      return;
    }

    const state = String(req.query.state ?? "OPEN").toUpperCase();
    if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Invalid state" },
      });
      return;
    }

    const needsReviewRaw = String(req.query.needsReview ?? "true").toLowerCase();
    const needsReview = needsReviewRaw !== "false";

    const requestedLimit = Number(req.query.limit ?? 50);
    const limit = Math.max(1, Math.min(200, Number.isFinite(requestedLimit) ? requestedLimit : 50));

    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

    const result = await storage.listTriageQueue({
      repoId,
      state,
      needsReview,
      limit,
      cursor,
      reviewThreshold: runtime.reviewScoreThreshold,
    });

    res.json({
      items: result.items.map((item) => ({
        repoId: item.repoId,
        prNumber: item.prNumber,
        prId: item.prId,
        headSha: item.headSha,
        title: item.title,
        authorLogin: item.authorLogin,
        state: item.state,
        updatedAt: item.updatedAt.toISOString(),
        analysisStatus: item.analysisStatus,
        topSuggestion: item.topSuggestion,
        needsReview: item.needsReview,
      })),
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

    await queue.add(JOB_NAMES.ingestPr, jobPayload, {
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

const server = app.listen(runtime.port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on port ${runtime.port}`);
});

async function shutdown() {
  server.close();
  await queue.close();
  await storage.close();
}

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
