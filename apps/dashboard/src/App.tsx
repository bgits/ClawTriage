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
const MIN_SCORE_HELP_TEXT =
  "Min score filters sets by their strongest duplicate score. Raise it to show only stronger matches; lower it to include weaker or more uncertain matches.";
const DUPLICATE_SET_SCORE_HELP_TEXT =
  "Scores are 0-1. This is the highest pair score in the set. 1.000 means a pair hit the model ceiling (very strong overlap), not guaranteed exact duplicate.";
const EDGE_INTERPRETATION_HELP_TEXT =
  "Interpret score with category and evidence: SAME_CHANGE is closest to exact; SAME_FEATURE can still be different implementations.";
const ABOUT_ONE_LINER =
  "ClawTriage helps maintainers quickly spot pull requests that are likely solving the same problem.";
const ABOUT_PIPELINE_STEPS = [
  "A PR arrives and its changed files are split into four buckets: product code, tests, docs, and metadata.",
  "The system compares product-code changes first because that is the strongest duplicate signal.",
  "Tests and docs are used as supporting clues, but their influence is capped so they cannot dominate.",
  "A shortlist of likely matches is built, then each pair is scored.",
  "Top matches are saved with clear evidence so humans can confirm or reject quickly.",
  "Results are shown quietly in Check Runs and this dashboard queue.",
];
const ABOUT_CANDIDATE_SOURCES = [
  "Exact product-code patch matches",
  "Very similar product-code edits",
  "Overlapping files or folders",
  "Overlapping functions/exports/imports",
  "Similar test intent (useful for different implementations of the same idea)",
];
const ABOUT_CATEGORY_RULES = [
  "SAME_CHANGE: most likely the same code change.",
  "SAME_FEATURE: likely the same goal, but not necessarily the same exact code.",
  "COMPETING_IMPLEMENTATION: likely solving the same thing in a different way.",
  "RELATED / NOT_RELATED: weak overlap or clearly different work.",
];
const ABOUT_EVIDENCE_FIELDS = [
  "Which product files overlap",
  "Which symbols/exports/imports overlap",
  "Which test names or matcher patterns overlap (when relevant)",
  "Which docs headings/code blocks overlap (when relevant)",
  "The scores behind the suggestion",
];

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
  const [isRunsPanelExpanded, setIsRunsPanelExpanded] = useState(false);
  const [isAboutExpanded, setIsAboutExpanded] = useState(false);
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

    if (!selectedSetId) {
      return;
    }

    const hasSelected = duplicateSets.some((set) => set.setId === selectedSetId);
    if (!hasSelected) {
      setSelectedSetId(null);
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
          <p>potential duplicate sets among pull requests.</p>
        </div>

        <div className="controls">
          <label>
            Repository
            <div data-testid="repository-display" className="repo-display">
              {repoDisplayName}
            </div>
          </label>

          <label>
            <span className="control-label-with-help">
              <span>
                Min score: <strong>{minScore.toFixed(2)}</strong>
              </span>
              <span className="tooltip-wrapper">
                <button
                  type="button"
                  className="tooltip-trigger"
                  aria-label="What min score means"
                >
                  ?
                </button>
                <span className="tooltip-bubble" role="tooltip">
                  {MIN_SCORE_HELP_TEXT}
                </span>
              </span>
            </span>
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

          <button
            type="button"
            className="about-toggle"
            data-testid="about-toggle"
            aria-expanded={isAboutExpanded}
            aria-controls={isAboutExpanded ? "about-panel-content" : undefined}
            onClick={() => setIsAboutExpanded((current) => !current)}
          >
            {isAboutExpanded ? "Hide details" : "How this works"}
          </button>
        </div>
      </header>

      <section className={isAboutExpanded ? "panel about-panel expanded" : "panel about-panel"}>
        <div className="about-panel-header">
          <div className="about-panel-title">
            <h2>How We Spot Duplicate PRs</h2>
            <p>{ABOUT_ONE_LINER}</p>
          </div>
          {isAboutExpanded ? (
            <button
              type="button"
              className="about-close"
              onClick={() => setIsAboutExpanded(false)}
              aria-label="Close about"
            >
              Close
            </button>
          ) : null}
        </div>

        {!isAboutExpanded ? (
          <div className="about-collapsed-note">
            <button
              type="button"
              className="about-inline-toggle"
              onClick={() => setIsAboutExpanded(true)}
            >
              More
            </button>
          </div>
        ) : null}

        {isAboutExpanded ? (
          <div id="about-panel-content" className="about-panel-content">
            <p className="about-source-note">
              This summary is based on the project README, architecture docs, and algorithms docs.
            </p>

            <div className="about-card-grid">
              <article className="about-card">
                <h3>Step-By-Step</h3>
                <ol className="about-list">
                  {ABOUT_PIPELINE_STEPS.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </article>

              <article className="about-card">
                <h3>Why Product Code Comes First</h3>
                <p>
                  The system gives the most weight to product-code changes. Tests and docs help with context, but they
                  are intentionally capped so they do not drown out real code differences.
                </p>
                <ul className="about-list">
                  <li>
                    This avoids false matches from huge test files or doc-heavy PRs.
                  </li>
                  <li>
                    It also improves precision when two PRs have similar intent but different implementation details.
                  </li>
                </ul>
              </article>

              <article className="about-card">
                <h3>What It Looks At</h3>
                <p>
                  Before doing deeper scoring, ClawTriage builds a shortlist of PRs that look similar using clues like
                  these:
                </p>
                <ul className="about-list">
                  {ABOUT_CANDIDATE_SOURCES.map((source) => (
                    <li key={source}>{source}</li>
                  ))}
                </ul>
              </article>

              <article className="about-card">
                <h3>How Results Are Labeled</h3>
                <p>
                  Each possible match gets a score and a label so maintainers can quickly decide what to do next.
                </p>
                <ul className="about-list">
                  {ABOUT_CATEGORY_RULES.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </article>

              <article className="about-card">
                <h3>Why You Can Trust the Suggestion</h3>
                <p>
                  Suggestions are only shown when evidence is available for review. No evidence means no valid
                  suggestion.
                </p>
                <ul className="about-list">
                  {ABOUT_EVIDENCE_FIELDS.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>

              <article className="about-card">
                <h3>Safety And Noise Controls</h3>
                <ul className="about-list">
                  <li>
                    It does not run untrusted code from incoming PRs.
                  </li>
                  <li>
                    It is quiet by default: Check Runs and dashboard first, comments only for very high-confidence
                    cases when enabled.
                  </li>
                  <li>
                    If AI assistance is enabled, it sees only compact evidence summaries, not raw full diffs.
                  </li>
                  <li>
                    Final decisions stay with humans; this tool is meant to speed up review, not replace it.
                  </li>
                </ul>
              </article>
            </div>
          </div>
        ) : null}
      </section>

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

      <main className={selectedSet ? "main-grid with-detail" : "main-grid"}>
        <section className="panel sets-panel">
          <div className="panel-header">
            <div className="panel-title-with-help">
              <h2>Potential Duplicate Sets</h2>
              <span className="tooltip-wrapper">
                <button
                  type="button"
                  className="tooltip-trigger"
                  aria-label="How to interpret duplicate set scores"
                >
                  i
                </button>
                <span className="tooltip-bubble" role="tooltip">
                  {DUPLICATE_SET_SCORE_HELP_TEXT}
                </span>
              </span>
            </div>
            <span>{duplicateSets.length} sets</span>
          </div>

          {isLoadingData ? <p className="loading">Loading duplicate sets...</p> : null}
          {!isLoadingData && duplicateSets.length === 0 ? (
            <p className="empty">No duplicate sets matched the current filters.</p>
          ) : null}

          <div className="set-list">
            {isLoadingData ? (
              <div className="sets-loading-hero" role="status" aria-live="polite">
                <span className="loading-spinner" aria-hidden="true" />
                <p>Loading duplicate sets...</p>
              </div>
            ) : null}
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
                  <span>Best pair score {set.maxScore.toFixed(3)}</span>
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

        {selectedSet ? (
          <section className="panel detail-panel">
            <div className="panel-header">
              <h2>Set Details</h2>
              <span>{`Set ${selectedSet.setId}`}</span>
            </div>

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
              <p className="detail-note">{EDGE_INTERPRETATION_HELP_TEXT}</p>
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
          </section>
        ) : null}
      </main>

      <section className="panel runs-panel">
        <div className="panel-header runs-panel-header">
          <h2>Most Recent Runs</h2>
          <div className="runs-panel-header-actions">
            <span>{triageRuns.length} PRs</span>
            <button
              type="button"
              className="runs-toggle"
              data-testid="runs-panel-toggle"
              aria-expanded={isRunsPanelExpanded}
              aria-controls="recent-runs-content"
              onClick={() => setIsRunsPanelExpanded((current) => !current)}
            >
              {isRunsPanelExpanded ? "Hide runs" : "Show runs"}
            </button>
          </div>
        </div>

        {!isRunsPanelExpanded ? (
          <p className="runs-collapsed-note">
            Hidden by default to keep focus on duplicate set review.
          </p>
        ) : null}

        {isRunsPanelExpanded ? (
          <div id="recent-runs-content" className="runs-panel-content">
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
          </div>
        ) : null}
      </section>
    </div>
  );
}
