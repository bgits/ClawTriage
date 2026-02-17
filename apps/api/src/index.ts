import { Queue } from "bullmq";
import {
  QUEUE_NAMES,
  loadRuntimeConfig,
} from "@clawtriage/core";
import { Storage } from "@clawtriage/storage";
import { createApiApp } from "./app.js";

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

const app = createApiApp({
  runtime,
  storage,
  queue: {
    add: (name, data, opts) =>
      queue.add(name, data as { [key: string]: unknown }, {
        jobId: opts?.jobId,
        removeOnComplete: opts?.removeOnComplete ?? 500,
        removeOnFail: opts?.removeOnFail ?? 1000,
      }),
  },
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
