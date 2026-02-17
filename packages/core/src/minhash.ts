import crypto from "node:crypto";
import { LSH_BAND_SIZE, MINHASH_SIZE } from "./constants.js";

const UINT32_MAX = 0xffffffff;
const TOKEN_REGEX =
  /[A-Za-z_$][A-Za-z0-9_$]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\d+|==|!=|<=|>=|=>|&&|\|\||[{}()[\].,;:+\-*/%<>]=?/g;

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function buildSeeds(count: number): Uint32Array {
  const seeds = new Uint32Array(count);
  let state = 0x9e3779b9;
  for (let i = 0; i < count; i += 1) {
    state = mix32(state + i * 0x85ebca6b);
    seeds[i] = state;
  }
  return seeds;
}

const MINHASH_SEEDS = buildSeeds(MINHASH_SIZE);

export function normalizeDiffLine(line: string): string {
  return line
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<NUM>");
}

export function tokenizeLine(line: string): string[] {
  const normalized = normalizeDiffLine(line);
  const matches = normalized.match(TOKEN_REGEX);
  if (!matches) {
    return [];
  }

  return matches.map((token) => {
    if (/^\d/.test(token)) {
      return "<NUM>";
    }
    if (
      (token.startsWith("\"") && token.endsWith("\"")) ||
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith("`") && token.endsWith("`"))
    ) {
      return "<STR>";
    }
    return token;
  });
}

export function buildTokenShingles(tokens: string[], size = 5): Set<string> {
  const out = new Set<string>();
  if (tokens.length < size) {
    return out;
  }

  for (let i = 0; i <= tokens.length - size; i += 1) {
    out.add(tokens.slice(i, i + size).join("\u241f"));
  }
  return out;
}

export function computeMinhash(shingles: Set<string>, numHashes = MINHASH_SIZE): Uint32Array {
  const signature = new Uint32Array(numHashes);
  signature.fill(UINT32_MAX);

  if (shingles.size === 0) {
    return signature;
  }

  const seeds = numHashes === MINHASH_SIZE ? MINHASH_SEEDS : buildSeeds(numHashes);

  for (const shingle of shingles) {
    const baseHash = fnv1a32(shingle);
    for (let i = 0; i < numHashes; i += 1) {
      const hashed = mix32(baseHash ^ seeds[i]);
      if (hashed < signature[i]) {
        signature[i] = hashed;
      }
    }
  }

  return signature;
}

export function minhashSimilarity(a: Uint32Array, b: Uint32Array): number {
  const size = Math.min(a.length, b.length);
  if (size === 0) {
    return 0;
  }

  let matches = 0;
  for (let i = 0; i < size; i += 1) {
    if (a[i] === b[i]) {
      matches += 1;
    }
  }

  return matches / size;
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function hashBand(values: number[]): string {
  const hash = crypto.createHash("sha1");
  hash.update(values.join(":"));
  return hash.digest("hex").slice(0, 16);
}

export function lshBucketIds(signature: Uint32Array, bandSize = LSH_BAND_SIZE): string[] {
  if (signature.length % bandSize !== 0) {
    throw new Error(`Signature length ${signature.length} must be divisible by band size ${bandSize}`);
  }

  const ids: string[] = [];
  const bands = signature.length / bandSize;

  for (let band = 0; band < bands; band += 1) {
    const start = band * bandSize;
    const values: number[] = [];
    for (let i = start; i < start + bandSize; i += 1) {
      values.push(signature[i]);
    }
    ids.push(`${band}:${hashBand(values)}`);
  }

  return ids;
}

export function minhashToBuffer(signature: Uint32Array): Buffer {
  return Buffer.from(signature.buffer.slice(0));
}

export function bufferToMinhash(buffer: Buffer): Uint32Array {
  if (buffer.length % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Invalid minhash buffer length");
  }

  const view = new Uint32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.length / Uint32Array.BYTES_PER_ELEMENT,
  );

  return new Uint32Array(view);
}
