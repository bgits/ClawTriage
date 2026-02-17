export const SIGNATURE_VERSION = 1;
export const ALGORITHM_VERSION = 1;

export const CHANNEL_ORDER = ["META", "TESTS", "DOCS", "PRODUCTION"] as const;

export const INTERNAL_PUBLIC_INSTALLATION_ID = 0;

export const QUEUE_NAMES = {
  ingestPr: "ingest-pr",
  publicPrScan: "public-pr-scan",
} as const;

export const JOB_NAMES = {
  ingestPr: "ingest-pr",
  publicPrScan: "public-pr-scan",
} as const;

export const DEFAULT_REVIEW_SCORE_THRESHOLD = 0.55;

export const LSH_BAND_SIZE = 8;
export const MINHASH_SIZE = 128;

export const WEBHOOK_PROCESSABLE_PR_ACTIONS = new Set([
  "opened",
  "edited",
  "reopened",
  "synchronize",
  "closed",
]);
