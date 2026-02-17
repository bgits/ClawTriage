import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ClassificationRules, Thresholds } from "./types.js";

function readYaml(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return YAML.parse(raw);
}

function resolveConfigPath(explicitPath: string | undefined, relativePath: string): string {
  if (explicitPath) {
    return explicitPath;
  }

  let currentDir = process.cwd();
  const visited = new Set<string>();

  while (!visited.has(currentDir)) {
    visited.add(currentDir);
    const candidate = path.resolve(currentDir, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  return path.resolve(process.cwd(), relativePath);
}

function assertNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid number for ${key}`);
  }
  return value;
}

function assertBoolean(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid boolean for ${key}`);
  }
  return value;
}

function assertStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid string[] for ${key}`);
  }
  return value;
}

export function loadClassificationRules(filePath?: string): ClassificationRules {
  const resolvedPath = resolveConfigPath(filePath, "config/classification_rules.yaml");
  const doc = readYaml(resolvedPath) as Record<string, unknown>;

  const channels = doc.channels as Record<string, unknown> | undefined;
  if (!channels) {
    throw new Error("classification rules missing channels");
  }
  const channelMap = channels;

  function parseChannel(channelKey: string): { path_globs: string[]; extensions: string[] } {
    const channel = channelMap[channelKey] as Record<string, unknown> | undefined;
    if (!channel) {
      throw new Error(`classification rules missing channel: ${channelKey}`);
    }
    return {
      path_globs: assertStringArray(channel.path_globs, `${channelKey}.path_globs`),
      extensions: assertStringArray(channel.extensions, `${channelKey}.extensions`),
    };
  }

  const astRefinements =
    (doc.ast_refinements as Record<string, unknown> | undefined) ?? undefined;

  return {
    version: assertNumber(doc.version, "classification.version"),
    channels: {
      tests: parseChannel("tests"),
      docs: parseChannel("docs"),
      meta: parseChannel("meta"),
      production: parseChannel("production"),
    },
    ast_refinements: astRefinements
      ? {
          test_framework_imports: assertStringArray(
            astRefinements.test_framework_imports,
            "ast_refinements.test_framework_imports",
          ),
          test_function_names: assertStringArray(
            astRefinements.test_function_names,
            "ast_refinements.test_function_names",
          ),
        }
      : undefined,
  };
}

export function loadThresholds(filePath?: string): Thresholds {
  const resolvedPath = resolveConfigPath(filePath, "config/thresholds.yaml");
  const doc = readYaml(resolvedPath) as Record<string, unknown>;

  const actions = doc.actions as Record<string, unknown>;
  const candidates = doc.candidates as Record<string, unknown>;
  const similarity = doc.similarity as Record<string, unknown>;
  const sameChange = similarity.same_change as Record<string, unknown>;
  const sameFeature = similarity.same_feature as Record<string, unknown>;
  const competingImpl = similarity.competing_impl as Record<string, unknown>;
  const caps = doc.caps as Record<string, unknown>;
  const weights = doc.weights as Record<string, unknown>;
  const productionWeights = weights.production as Record<string, unknown>;
  const testsWeights = weights.tests as Record<string, unknown>;
  const docsWeights = weights.docs as Record<string, unknown>;

  return {
    version: assertNumber(doc.version, "thresholds.version"),
    actions: {
      publish_check_run: assertBoolean(actions.publish_check_run, "actions.publish_check_run"),
      apply_labels: assertBoolean(actions.apply_labels, "actions.apply_labels"),
      post_comment_on_same_change: assertBoolean(
        actions.post_comment_on_same_change,
        "actions.post_comment_on_same_change",
      ),
    },
    candidates: {
      max_candidates_from_lsh: assertNumber(
        candidates.max_candidates_from_lsh,
        "candidates.max_candidates_from_lsh",
      ),
      max_candidates_final: assertNumber(
        candidates.max_candidates_final,
        "candidates.max_candidates_final",
      ),
      recent_pr_window_days: assertNumber(
        candidates.recent_pr_window_days,
        "candidates.recent_pr_window_days",
      ),
    },
    similarity: {
      same_change: {
        prod_minhash_threshold: assertNumber(
          sameChange.prod_minhash_threshold,
          "similarity.same_change.prod_minhash_threshold",
        ),
        prod_files_overlap_threshold: assertNumber(
          sameChange.prod_files_overlap_threshold,
          "similarity.same_change.prod_files_overlap_threshold",
        ),
      },
      same_feature: {
        prod_score_threshold: assertNumber(
          sameFeature.prod_score_threshold,
          "similarity.same_feature.prod_score_threshold",
        ),
        supporting_signal_min: assertNumber(
          sameFeature.supporting_signal_min,
          "similarity.same_feature.supporting_signal_min",
        ),
      },
      competing_impl: {
        tests_intent_threshold: assertNumber(
          competingImpl.tests_intent_threshold,
          "similarity.competing_impl.tests_intent_threshold",
        ),
        prod_score_max: assertNumber(
          competingImpl.prod_score_max,
          "similarity.competing_impl.prod_score_max",
        ),
      },
    },
    caps: {
      test_score_cap: assertNumber(caps.test_score_cap, "caps.test_score_cap"),
      doc_score_cap: assertNumber(caps.doc_score_cap, "caps.doc_score_cap"),
    },
    weights: {
      production: {
        minhash: assertNumber(productionWeights.minhash, "weights.production.minhash"),
        exports: assertNumber(productionWeights.exports, "weights.production.exports"),
        symbols: assertNumber(productionWeights.symbols, "weights.production.symbols"),
        files: assertNumber(productionWeights.files, "weights.production.files"),
        imports: assertNumber(productionWeights.imports, "weights.production.imports"),
      },
      tests: {
        intent: assertNumber(testsWeights.intent, "weights.tests.intent"),
      },
      docs: {
        structure: assertNumber(docsWeights.structure, "weights.docs.structure"),
      },
    },
    llm: doc.llm as Thresholds["llm"],
  };
}
