import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import type {
  CheckRunSummaryInput,
  GithubClientConfig,
  GithubPullRequestData,
  GithubPullRequestFile,
  PublicGithubClientConfig,
  PublicPullRequestSummary,
  PublicRepositoryData,
} from "./types.js";

interface CachedToken {
  token: string;
  expiresAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const status = (error as { status?: number }).status;
      const response = error as {
        response?: {
          headers?: Record<string, string>;
        };
      };

      const retryAfter = response.response?.headers?.["retry-after"];
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 1000 * attempt;

      if (status === 502 || status === 503 || status === 429 || status === 403) {
        if (attempt === maxAttempts) {
          throw error;
        }
        await sleep(retryAfterMs);
        continue;
      }

      throw error;
    }
  }

  throw new Error("unreachable");
}

async function fetchPullRequestDataWithOctokit(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<GithubPullRequestData> {
  const prResponse = await withRetry(() =>
    params.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
    }),
  );

  const files = await withRetry(() =>
    params.octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
      per_page: 100,
    }),
  );

  const normalizedFiles: GithubPullRequestFile[] = files.map((file) => ({
    sha: file.sha,
    filename: file.filename,
    previousFilename: file.previous_filename ?? null,
    status: file.status as GithubPullRequestFile["status"],
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch ?? null,
    truncated: file.patch == null,
  }));

  const pr = prResponse.data;

  return {
    id: pr.id,
    number: pr.number,
    state: pr.state as "open" | "closed",
    mergedAt: pr.merged_at,
    draft: Boolean(pr.draft),
    title: pr.title,
    body: pr.body,
    authorLogin: pr.user?.login ?? null,
    htmlUrl: pr.html_url,
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    headRepoFullName: pr.head.repo?.full_name ?? null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    closedAt: pr.closed_at,
    files: normalizedFiles,
  };
}

export class GithubClient {
  private readonly auth;
  private readonly tokenCache = new Map<number, CachedToken>();

  constructor(private readonly config: GithubClientConfig) {
    this.auth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKeyPem,
    });
  }

  private async getInstallationToken(installationId: number): Promise<string> {
    const now = Date.now();
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt > now + 30_000) {
      return cached.token;
    }

    const authResult = await this.auth({
      type: "installation",
      installationId,
    });

    if (authResult.type !== "token") {
      throw new Error(`Unexpected auth result type: ${authResult.type}`);
    }

    const expiresAt = new Date(authResult.expiresAt).getTime();
    this.tokenCache.set(installationId, {
      token: authResult.token,
      expiresAt,
    });

    return authResult.token;
  }

  private async getOctokit(installationId: number): Promise<Octokit> {
    const token = await this.getInstallationToken(installationId);
    return new Octokit({ auth: token });
  }

  async fetchPullRequestData(params: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<GithubPullRequestData> {
    const octokit = await this.getOctokit(params.installationId);

    return fetchPullRequestDataWithOctokit({
      octokit,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
    });
  }

  async publishCheckRunSummary(input: CheckRunSummaryInput): Promise<void> {
    const octokit = await this.getOctokit(input.installationId);

    await withRetry(() =>
      octokit.request("POST /repos/{owner}/{repo}/check-runs", {
        owner: input.owner,
        repo: input.repo,
        name: input.name,
        head_sha: input.headSha,
        status: "completed",
        conclusion: "neutral",
        output: {
          title: input.title,
          summary: input.summary,
          text: input.text,
        },
      }),
    );
  }
}

export class PublicGithubClient {
  private readonly octokit: Octokit;

  constructor(config: PublicGithubClientConfig) {
    this.octokit = config.token ? new Octokit({ auth: config.token }) : new Octokit();
  }

  async fetchRepositoryData(params: {
    owner: string;
    repo: string;
  }): Promise<PublicRepositoryData> {
    const response = await withRetry(() =>
      this.octokit.request("GET /repos/{owner}/{repo}", {
        owner: params.owner,
        repo: params.repo,
      }),
    );

    return {
      id: response.data.id,
      ownerLogin: response.data.owner.login,
      ownerType: response.data.owner.type,
      name: response.data.name,
      defaultBranch: response.data.default_branch,
    };
  }

  async listOpenPullRequests(params: {
    owner: string;
    repo: string;
    maxOpenPrs?: number;
  }): Promise<PublicPullRequestSummary[]> {
    const pulls = await withRetry(() =>
      this.octokit.paginate("GET /repos/{owner}/{repo}/pulls", {
        owner: params.owner,
        repo: params.repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 100,
      }),
    );

    const normalized = pulls.map((pr) => ({
      id: pr.id,
      number: pr.number,
      headSha: pr.head.sha,
    }));

    if (params.maxOpenPrs && params.maxOpenPrs > 0) {
      return normalized.slice(0, params.maxOpenPrs);
    }

    return normalized;
  }

  async fetchPullRequestData(params: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<GithubPullRequestData> {
    return fetchPullRequestDataWithOctokit({
      octokit: this.octokit,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
    });
  }
}
