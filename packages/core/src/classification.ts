import path from "node:path";
import { minimatch } from "minimatch";
import type { ChangedFile, ClassificationRules, FileChannel } from "./types.js";

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function matchesGlob(filePath: string, globs: string[]): boolean {
  return globs.some((pattern) => minimatch(filePath, pattern, { dot: true }));
}

export function classifyPath(filePath: string, rules: ClassificationRules): FileChannel {
  const normalized = toPosix(filePath);

  if (matchesGlob(normalized, rules.channels.meta.path_globs)) {
    return "META";
  }

  if (matchesGlob(normalized, rules.channels.tests.path_globs)) {
    return "TESTS";
  }

  if (matchesGlob(normalized, rules.channels.docs.path_globs)) {
    return "DOCS";
  }

  return "PRODUCTION";
}

export function classifyFiles(
  files: ChangedFile[],
  rules: ClassificationRules,
): Array<ChangedFile & { channel: FileChannel }> {
  return files.map((file) => ({
    ...file,
    channel: classifyPath(file.path, rules),
  }));
}
