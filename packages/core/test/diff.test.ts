import { describe, expect, it } from "vitest";
import { buildCanonicalDiffHash, canonicalizeProductionDiff } from "../src/index.js";

const patch = [
  "@@ -1,2 +1,2 @@",
  "-const count = 12;",
  "+const count = 13;",
  " const name = 'demo';",
].join("\n");

describe("canonical diff normalization", () => {
  it("removes metadata lines and keeps only +/- content with file ordering", () => {
    const canonical = canonicalizeProductionDiff([
      { path: "src/b.ts", patch: "+export const b = 1;" },
      { path: "src/a.ts", patch },
    ]);

    expect(canonical).toContain("file:src/a.ts");
    expect(canonical).toContain("-const count = 12;");
    expect(canonical).toContain("+const count = 13;");
    expect(canonical).toContain("file:src/b.ts");
    expect(canonical).not.toContain("@@");
  });

  it("is deterministic for identical logical diff input", () => {
    const first = buildCanonicalDiffHash([{ path: "src/a.ts", patch }]);
    const second = buildCanonicalDiffHash([{ path: "src/a.ts", patch }]);
    expect(first.hash).toBe(second.hash);
    expect(first.canonicalText).toBe(second.canonicalText);
  });
});
