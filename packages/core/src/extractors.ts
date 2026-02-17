import { extractAddedRemovedLines } from "./diff.js";
import type { ChangedFile, DocsStructure, TestIntent } from "./types.js";

const TEST_IMPORT_BLOCKLIST = new Set([
  "vitest",
  "jest",
  "@jest/globals",
  "@playwright/test",
  "mocha",
  "chai",
]);

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTestIntent(files: ChangedFile[]): TestIntent {
  const suites: string[] = [];
  const tests: string[] = [];
  const matchers: string[] = [];
  const importsUnderTest: string[] = [];

  for (const file of files) {
    if (!file.patch) {
      continue;
    }

    const lines = extractAddedRemovedLines(file.patch).map((line) => line.slice(1));
    const content = lines.join("\n");

    for (const match of content.matchAll(/\bdescribe\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
      suites.push(normalizeName(match[1]));
    }

    for (const match of content.matchAll(/\b(?:it|test)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
      tests.push(normalizeName(match[1]));
    }

    for (const match of content.matchAll(/\.to([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
      matchers.push(`to${match[1]}`);
    }

    for (const match of content.matchAll(/\bfrom\s+["'`]([^"'`]+)["'`]/g)) {
      const moduleName = match[1];
      if (!TEST_IMPORT_BLOCKLIST.has(moduleName)) {
        importsUnderTest.push(moduleName);
      }
    }
  }

  return {
    suiteNames: uniqueSorted(suites),
    testNames: uniqueSorted(tests),
    matchers: uniqueSorted(matchers),
    importsUnderTest: uniqueSorted(importsUnderTest),
  };
}

export function extractDocsStructure(files: ChangedFile[]): DocsStructure {
  const headings: string[] = [];
  const codeFences: string[] = [];
  const references: string[] = [];

  for (const file of files) {
    if (!file.patch) {
      continue;
    }

    for (const rawLine of extractAddedRemovedLines(file.patch).map((line) => line.slice(1))) {
      const line = rawLine.trim();

      const headingMatch = line.match(/^#{1,6}\s+(.+)/);
      if (headingMatch) {
        headings.push(normalizeName(headingMatch[1]));
      }

      const fenceMatch = line.match(/^```([A-Za-z0-9_-]+)/);
      if (fenceMatch) {
        codeFences.push(fenceMatch[1].toLowerCase());
      }

      for (const match of line.matchAll(/#(\d{1,10})\b/g)) {
        references.push(`#${match[1]}`);
      }
    }
  }

  return {
    headings: uniqueSorted(headings),
    codeFences: uniqueSorted(codeFences),
    references: uniqueSorted(references),
  };
}

export function tokensFromTestIntent(intent: TestIntent): string[] {
  return [
    ...intent.suiteNames,
    ...intent.testNames,
    ...intent.matchers,
    ...intent.importsUnderTest,
  ];
}

export function tokensFromDocsStructure(structure: DocsStructure): string[] {
  return [...structure.headings, ...structure.codeFences, ...structure.references];
}
