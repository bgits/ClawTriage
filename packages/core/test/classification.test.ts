import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyPath, loadClassificationRules } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rules = loadClassificationRules(
  path.resolve(__dirname, "../../../config/classification_rules.yaml"),
);

describe("classification rules", () => {
  it("classifies production paths by default", () => {
    expect(classifyPath("src/service/user.ts", rules)).toBe("PRODUCTION");
  });

  it("classifies tests using glob rules", () => {
    expect(classifyPath("src/__tests__/user.test.ts", rules)).toBe("TESTS");
    expect(classifyPath("packages/core/tests/helpers.ts", rules)).toBe("TESTS");
  });

  it("classifies docs using markdown/doc globs", () => {
    expect(classifyPath("docs/ARCHITECTURE.md", rules)).toBe("DOCS");
    expect(classifyPath("README.md", rules)).toBe("DOCS");
  });

  it("classifies meta paths before other channels", () => {
    expect(classifyPath(".cursor/session.log", rules)).toBe("META");
    expect(classifyPath("notes/agent/trace.json", rules)).toBe("META");
  });
});
