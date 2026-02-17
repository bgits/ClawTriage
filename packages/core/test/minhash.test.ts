import { describe, expect, it } from "vitest";
import {
  buildTokenShingles,
  computeMinhash,
  lshBucketIds,
  minhashSimilarity,
  normalizeDiffLine,
  tokenizeLine,
} from "../src/index.js";

function signatureForLines(lines: string[]): Uint32Array {
  const tokens = lines.flatMap((line) => tokenizeLine(normalizeDiffLine(line)));
  const shingles = buildTokenShingles(tokens, 5);
  return computeMinhash(shingles);
}

describe("minhash determinism", () => {
  it("produces stable signatures for the same input", () => {
    const lines = [
      "+export function sum(a: number, b: number) {",
      "+  return a + b;",
      "+}",
    ];

    const first = signatureForLines(lines);
    const second = signatureForLines(lines);

    expect(Array.from(first)).toEqual(Array.from(second));
    expect(lshBucketIds(first)).toEqual(lshBucketIds(second));
  });

  it("keeps similar signatures for near-identical changes", () => {
    const base = signatureForLines([
      "+const total = price * quantity;",
      "+return total + tax;",
    ]);

    const near = signatureForLines([
      "+const total = price * qty;",
      "+return total + tax;",
    ]);

    const sim = minhashSimilarity(base, near);
    expect(sim).toBeGreaterThan(0.2);
  });
});
