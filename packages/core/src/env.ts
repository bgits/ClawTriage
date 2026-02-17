import {
  ALGORITHM_VERSION,
  DEFAULT_REVIEW_SCORE_THRESHOLD,
  SIGNATURE_VERSION,
} from "./constants.js";
import type { RuntimeConfig } from "./types.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseNumber(name: string, fallback?: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Missing numeric environment variable: ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric environment variable ${name}: ${value}`);
  }
  return parsed;
}

function parseDashboardAuthMode(): "auto" | "required" | "disabled" {
  const raw = (process.env.DASHBOARD_AUTH_MODE ?? "auto").toLowerCase();
  if (raw === "auto" || raw === "required" || raw === "disabled") {
    return raw;
  }
  throw new Error(
    `Invalid DASHBOARD_AUTH_MODE: ${raw}. Expected one of auto|required|disabled`,
  );
}

function parseGithubMode(): "public" | "app" | "hybrid" {
  const raw = (process.env.GITHUB_MODE ?? "public").toLowerCase();
  if (raw === "public" || raw === "app" || raw === "hybrid") {
    return raw;
  }
  throw new Error(`Invalid GITHUB_MODE: ${raw}. Expected one of public|app|hybrid`);
}

function parseOptionalGithubAppId(): number | undefined {
  const raw = process.env.GITHUB_APP_ID?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid GITHUB_APP_ID: ${raw}`);
  }

  return parsed;
}

function parseOptionalGithubPrivateKeyPem(): string | undefined {
  const raw = process.env.GITHUB_PRIVATE_KEY_PEM?.trim();
  if (!raw) {
    return undefined;
  }
  return raw.replace(/\\n/g, "\n");
}

function parseOptionalWebhookSecret(): string | undefined {
  const raw = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!raw) {
    return undefined;
  }
  return raw;
}

function parsePublicScanAllowedRepos(): string[] {
  const raw = process.env.PUBLIC_SCAN_ALLOWED_REPOS ?? "";
  if (raw.trim() === "") {
    return [];
  }

  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(entry)) {
      throw new Error(
        `Invalid PUBLIC_SCAN_ALLOWED_REPOS entry: ${entry}. Expected owner/repo`,
      );
    }
  }

  return Array.from(new Set(entries));
}

export function loadRuntimeConfig(): RuntimeConfig {
  const githubMode = parseGithubMode();
  const githubAppId = parseOptionalGithubAppId();
  const githubPrivateKeyPem = parseOptionalGithubPrivateKeyPem();
  const webhookSecret = parseOptionalWebhookSecret();

  if (githubMode !== "public") {
    if (!githubAppId || !githubPrivateKeyPem || !webhookSecret) {
      throw new Error(
        "GITHUB_MODE is app/hybrid, but one or more required vars are missing: GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PEM, GITHUB_WEBHOOK_SECRET",
      );
    }
  }

  return {
    port: parseNumber("PORT", 3000),
    databaseUrl: requireEnv("DATABASE_URL"),
    redisUrl: requireEnv("REDIS_URL"),
    githubMode,
    webhookSecret,
    githubAppId,
    githubPrivateKeyPem,
    dashboardToken: process.env.DASHBOARD_TOKEN,
    dashboardAuthMode: parseDashboardAuthMode(),
    dashboardStaticDir: process.env.DASHBOARD_STATIC_DIR?.trim() || undefined,
    opsTriggerToken: process.env.OPS_TRIGGER_TOKEN?.trim() || undefined,
    publicScanAllowedRepos: parsePublicScanAllowedRepos(),
    workerConcurrency: parseNumber("WORKER_CONCURRENCY", 4),
    checkRunName: process.env.CHECK_RUN_NAME ?? "ClawTriage Duplicate Triage",
    signatureVersion: parseNumber("SIGNATURE_VERSION", SIGNATURE_VERSION),
    algorithmVersion: parseNumber("ALGORITHM_VERSION", ALGORITHM_VERSION),
    reviewScoreThreshold: parseNumber(
      "REVIEW_SCORE_THRESHOLD",
      DEFAULT_REVIEW_SCORE_THRESHOLD,
    ),
  };
}
