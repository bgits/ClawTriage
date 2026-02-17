export type PrState = "OPEN" | "CLOSED" | "MERGED";

export type TriageCategory =
  | "SAME_CHANGE"
  | "SAME_FEATURE"
  | "COMPETING_IMPLEMENTATION"
  | "RELATED"
  | "NOT_RELATED"
  | "UNCERTAIN";

export interface Repo {
  repoId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  isActive: boolean;
  installationId: number;
}

export interface TriageQueueItem {
  repoId: number;
  prNumber: number;
  prId: number;
  headSha: string;
  prUrl: string;
  title: string;
  authorLogin: string | null;
  state: PrState;
  updatedAt: string;
  lastAnalyzedAt: string | null;
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

export interface TriageQueueResponse {
  items: TriageQueueItem[];
  nextCursor: string | null;
}

export interface DuplicateSetMember {
  prId: number;
  prNumber: number;
  headSha: string;
  title: string;
  url: string;
  state: PrState;
  lastAnalyzedAt: string;
}

export interface DuplicateSetStrongestEdge {
  fromPrNumber: number;
  fromPrUrl: string;
  toPrNumber: number;
  toPrUrl: string;
  category: TriageCategory;
  score: number;
  evidence: unknown;
}

export interface DuplicateSet {
  setId: string;
  size: number;
  maxScore: number;
  categories: TriageCategory[];
  lastAnalyzedAt: string;
  members: DuplicateSetMember[];
  strongestEdges: DuplicateSetStrongestEdge[];
}

export interface DuplicateSetResponse {
  sets: DuplicateSet[];
  nextCursor: string | null;
}
