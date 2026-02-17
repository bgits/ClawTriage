import type { FileChannel, TriageCategory } from "@clawtriage/core";

export interface WebhookDeliveryInput {
  deliveryId: string;
  repoId: number | null;
  eventName: string;
  action: string | null;
  payloadSha256: string;
}

export interface InstallationUpsertInput {
  installationId: number;
  accountLogin: string;
  accountType: string;
}

export interface RepositoryUpsertInput {
  repoId: number;
  installationId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  isActive?: boolean;
}

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

export interface PullRequestUpsertInput {
  prId: number;
  repoId: number;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
  title: string;
  body: string | null;
  authorLogin: string | null;
  url: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headRepoFullName: string | null;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  mergedAt: Date | null;
  lastIngestedDeliveryId: string;
  analysisStatus?: "PENDING" | "RUNNING" | "DONE" | "DEGRADED" | "FAILED";
}

export interface PrFileInput {
  repoId: number;
  prId: number;
  headSha: string;
  path: string;
  previousPath: string | null;
  status: "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED";
  additions: number;
  deletions: number;
  patchTruncated: boolean;
  channel: FileChannel;
  detectedLanguage: string | null;
}

export interface ChannelSignatureInput {
  prId: number;
  repoId: number;
  headSha: string;
  channel: FileChannel;
  signatureVersion: number;
  canonicalDiffHash?: string | null;
  minhash?: Buffer | null;
  minhashShingleCount?: number;
  exportsJson?: unknown;
  symbolsJson?: unknown;
  importsJson?: unknown;
  testIntentJson?: unknown;
  docStructureJson?: unknown;
  sizeMetricsJson?: unknown;
  errorsJson?: unknown;
}

export interface ChangedPathInput {
  repoId: number;
  prId: number;
  headSha: string;
  channel: FileChannel;
  path: string;
  dirPrefix1: string | null;
  dirPrefix2: string | null;
  dirPrefix3: string | null;
}

export interface SymbolInput {
  repoId: number;
  prId: number;
  headSha: string;
  symbol: string;
  kind: "decl" | "export" | "import";
}

export interface AnalysisRunInput {
  analysisRunId: string;
  repoId: number;
  prId: number;
  headSha: string;
  signatureVersion: number;
  algorithmVersion: number;
  configVersion: number;
  status: "PENDING" | "RUNNING" | "DONE" | "DEGRADED" | "FAILED";
  startedAt: Date;
}

export interface CandidateEdgeInput {
  analysisRunId: string;
  repoId: number;
  prIdA: number;
  headShaA: string;
  prIdB: number;
  headShaB: string;
  rank: number;
  category: TriageCategory;
  finalScore: number;
  scoresJson: unknown;
  evidenceJson: unknown;
}

export interface CandidateRef {
  prId: number;
  headSha: string;
}

export interface ProductionSignatureRow {
  prId: number;
  headSha: string;
  canonicalDiffHash: string | null;
  minhash: Buffer | null;
  minhashShingleCount: number;
  exportsJson: string[];
  symbolsJson: string[];
  importsJson: string[];
  testIntentJson: {
    suiteNames: string[];
    testNames: string[];
    matchers: string[];
    importsUnderTest: string[];
  } | null;
  docStructureJson: {
    headings: string[];
    codeFences: string[];
    references: string[];
  } | null;
}

export interface TriageQueueItem {
  repoId: number;
  prNumber: number;
  prId: number;
  headSha: string;
  prUrl: string;
  title: string;
  authorLogin: string | null;
  state: PullRequestState;
  updatedAt: Date;
  lastAnalyzedAt: Date | null;
  analysisStatus: "PENDING" | "RUNNING" | "DONE" | "DEGRADED" | "FAILED";
  analysisRunId: string | null;
  topSuggestion: {
    category: TriageCategory;
    candidatePrNumber: number;
    candidatePrUrl: string;
    score: number;
  } | null;
  needsReview: boolean;
}

export interface TriageQueueResult {
  items: TriageQueueItem[];
  nextCursor: string | null;
}

export interface RepoListItem {
  repoId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  isActive: boolean;
  installationId: number;
}

export interface PullRequestDetailRow {
  repoId: number;
  prId: number;
  prNumber: number;
  state: PullRequestState;
  isDraft: boolean;
  title: string;
  body: string | null;
  authorLogin: string | null;
  url: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  mergedAt: Date | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  analysisStatus: "PENDING" | "RUNNING" | "DONE" | "DEGRADED" | "FAILED";
  analysisError: string | null;
  lastAnalyzedHeadSha: string | null;
  lastAnalyzedAt: Date | null;
  analysisRunId: string | null;
  signatureVersion: number | null;
  algorithmVersion: number | null;
  configVersion: number | null;
  degradedReasons: unknown;
  analysisFinishedAt: Date | null;
}

export interface PullRequestChannelCounts {
  productionFiles: number;
  testFiles: number;
  docFiles: number;
  metaFiles: number;
}

export interface CandidateListItem {
  analysisRunId: string;
  prNumber: number;
  headSha: string;
  candidatePrNumber: number;
  candidatePrId: number;
  candidateHeadSha: string;
  candidateUrl: string;
  rank: number;
  category: TriageCategory;
  finalScore: number;
  scores: {
    prodDiffExact: number;
    prodMinhash: number;
    prodFiles: number;
    prodExports: number;
    prodSymbols: number;
    prodImports: number;
    testsIntent: number;
    docsStruct: number;
  };
  evidence: {
    overlappingProductionPaths: string[];
    overlappingExports: string[];
    overlappingSymbols: string[];
    overlappingImports: string[];
    testsIntentOverlap: {
      suiteNames: string[];
      testNames: string[];
      matchers: string[];
    };
    docsOverlap: {
      headings: string[];
      codeFences: string[];
    };
    similarityValues: {
      prodDiffExact: number;
      prodMinhash: number;
      prodFiles: number;
      prodExports: number;
      prodSymbols: number;
      prodImports: number;
      testsIntent: number;
      docsStruct: number;
    };
  };
}

export interface DuplicateSetNode {
  prId: number;
  prNumber: number;
  headSha: string;
  title: string;
  url: string;
  state: PullRequestState;
  lastAnalyzedAt: Date;
  analysisRunId: string;
}

export interface DuplicateSetEdge {
  prIdA: number;
  headShaA: string;
  prIdB: number;
  headShaB: string;
  category: TriageCategory;
  finalScore: number;
  evidence: unknown;
}
