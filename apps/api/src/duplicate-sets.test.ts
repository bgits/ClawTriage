import { describe, expect, it } from "vitest";
import {
  buildDuplicateSets,
  compareDuplicateSetToCursor,
  compareDuplicateSets,
  decodeDuplicateSetCursor,
  encodeDuplicateSetCursor,
  type DuplicateSetSummary,
} from "./duplicate-sets.js";

describe("duplicate set derivation", () => {
  it("builds connected components from filtered edges and keeps strongest undirected edge", () => {
    const nodes = [
      {
        prId: 1,
        prNumber: 101,
        headSha: "aaaa",
        title: "PR 101",
        url: "https://github.com/org/repo/pull/101",
        state: "OPEN" as const,
        lastAnalyzedAt: new Date("2026-02-17T12:00:00Z"),
        analysisRunId: "run-1",
      },
      {
        prId: 2,
        prNumber: 102,
        headSha: "bbbb",
        title: "PR 102",
        url: "https://github.com/org/repo/pull/102",
        state: "OPEN" as const,
        lastAnalyzedAt: new Date("2026-02-16T12:00:00Z"),
        analysisRunId: "run-2",
      },
      {
        prId: 3,
        prNumber: 103,
        headSha: "cccc",
        title: "PR 103",
        url: "https://github.com/org/repo/pull/103",
        state: "OPEN" as const,
        lastAnalyzedAt: new Date("2026-02-15T12:00:00Z"),
        analysisRunId: "run-3",
      },
      {
        prId: 4,
        prNumber: 104,
        headSha: "dddd",
        title: "PR 104",
        url: "https://github.com/org/repo/pull/104",
        state: "OPEN" as const,
        lastAnalyzedAt: new Date("2026-02-14T12:00:00Z"),
        analysisRunId: "run-4",
      },
    ];

    const edges = [
      {
        prIdA: 1,
        headShaA: "aaaa",
        prIdB: 2,
        headShaB: "bbbb",
        category: "SAME_FEATURE" as const,
        finalScore: 0.7,
        evidence: { overlappingProductionPaths: ["src/a.ts"] },
      },
      {
        prIdA: 2,
        headShaA: "bbbb",
        prIdB: 1,
        headShaB: "aaaa",
        category: "SAME_CHANGE" as const,
        finalScore: 0.92,
        evidence: { overlappingProductionPaths: ["src/a.ts", "src/b.ts"] },
      },
      {
        prIdA: 2,
        headShaA: "bbbb",
        prIdB: 3,
        headShaB: "cccc",
        category: "RELATED" as const,
        finalScore: 0.6,
        evidence: { overlappingProductionPaths: ["src/c.ts"] },
      },
    ];

    const sets = buildDuplicateSets(nodes, edges);

    expect(sets).toHaveLength(1);
    expect(sets[0].size).toBe(3);
    expect(sets[0].maxScore).toBe(0.92);
    expect(sets[0].categories).toEqual(["RELATED", "SAME_CHANGE"]);
    expect(sets[0].members.map((member) => member.prNumber)).toEqual([101, 102, 103]);
    expect(sets[0].setId).toHaveLength(16);
    expect(sets[0].strongestEdges[0].score).toBe(0.92);
  });

  it("sorts sets by score, then category count, then set size, then analyzed time, then set id", () => {
    const sets: DuplicateSetSummary[] = [
      {
        setId: "dddd",
        size: 2,
        maxScore: 0.9,
        categories: ["SAME_CHANGE", "SAME_FEATURE"],
        lastAnalyzedAt: new Date("2026-02-20T12:00:00Z"),
        members: [],
        strongestEdges: [],
      },
      {
        setId: "bbbb",
        size: 3,
        maxScore: 0.9,
        categories: ["SAME_CHANGE"],
        lastAnalyzedAt: new Date("2026-02-17T12:00:00Z"),
        members: [],
        strongestEdges: [],
      },
      {
        setId: "aaaa",
        size: 3,
        maxScore: 0.9,
        categories: ["SAME_CHANGE"],
        lastAnalyzedAt: new Date("2026-02-17T12:00:00Z"),
        members: [],
        strongestEdges: [],
      },
      {
        setId: "cccc",
        size: 5,
        maxScore: 0.9,
        categories: ["SAME_CHANGE"],
        lastAnalyzedAt: new Date("2026-02-19T12:00:00Z"),
        members: [],
        strongestEdges: [],
      },
      {
        setId: "zzzz",
        size: 3,
        maxScore: 0.9,
        categories: ["SAME_FEATURE"],
        lastAnalyzedAt: new Date("2026-02-18T12:00:00Z"),
        members: [],
        strongestEdges: [],
      },
      {
        setId: "eeee",
        size: 2,
        maxScore: 0.8,
        categories: ["SAME_FEATURE"],
        lastAnalyzedAt: new Date("2026-02-21T12:00:00Z"),
        members: [],
        strongestEdges: [],
      },
    ];

    const sorted = sets.sort(compareDuplicateSets);
    expect(sorted.map((entry) => entry.setId)).toEqual(["zzzz", "aaaa", "bbbb", "cccc", "dddd", "eeee"]);
  });

  it("compares set ordering against cursor using the same sort keys", () => {
    const cursor = {
      maxScore: 0.9,
      categoryCount: 1,
      size: 5,
      lastAnalyzedAt: "2026-02-19T12:00:00Z",
      setId: "cccc",
    };

    const newerSimpleSmaller: DuplicateSetSummary = {
      setId: "zzzz",
      size: 3,
      maxScore: 0.9,
      categories: ["SAME_FEATURE"],
      lastAnalyzedAt: new Date("2026-02-20T12:00:00Z"),
      members: [],
      strongestEdges: [],
    };

    const largerCategorySet: DuplicateSetSummary = {
      setId: "dddd",
      size: 2,
      maxScore: 0.9,
      categories: ["SAME_CHANGE", "SAME_FEATURE"],
      lastAnalyzedAt: new Date("2026-02-20T12:00:00Z"),
      members: [],
      strongestEdges: [],
    };

    const lowerScoreSet: DuplicateSetSummary = {
      setId: "eeee",
      size: 2,
      maxScore: 0.8,
      categories: ["SAME_FEATURE"],
      lastAnalyzedAt: new Date("2026-02-20T12:00:00Z"),
      members: [],
      strongestEdges: [],
    };

    expect(compareDuplicateSetToCursor(newerSimpleSmaller, cursor)).toBeLessThan(0);
    expect(compareDuplicateSetToCursor(largerCategorySet, cursor)).toBeGreaterThan(0);
    expect(compareDuplicateSetToCursor(lowerScoreSet, cursor)).toBeGreaterThan(0);
  });

  it("round-trips duplicate set cursor", () => {
    const encoded = encodeDuplicateSetCursor({
      maxScore: 0.88,
      categoryCount: 2,
      size: 4,
      lastAnalyzedAt: "2026-02-17T12:00:00Z",
      setId: "set-alpha",
    });

    const decoded = decodeDuplicateSetCursor(encoded);
    expect(decoded).toEqual({
      maxScore: 0.88,
      categoryCount: 2,
      size: 4,
      lastAnalyzedAt: "2026-02-17T12:00:00Z",
      setId: "set-alpha",
    });

    const legacyCursor = Buffer.from(
      JSON.stringify({
        maxScore: 0.88,
        lastAnalyzedAt: "2026-02-17T12:00:00Z",
        setId: "set-alpha",
      }),
      "utf8",
    ).toString("base64url");
    expect(decodeDuplicateSetCursor(legacyCursor)).toBeNull();
    expect(decodeDuplicateSetCursor("invalid")).toBeNull();
  });
});
