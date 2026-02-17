import type {
  DuplicateSetResponse,
  Repo,
  TriageCategory,
  TriageQueueResponse,
} from "./types";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const DASHBOARD_TOKEN = import.meta.env.VITE_DASHBOARD_TOKEN;

function toQueryString(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }

    params.set(key, String(value));
  }

  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

async function apiGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (DASHBOARD_TOKEN && DASHBOARD_TOKEN.trim().length > 0) {
    headers.Authorization = `Bearer ${DASHBOARD_TOKEN.trim()}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;

    throw new Error(payload?.error?.message ?? `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function listRepos(): Promise<Repo[]> {
  const payload = await apiGet<{ repos: Repo[] }>("/api/repos");
  return payload.repos;
}

export async function listTriageQueue(params: {
  repoId: number;
  needsReview: boolean;
}): Promise<TriageQueueResponse> {
  const query = toQueryString({
    state: "OPEN",
    needsReview: params.needsReview,
    limit: 50,
    orderBy: "LAST_ANALYZED_AT",
  });

  return apiGet<TriageQueueResponse>(`/api/repos/${params.repoId}/triage-queue${query}`);
}

export async function listDuplicateSets(params: {
  repoId: number;
  needsReview: boolean;
  minScore: number;
  includeCategories: TriageCategory[];
}): Promise<DuplicateSetResponse> {
  const includeCategories =
    params.includeCategories.length >= 6
      ? "ALL_ABOVE_THRESHOLD"
      : params.includeCategories.join(",");

  const query = toQueryString({
    state: "OPEN",
    needsReview: params.needsReview,
    minScore: params.minScore,
    limit: 40,
    includeCategories,
  });

  return apiGet<DuplicateSetResponse>(`/api/repos/${params.repoId}/duplicate-sets${query}`);
}
