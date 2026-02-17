import crypto from "node:crypto";
import type { ChangedFile } from "./types.js";

const METADATA_LINE_PREFIXES = ["diff --git", "index ", "--- ", "+++ ", "@@ ", "@@"];

export interface PatchInput {
  path: string;
  patch?: string | null;
}

export function isMetadataLine(line: string): boolean {
  return METADATA_LINE_PREFIXES.some((prefix) => line.startsWith(prefix));
}

export function extractAddedRemovedLines(patch: string): string[] {
  const lines = patch.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    if (line.startsWith("\\ No newline at end of file") || isMetadataLine(line)) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) {
      out.push(line);
    }
  }

  return out;
}

export function canonicalizeProductionDiff(files: PatchInput[]): string {
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const sections: string[] = [];

  for (const file of sortedFiles) {
    sections.push(`file:${file.path}`);

    if (!file.patch) {
      continue;
    }

    for (const line of extractAddedRemovedLines(file.patch)) {
      sections.push(line.replace(/\s+$/g, ""));
    }
  }

  return sections.join("\n");
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function buildCanonicalDiffHash(files: PatchInput[]): {
  canonicalText: string;
  hash: string;
} {
  const canonicalText = canonicalizeProductionDiff(files);
  return {
    canonicalText,
    hash: sha256Hex(canonicalText),
  };
}

const EXPORT_REGEX =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const SYMBOL_REGEX =
  /\b(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const IMPORT_REGEX = /\bfrom\s+["']([^"']+)["']/g;

export interface ProductionSignals {
  exports: string[];
  symbols: string[];
  imports: string[];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function extractProductionSignalsFromFiles(files: ChangedFile[]): ProductionSignals {
  const exportNames: string[] = [];
  const symbols: string[] = [];
  const imports: string[] = [];

  for (const file of files) {
    if (!file.patch) {
      continue;
    }

    const patchLines = extractAddedRemovedLines(file.patch)
      .map((line) => line.slice(1))
      .join("\n");

    for (const match of patchLines.matchAll(EXPORT_REGEX)) {
      exportNames.push(match[1]);
    }
    for (const match of patchLines.matchAll(SYMBOL_REGEX)) {
      symbols.push(match[1]);
    }
    for (const match of patchLines.matchAll(IMPORT_REGEX)) {
      imports.push(match[1]);
    }
  }

  return {
    exports: uniqueSorted(exportNames),
    symbols: uniqueSorted(symbols),
    imports: uniqueSorted(imports),
  };
}
