export type FileChannel = "PRODUCTION" | "TESTS" | "DOCS" | "META";

export type TriageCategory =
  | "SAME_CHANGE"
  | "SAME_FEATURE"
  | "COMPETING_IMPLEMENTATION"
  | "RELATED"
  | "NOT_RELATED"
  | "UNCERTAIN";

export interface ClassificationChannelRule {
  path_globs: string[];
  extensions: string[];
}

export interface ClassificationRules {
  version: number;
  channels: {
    tests: ClassificationChannelRule;
    docs: ClassificationChannelRule;
    meta: ClassificationChannelRule;
    production: ClassificationChannelRule;
  };
  ast_refinements?: {
    test_framework_imports?: string[];
    test_function_names?: string[];
  };
}

export interface Thresholds {
  version: number;
  actions: {
    publish_check_run: boolean;
    apply_labels: boolean;
    post_comment_on_same_change: boolean;
  };
  candidates: {
    max_candidates_from_lsh: number;
    max_candidates_final: number;
    recent_pr_window_days: number;
  };
  similarity: {
    same_change: {
      prod_minhash_threshold: number;
      prod_files_overlap_threshold: number;
    };
    same_feature: {
      prod_score_threshold: number;
      supporting_signal_min: number;
    };
    competing_impl: {
      tests_intent_threshold: number;
      prod_score_max: number;
    };
  };
  caps: {
    test_score_cap: number;
    doc_score_cap: number;
  };
  weights: {
    production: {
      minhash: number;
      exports: number;
      symbols: number;
      files: number;
      imports: number;
    };
    tests: {
      intent: number;
    };
    docs: {
      structure: number;
    };
  };
  llm?: {
    enabled: boolean;
    top_k: number;
    min_ambiguity_score: number;
  };
}

export interface ChangedFile {
  path: string;
  previousPath?: string | null;
  status: "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED";
  additions: number;
  deletions: number;
  patch?: string | null;
  patchTruncated?: boolean;
}

export interface ProductionSignature {
  canonicalDiffHash: string;
  canonicalText: string;
  minhash: Uint32Array;
  minhashShingleCount: number;
  shingles: Set<string>;
}

export interface PairScores {
  prodDiffExact: number;
  prodMinhash: number;
  prodFiles: number;
  prodExports: number;
  prodSymbols: number;
  prodImports: number;
  testsIntent: number;
  docsStruct: number;
}

export interface ScoredCategory {
  category: TriageCategory;
  finalScore: number;
  prodScore: number;
}

export interface TestIntent {
  suiteNames: string[];
  testNames: string[];
  matchers: string[];
  importsUnderTest: string[];
}

export interface DocsStructure {
  headings: string[];
  codeFences: string[];
  references: string[];
}

export interface RuntimeConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  webhookSecret: string;
  githubAppId: number;
  githubPrivateKeyPem: string;
  dashboardToken?: string;
  dashboardAuthMode: "auto" | "required" | "disabled";
  workerConcurrency: number;
  checkRunName: string;
  signatureVersion: number;
  algorithmVersion: number;
  reviewScoreThreshold: number;
}
