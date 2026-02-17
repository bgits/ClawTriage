import { useEffect, useMemo, useState } from "react";
import { listDuplicateSets, listRepos, listTriageQueue } from "./api";
import type {
  DuplicateSet,
  TriageCategory,
  TriageQueueItem,
} from "./types";

const CATEGORY_OPTIONS: TriageCategory[] = [
  "SAME_CHANGE",
  "SAME_FEATURE",
  "COMPETING_IMPLEMENTATION",
  "RELATED",
  "NOT_RELATED",
  "UNCERTAIN",
];

const CONFIGURED_REPO_ID_RAW = (import.meta.env.VITE_DASHBOARD_REPO_ID ?? "").trim();
const CONFIGURED_REPO_OWNER = (import.meta.env.VITE_DASHBOARD_REPO_OWNER ?? "").trim();
const CONFIGURED_REPO_NAME = (import.meta.env.VITE_DASHBOARD_REPO_NAME ?? "").trim();
const HAS_CONFIGURED_REPO_ID = CONFIGURED_REPO_ID_RAW.length > 0;

function parseConfiguredRepoId(): number | null {
  if (!HAS_CONFIGURED_REPO_ID) {
    return null;
  }

  const repoId = Number(CONFIGURED_REPO_ID_RAW);
  if (!Number.isInteger(repoId) || repoId <= 0) {
    return null;
  }

  return repoId;
}

const CONFIGURED_REPO_ID = parseConfiguredRepoId();
const CONFIGURED_REPO_LABEL =
  CONFIGURED_REPO_OWNER.length > 0 && CONFIGURED_REPO_NAME.length > 0
    ? `${CONFIGURED_REPO_OWNER}/${CONFIGURED_REPO_NAME}`
    : null;

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function summarizeEvidence(evidence: unknown): string {
  if (!evidence || typeof evidence !== "object") {
    return "No structured evidence.";
  }

  const record = evidence as {
    overlappingProductionPaths?: unknown;
    overlappingExports?: unknown;
    overlappingSymbols?: unknown;
  };

  const paths = toStringList(record.overlappingProductionPaths).slice(0, 2);
  const exportsList = toStringList(record.overlappingExports).slice(0, 2);
  const symbols = toStringList(record.overlappingSymbols).slice(0, 2);

  const parts: string[] = [];
  if (paths.length > 0) {
    parts.push(`paths: ${paths.join(", ")}`);
  }
  if (exportsList.length > 0) {
    parts.push(`exports: ${exportsList.join(", ")}`);
  }
  if (symbols.length > 0) {
    parts.push(`symbols: ${symbols.join(", ")}`);
  }

  if (parts.length === 0) {
    return "Evidence available in API payload.";
  }

  return parts.join(" | ");
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  return date.toLocaleString();
}

function categoryClass(category: TriageCategory): string {
  switch (category) {
    case "SAME_CHANGE":
      return "badge same-change";
    case "SAME_FEATURE":
      return "badge same-feature";
    case "COMPETING_IMPLEMENTATION":
      return "badge competing";
    case "RELATED":
      return "badge related";
    case "NOT_RELATED":
      return "badge not-related";
    case "UNCERTAIN":
      return "badge uncertain";
    default:
      return "badge";
  }
}

export default function App() {
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(CONFIGURED_REPO_ID);
  const [repoDisplayName, setRepoDisplayName] = useState<string>(
    CONFIGURED_REPO_LABEL ?? (CONFIGURED_REPO_ID ? `repo:${CONFIGURED_REPO_ID}` : "Loading..."),
  );
  const [needsReview, setNeedsReview] = useState(true);
  const [minScore, setMinScore] = useState(0.55);
  const [categories, setCategories] = useState<TriageCategory[]>([...CATEGORY_OPTIONS]);

  const [duplicateSets, setDuplicateSets] = useState<DuplicateSet[]>([]);
  const [triageRuns, setTriageRuns] = useState<TriageQueueItem[]>([]);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);

  const [isLoadingData, setIsLoadingData] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (HAS_CONFIGURED_REPO_ID && !CONFIGURED_REPO_ID) {
      setErrorMessage(
        "Invalid VITE_DASHBOARD_REPO_ID. Set it to a positive integer.",
      );
      setSelectedRepoId(null);
      return;
    }

    let cancelled = false;

    setErrorMessage(null);
    listRepos()
      .then((result) => {
        if (cancelled) {
          return;
        }

        if (result.length === 0) {
          setSelectedRepoId(null);
          setRepoDisplayName("No repositories");
          setErrorMessage("No repositories available for this dashboard.");
          return;
        }

        const configuredRepo =
          CONFIGURED_REPO_ID !== null
            ? result.find((repo) => repo.repoId === CONFIGURED_REPO_ID) ?? null
            : null;

        if (CONFIGURED_REPO_ID !== null && !configuredRepo) {
          setSelectedRepoId(null);
          setErrorMessage(
            `Configured repository id ${CONFIGURED_REPO_ID} is not available to this dashboard.`,
          );
          return;
        }

        const activeRepo = configuredRepo ?? result[0];
        setSelectedRepoId(activeRepo.repoId);
        setRepoDisplayName(CONFIGURED_REPO_LABEL ?? `${activeRepo.owner}/${activeRepo.name}`);
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedRepoId) {
      return;
    }

    let cancelled = false;
    setIsLoadingData(true);
    setErrorMessage(null);

    Promise.all([
      listDuplicateSets({
        repoId: selectedRepoId,
        needsReview,
        minScore,
        includeCategories: categories,
      }),
      listTriageQueue({
        repoId: selectedRepoId,
        needsReview,
      }),
    ])
      .then(([setResponse, queueResponse]) => {
        if (cancelled) {
          return;
        }

        setDuplicateSets(Array.isArray(setResponse.sets) ? setResponse.sets : []);
        setTriageRuns(Array.isArray(queueResponse.items) ? queueResponse.items : []);
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setErrorMessage(error.message);
          setDuplicateSets([]);
          setTriageRuns([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingData(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRepoId, needsReview, minScore, categories]);

  useEffect(() => {
    if (duplicateSets.length === 0) {
      setSelectedSetId(null);
      return;
    }

    const hasSelected = selectedSetId && duplicateSets.some((set) => set.setId === selectedSetId);
    if (!hasSelected) {
      setSelectedSetId(duplicateSets[0].setId);
    }
  }, [duplicateSets, selectedSetId]);

  const selectedSet = useMemo(
    () => duplicateSets.find((set) => set.setId === selectedSetId) ?? null,
    [duplicateSets, selectedSetId],
  );

  const toggleCategory = (category: TriageCategory) => {
    setCategories((current) => {
      const exists = current.includes(category);
      if (!exists) {
        return [...current, category];
      }

      if (current.length === 1) {
        return current;
      }

      return current.filter((entry) => entry !== category);
    });
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand-block">
          <h1>ClawTriage Dashboard</h1>
          <p>Recent run outcomes, potential duplicate sets, and direct PR links for review.</p>
        </div>

        <div className="controls">
          <label>
            Repository
            <div data-testid="repository-display" className="repo-display">
              {repoDisplayName}
            </div>
          </label>

          <label>
            Min score: <strong>{minScore.toFixed(2)}</strong>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={minScore}
              onChange={(event) => setMinScore(Number(event.target.value))}
            />
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={needsReview}
              onChange={(event) => setNeedsReview(event.target.checked)}
            />
            Needs review only
          </label>
        </div>
      </header>

      <section className="category-filter" aria-label="Category filters">
        <div className="category-filter-head">
          <strong>Filter categories</strong>
          <span>
            {categories.length}/{CATEGORY_OPTIONS.length} selected
          </span>
        </div>

        <div className="category-toggle-list" role="group" aria-label="Duplicate set categories">
          {CATEGORY_OPTIONS.map((category) => {
            const active = categories.includes(category);
            const isLastActive = active && categories.length === 1;
            return (
              <button
                key={category}
                aria-pressed={active}
                className={active ? "category-toggle active" : "category-toggle"}
                disabled={isLastActive}
                onClick={() => toggleCategory(category)}
                title={
                  isLastActive
                    ? "At least one category must remain selected."
                    : active
                      ? "Selected. Click to remove this filter."
                      : "Not selected. Click to include this filter."
                }
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={active ? "category-toggle-indicator active" : "category-toggle-indicator"}
                >
                  {active ? "✓" : ""}
                </span>
                <span>{category}</span>
              </button>
            );
          })}
        </div>
      </section>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <main className="main-grid">
        <section className="panel sets-panel">
          <div className="panel-header">
            <h2>Potential Duplicate Sets</h2>
            <span>{duplicateSets.length} sets</span>
          </div>

          {isLoadingData ? <p className="loading">Loading duplicate sets...</p> : null}
          {!isLoadingData && duplicateSets.length === 0 ? (
            <p className="empty">No duplicate sets matched the current filters.</p>
          ) : null}

          <div className="set-list">
            {duplicateSets.map((set) => (
              <button
                data-testid={`set-item-${set.setId}`}
                type="button"
                key={set.setId}
                className={selectedSetId === set.setId ? "set-card active" : "set-card"}
                onClick={() => setSelectedSetId(set.setId)}
              >
                <div className="set-card-head">
                  <strong>Set {set.setId}</strong>
                  <span>{set.size} PRs</span>
                </div>
                <div className="set-card-meta">
                  <span>Max score {set.maxScore.toFixed(3)}</span>
                  <span>{formatTimestamp(set.lastAnalyzedAt)}</span>
                </div>
                <div className="badge-row">
                  {set.categories.map((category) => (
                    <span key={category} className={categoryClass(category)}>
                      {category}
                    </span>
                  ))}
                </div>
                <div className="member-chip-row">
                  {set.members.slice(0, 5).map((member) => (
                    <span key={`${set.setId}-${member.prId}`} className="member-chip">
                      #{member.prNumber}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel detail-panel">
          <div className="panel-header">
            <h2>Set Details</h2>
            <span>{selectedSet ? `Set ${selectedSet.setId}` : "No set selected"}</span>
          </div>

          {!selectedSet ? <p className="empty">Select a set to inspect member PRs and strongest links.</p> : null}

          {selectedSet ? (
            <>
              <div className="detail-block">
                <h3>Members</h3>
                <ul className="member-list">
                  {selectedSet.members.map((member) => (
                    <li key={`${member.prId}:${member.headSha}`}>
                      <a href={member.url} target="_blank" rel="noreferrer">
                        #{member.prNumber}
                      </a>
                      <span className="member-title">{member.title}</span>
                      <span className="member-sha">{shortSha(member.headSha)}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="detail-block">
                <h3>Strongest Edges</h3>
                {selectedSet.strongestEdges.length === 0 ? <p className="empty">No edge evidence available.</p> : null}
                <ul className="edge-list">
                  {selectedSet.strongestEdges.map((edge, index) => (
                    <li key={`${selectedSet.setId}-edge-${index}`}>
                      <div className="edge-head">
                        <a href={edge.fromPrUrl} target="_blank" rel="noreferrer">
                          #{edge.fromPrNumber}
                        </a>
                        <span>↔</span>
                        <a href={edge.toPrUrl} target="_blank" rel="noreferrer">
                          #{edge.toPrNumber}
                        </a>
                        <span className={categoryClass(edge.category)}>{edge.category}</span>
                        <strong>{edge.score.toFixed(3)}</strong>
                      </div>
                      <p>{summarizeEvidence(edge.evidence)}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : null}
        </section>

        <aside className="panel runs-panel">
          <div className="panel-header">
            <h2>Most Recent Runs</h2>
            <span>{triageRuns.length} PRs</span>
          </div>

          {isLoadingData ? <p className="loading">Loading run results...</p> : null}
          {!isLoadingData && triageRuns.length === 0 ? (
            <p className="empty">No recent run results for current filters.</p>
          ) : null}

          <ul className="run-list">
            {triageRuns.map((item) => (
              <li key={`${item.prId}:${item.headSha}`}>
                <a
                  data-testid={`recent-run-link-${item.prNumber}`}
                  href={item.prUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{item.prNumber}
                </a>
                <p>{item.title}</p>
                <div className="run-meta">
                  <span>{formatTimestamp(item.lastAnalyzedAt)}</span>
                  {item.topSuggestion ? (
                    <>
                      <span className={categoryClass(item.topSuggestion.category)}>
                        {item.topSuggestion.category}
                      </span>
                      <a href={item.topSuggestion.candidatePrUrl} target="_blank" rel="noreferrer">
                        #{item.topSuggestion.candidatePrNumber}
                      </a>
                      <strong>{item.topSuggestion.score.toFixed(3)}</strong>
                    </>
                  ) : (
                    <span className="muted">No candidate suggestions</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </main>
    </div>
  );
}
