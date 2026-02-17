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

export function loadRuntimeConfig(): RuntimeConfig {
  const githubAppIdValue = requireEnv("GITHUB_APP_ID");
  const githubAppId = Number(githubAppIdValue);

  if (!Number.isInteger(githubAppId) || githubAppId <= 0) {
    throw new Error(`Invalid GITHUB_APP_ID: ${githubAppIdValue}`);
  }

  return {
    port: parseNumber("PORT", 3000),
    databaseUrl: requireEnv("DATABASE_URL"),
    redisUrl: requireEnv("REDIS_URL"),
    webhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET"),
    githubAppId,
    githubPrivateKeyPem: requireEnv("GITHUB_PRIVATE_KEY_PEM").replace(/\\n/g, "\n"),
    dashboardToken: process.env.DASHBOARD_TOKEN,
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
