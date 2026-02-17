export interface GithubClientConfig {
  appId: number;
  privateKeyPem: string;
}

export interface GithubPullRequestFile {
  sha: string;
  filename: string;
  previousFilename: string | null;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  patch: string | null;
  truncated: boolean;
}

export interface GithubPullRequestData {
  id: number;
  number: number;
  state: "open" | "closed";
  mergedAt: string | null;
  draft: boolean;
  title: string;
  body: string | null;
  authorLogin: string | null;
  htmlUrl: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  headRepoFullName: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  files: GithubPullRequestFile[];
}

export interface CheckRunSummaryInput {
  installationId: number;
  owner: string;
  repo: string;
  headSha: string;
  name: string;
  title: string;
  summary: string;
  text?: string;
}
