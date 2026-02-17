import { Queue } from "bullmq";
import {
  JOB_NAMES,
  QUEUE_NAMES,
  buildPublicPrScanJobId,
  type PublicPrScanJobPayload,
} from "@clawtriage/core";

interface ParsedArgs {
  owner: string;
  repo: string;
  maxOpenPrs?: number;
  snapshot: string;
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm public:scan --owner <owner> --repo <repo> [--limit <n>] [--snapshot <id>]",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args.set(key, value);
    i += 1;
  }

  const owner = args.get("owner");
  const repo = args.get("repo");
  if (!owner || !repo) {
    throw new Error("Both --owner and --repo are required.");
  }

  const limitRaw = args.get("limit");
  let maxOpenPrs: number | undefined;
  if (limitRaw) {
    const parsedLimit = Number(limitRaw);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      throw new Error("--limit must be a positive integer when provided.");
    }
    maxOpenPrs = parsedLimit;
  }

  const snapshot =
    args.get("snapshot") ?? new Date().toISOString().replace(/[^0-9a-z]/gi, "-").toLowerCase();

  return {
    owner,
    repo,
    maxOpenPrs,
    snapshot,
  };
}

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

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required");
  }

  const parsed = parseArgs(process.argv.slice(2));

  const payload: PublicPrScanJobPayload = {
    owner: parsed.owner,
    repo: parsed.repo,
    snapshot: parsed.snapshot,
    maxOpenPrs: parsed.maxOpenPrs,
  };

  const queue = new Queue<PublicPrScanJobPayload>(QUEUE_NAMES.publicPrScan, {
    connection: toBullMqConnection(redisUrl),
  });

  try {
    const job = await queue.add(JOB_NAMES.publicPrScan, payload, {
      jobId: buildPublicPrScanJobId(payload),
      removeOnComplete: 100,
      removeOnFail: 100,
    });

    // eslint-disable-next-line no-console
    console.log(
      `Enqueued public scan job ${job.id} for ${payload.owner}/${payload.repo}` +
        (payload.maxOpenPrs ? ` (limit ${payload.maxOpenPrs})` : ""),
    );
  } finally {
    await queue.close();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error.message);
  // eslint-disable-next-line no-console
  console.error(usage());
  process.exitCode = 1;
});
