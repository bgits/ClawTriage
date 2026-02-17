import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

function mockResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

describe("Dashboard App", () => {
  beforeEach(() => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/api/repos/101/duplicate-sets")) {
        return mockResponse({
          sets: [
            {
              setId: "set-alpha",
              size: 2,
              maxScore: 0.94,
              categories: ["SAME_CHANGE"],
              lastAnalyzedAt: "2026-02-17T00:00:00Z",
              members: [
                {
                  prId: 11,
                  prNumber: 3101,
                  headSha: "abc123400000",
                  title: "Add cache warmup path",
                  url: "https://github.com/org/repo/pull/3101",
                  state: "OPEN",
                  lastAnalyzedAt: "2026-02-17T00:00:00Z",
                },
                {
                  prId: 12,
                  prNumber: 2700,
                  headSha: "def123400000",
                  title: "Cache warmup implementation",
                  url: "https://github.com/org/repo/pull/2700",
                  state: "OPEN",
                  lastAnalyzedAt: "2026-02-16T00:00:00Z",
                },
              ],
              strongestEdges: [
                {
                  fromPrNumber: 3101,
                  fromPrUrl: "https://github.com/org/repo/pull/3101",
                  toPrNumber: 2700,
                  toPrUrl: "https://github.com/org/repo/pull/2700",
                  category: "SAME_CHANGE",
                  score: 0.94,
                  evidence: {
                    overlappingProductionPaths: ["src/cache.ts"],
                    overlappingExports: ["warmCache"],
                  },
                },
              ],
            },
            {
              setId: "set-beta",
              size: 2,
              maxScore: 0.79,
              categories: ["SAME_FEATURE"],
              lastAnalyzedAt: "2026-02-15T00:00:00Z",
              members: [
                {
                  prId: 13,
                  prNumber: 3210,
                  headSha: "zyx123400000",
                  title: "Feature branch one",
                  url: "https://github.com/org/repo/pull/3210",
                  state: "OPEN",
                  lastAnalyzedAt: "2026-02-15T00:00:00Z",
                },
                {
                  prId: 14,
                  prNumber: 3220,
                  headSha: "xya123400000",
                  title: "Feature branch two",
                  url: "https://github.com/org/repo/pull/3220",
                  state: "OPEN",
                  lastAnalyzedAt: "2026-02-14T00:00:00Z",
                },
              ],
              strongestEdges: [
                {
                  fromPrNumber: 3210,
                  fromPrUrl: "https://github.com/org/repo/pull/3210",
                  toPrNumber: 3220,
                  toPrUrl: "https://github.com/org/repo/pull/3220",
                  category: "SAME_FEATURE",
                  score: 0.79,
                  evidence: {
                    overlappingProductionPaths: ["src/feature.ts"],
                  },
                },
              ],
            },
          ],
          nextCursor: null,
        });
      }

      if (url.includes("/api/repos/101/triage-queue")) {
        return mockResponse({
          items: [
            {
              repoId: 101,
              prNumber: 3101,
              prId: 11,
              headSha: "abc123400000",
              prUrl: "https://github.com/org/repo/pull/3101",
              title: "Add cache warmup path",
              authorLogin: "alice",
              state: "OPEN",
              updatedAt: "2026-02-17T00:10:00Z",
              lastAnalyzedAt: "2026-02-17T00:11:00Z",
              analysisStatus: "DONE",
              analysisRunId: "run-alpha",
              topSuggestion: {
                category: "SAME_CHANGE",
                candidatePrNumber: 2700,
                candidatePrUrl: "https://github.com/org/repo/pull/2700",
                score: 0.94,
              },
              needsReview: true,
            },
          ],
          nextCursor: null,
        });
      }

      if (url.includes("/api/repos")) {
        return mockResponse({
          repos: [
            {
              repoId: 101,
              owner: "openclaw",
              name: "clawtriage",
              defaultBranch: "main",
              isActive: true,
              installationId: 77,
            },
          ],
        });
      }

      throw new Error(`Unhandled URL in test: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders duplicate sets and keeps recent runs collapsed by default", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Set set-alpha")).toBeInTheDocument();
    });

    const runsToggle = screen.getByTestId("runs-panel-toggle");
    expect(runsToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("recent-run-link-3101")).not.toBeInTheDocument();

    fireEvent.click(runsToggle);

    await waitFor(() => {
      expect(runsToggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("recent-run-link-3101")).toBeInTheDocument();
    });

    expect(screen.getByTestId("recent-run-link-3101")).toHaveAttribute(
      "href",
      "https://github.com/org/repo/pull/3101",
    );
  });

  it("keeps about details collapsed by default and supports open/close", async () => {
    render(<App />);

    const aboutToggle = screen.getByTestId("about-toggle");
    expect(aboutToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Step-By-Step")).not.toBeInTheDocument();

    fireEvent.click(aboutToggle);

    await waitFor(() => {
      expect(aboutToggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("How We Spot Duplicate PRs")).toBeInTheDocument();
      expect(screen.getByText("Step-By-Step")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close about" }));

    await waitFor(() => {
      expect(aboutToggle).toHaveAttribute("aria-expanded", "false");
    });
    expect(screen.queryByText("Step-By-Step")).not.toBeInTheDocument();
  });

  it("shows a fixed repository display instead of a selector", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("repository-display")).toHaveTextContent("openclaw/clawtriage");
    });

    expect(screen.queryByRole("combobox", { name: "Repository" })).not.toBeInTheDocument();
  });

  it("updates details when selecting a different set", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("set-item-set-beta")).toBeInTheDocument();
    });

    expect(screen.queryByText("Set Details")).not.toBeInTheDocument();
    expect(screen.queryByText("Feature branch one")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("set-item-set-beta"));

    await waitFor(() => {
      expect(screen.getByText("Set Details")).toBeInTheDocument();
      expect(screen.getByText("Feature branch one")).toBeInTheDocument();
    });
  });

  it("uses explicit pressed state for category filters", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "SAME_CHANGE" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "SAME_CHANGE" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "SAME_CHANGE" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  it("renders external links for member and edge PRs", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show runs" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Show runs" }));

    await waitFor(() => {
      expect(screen.getByTestId("recent-run-link-3101")).toBeInTheDocument();
    });

    const memberLink = screen.getAllByRole("link", { name: "#3101" })[0];
    expect(memberLink).toHaveAttribute("href", "https://github.com/org/repo/pull/3101");

    const candidateLink = screen.getAllByRole("link", { name: "#2700" })[0];
    expect(candidateLink).toHaveAttribute("href", "https://github.com/org/repo/pull/2700");
  });
});
