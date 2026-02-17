import { createHash } from "node:crypto";
import type { TriageCategory } from "@clawtriage/core";
import type { DuplicateSetEdge, DuplicateSetNode } from "@clawtriage/storage";

export interface DuplicateSetMember {
  prId: number;
  prNumber: number;
  headSha: string;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  lastAnalyzedAt: Date;
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

export interface DuplicateSetSummary {
  setId: string;
  size: number;
  maxScore: number;
  categories: TriageCategory[];
  lastAnalyzedAt: Date;
  members: DuplicateSetMember[];
  strongestEdges: DuplicateSetStrongestEdge[];
}

export interface DuplicateSetCursor {
  maxScore: number;
  categoryCount: number;
  size: number;
  lastAnalyzedAt: string;
  setId: string;
}

interface DuplicateSetSortKey {
  maxScore: number;
  categoryCount: number;
  size: number;
  lastAnalyzedAtMs: number;
  setId: string;
}

function nodeKey(prId: number, headSha: string): string {
  return `${prId}:${headSha}`;
}

function sortNodePair(a: DuplicateSetNode, b: DuplicateSetNode): [DuplicateSetNode, DuplicateSetNode] {
  if (a.prId !== b.prId) {
    return a.prId < b.prId ? [a, b] : [b, a];
  }

  return a.headSha.localeCompare(b.headSha) <= 0 ? [a, b] : [b, a];
}

export function encodeDuplicateSetCursor(cursor: DuplicateSetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeDuplicateSetCursor(value: string): DuplicateSetCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      maxScore?: number;
      categoryCount?: number;
      size?: number;
      lastAnalyzedAt?: string;
      setId?: string;
    };

    if (
      typeof decoded.maxScore !== "number" ||
      !Number.isFinite(decoded.maxScore) ||
      typeof decoded.categoryCount !== "number" ||
      !Number.isInteger(decoded.categoryCount) ||
      decoded.categoryCount < 1 ||
      typeof decoded.size !== "number" ||
      !Number.isInteger(decoded.size) ||
      decoded.size < 2 ||
      typeof decoded.lastAnalyzedAt !== "string" ||
      Number.isNaN(new Date(decoded.lastAnalyzedAt).valueOf()) ||
      typeof decoded.setId !== "string" ||
      decoded.setId.length === 0
    ) {
      return null;
    }

    return {
      maxScore: decoded.maxScore,
      categoryCount: decoded.categoryCount,
      size: decoded.size,
      lastAnalyzedAt: decoded.lastAnalyzedAt,
      setId: decoded.setId,
    };
  } catch {
    return null;
  }
}

function toSortKeyFromSummary(set: DuplicateSetSummary): DuplicateSetSortKey {
  return {
    maxScore: set.maxScore,
    categoryCount: set.categories.length,
    size: set.size,
    lastAnalyzedAtMs: set.lastAnalyzedAt.getTime(),
    setId: set.setId,
  };
}

function toSortKeyFromCursor(cursor: DuplicateSetCursor): DuplicateSetSortKey {
  return {
    maxScore: cursor.maxScore,
    categoryCount: cursor.categoryCount,
    size: cursor.size,
    lastAnalyzedAtMs: new Date(cursor.lastAnalyzedAt).getTime(),
    setId: cursor.setId,
  };
}

function compareDuplicateSetSortKeys(a: DuplicateSetSortKey, b: DuplicateSetSortKey): number {
  if (a.maxScore !== b.maxScore) {
    return a.maxScore > b.maxScore ? -1 : 1;
  }

  if (a.categoryCount !== b.categoryCount) {
    return a.categoryCount - b.categoryCount;
  }

  if (a.size !== b.size) {
    return a.size - b.size;
  }

  if (a.lastAnalyzedAtMs !== b.lastAnalyzedAtMs) {
    return a.lastAnalyzedAtMs > b.lastAnalyzedAtMs ? -1 : 1;
  }

  return a.setId.localeCompare(b.setId);
}

export function compareDuplicateSets(a: DuplicateSetSummary, b: DuplicateSetSummary): number {
  return compareDuplicateSetSortKeys(toSortKeyFromSummary(a), toSortKeyFromSummary(b));
}

export function compareDuplicateSetToCursor(set: DuplicateSetSummary, cursor: DuplicateSetCursor): number {
  return compareDuplicateSetSortKeys(toSortKeyFromSummary(set), toSortKeyFromCursor(cursor));
}

export function buildDuplicateSets(
  nodes: DuplicateSetNode[],
  edges: DuplicateSetEdge[],
): DuplicateSetSummary[] {
  const nodesByKey = new Map<string, DuplicateSetNode>();
  for (const node of nodes) {
    nodesByKey.set(nodeKey(node.prId, node.headSha), node);
  }

  const parent = new Map<string, string>();

  const ensure = (key: string) => {
    if (!parent.has(key)) {
      parent.set(key, key);
    }
  };

  const find = (key: string): string => {
    const current = parent.get(key);
    if (!current) {
      parent.set(key, key);
      return key;
    }

    if (current === key) {
      return key;
    }

    const root = find(current);
    parent.set(key, root);
    return root;
  };

  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);

    if (leftRoot === rightRoot) {
      return;
    }

    if (leftRoot < rightRoot) {
      parent.set(rightRoot, leftRoot);
    } else {
      parent.set(leftRoot, rightRoot);
    }
  };

  type NormalizedEdge = {
    left: DuplicateSetNode;
    right: DuplicateSetNode;
    category: TriageCategory;
    score: number;
    evidence: unknown;
  };

  const dedupedEdges = new Map<string, NormalizedEdge>();

  for (const edge of edges) {
    const from = nodesByKey.get(nodeKey(edge.prIdA, edge.headShaA));
    const to = nodesByKey.get(nodeKey(edge.prIdB, edge.headShaB));

    if (!from || !to) {
      continue;
    }

    const [left, right] = sortNodePair(from, to);
    const pairKey = `${nodeKey(left.prId, left.headSha)}|${nodeKey(right.prId, right.headSha)}`;

    const normalized: NormalizedEdge = {
      left,
      right,
      category: edge.category,
      score: edge.finalScore,
      evidence: edge.evidence,
    };

    const existing = dedupedEdges.get(pairKey);
    if (!existing || normalized.score > existing.score) {
      dedupedEdges.set(pairKey, normalized);
    }

    ensure(nodeKey(left.prId, left.headSha));
    ensure(nodeKey(right.prId, right.headSha));
    union(nodeKey(left.prId, left.headSha), nodeKey(right.prId, right.headSha));
  }

  const membersByRoot = new Map<string, DuplicateSetNode[]>();
  for (const node of nodes) {
    const key = nodeKey(node.prId, node.headSha);
    ensure(key);
    const root = find(key);
    const members = membersByRoot.get(root);
    if (members) {
      members.push(node);
    } else {
      membersByRoot.set(root, [node]);
    }
  }

  const edgesByRoot = new Map<string, NormalizedEdge[]>();
  for (const edge of dedupedEdges.values()) {
    const root = find(nodeKey(edge.left.prId, edge.left.headSha));
    const bucket = edgesByRoot.get(root);
    if (bucket) {
      bucket.push(edge);
    } else {
      edgesByRoot.set(root, [edge]);
    }
  }

  const out: DuplicateSetSummary[] = [];

  for (const [root, members] of membersByRoot.entries()) {
    if (members.length < 2) {
      continue;
    }

    const setEdges = edgesByRoot.get(root) ?? [];
    if (setEdges.length === 0) {
      continue;
    }

    members.sort((a, b) => {
      if (a.prNumber !== b.prNumber) {
        return a.prNumber - b.prNumber;
      }
      return a.headSha.localeCompare(b.headSha);
    });

    let maxScore = 0;
    let lastAnalyzedAt = new Date(0);
    const categories = new Set<TriageCategory>();

    for (const member of members) {
      if (member.lastAnalyzedAt.getTime() > lastAnalyzedAt.getTime()) {
        lastAnalyzedAt = member.lastAnalyzedAt;
      }
    }

    for (const edge of setEdges) {
      categories.add(edge.category);
      if (edge.score > maxScore) {
        maxScore = edge.score;
      }
    }

    const strongestEdges = setEdges
      .slice()
      .sort((a, b) => {
        if (a.score !== b.score) {
          return b.score - a.score;
        }
        if (a.left.prNumber !== b.left.prNumber) {
          return a.left.prNumber - b.left.prNumber;
        }
        return a.right.prNumber - b.right.prNumber;
      })
      .slice(0, 5)
      .map((edge) => ({
        fromPrNumber: edge.left.prNumber,
        fromPrUrl: edge.left.url,
        toPrNumber: edge.right.prNumber,
        toPrUrl: edge.right.url,
        category: edge.category,
        score: edge.score,
        evidence: edge.evidence,
      }));

    const memberSignature = members
      .map((member) => `${member.prId}:${member.headSha}`)
      .join(",");
    const setId = createHash("sha256").update(memberSignature).digest("hex").slice(0, 16);

    out.push({
      setId,
      size: members.length,
      maxScore,
      categories: Array.from(categories).sort((a, b) => a.localeCompare(b)) as TriageCategory[],
      lastAnalyzedAt,
      members: members.map((member) => ({
        prId: member.prId,
        prNumber: member.prNumber,
        headSha: member.headSha,
        title: member.title,
        url: member.url,
        state: member.state,
        lastAnalyzedAt: member.lastAnalyzedAt,
      })),
      strongestEdges,
    });
  }

  out.sort(compareDuplicateSets);
  return out;
}
