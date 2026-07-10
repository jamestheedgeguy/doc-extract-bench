/** Shared helpers for dataset fetching + deterministic subset selection. */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCES_DIR = resolve(ROOT, "datasets/files/_sources");
export const FILES_DIR = resolve(ROOT, "datasets/files");
export const SUBSETS_DIR = resolve(ROOT, "datasets/subsets");
export const GT_DIR = resolve(ROOT, "datasets/gt");

export function sha256(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

export async function download(url: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`GET ${url} → HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

/** mulberry32 — tiny deterministic PRNG; the committed seed fully determines
 *  every subset. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher-Yates over a SORTED copy of the universe. */
export function seededSample<T>(universe: T[], n: number, seed: number, key: (t: T) => string): T[] {
  const sorted = [...universe].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const rng = mulberry32(seed);
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  }
  return sorted.slice(0, n);
}

export interface Subset {
  dataset: string;
  docType: string;
  seed: number | null;
  selectedAt: string;
  note?: string;
  ids: string[];
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function manifest(): {
  seed: number;
  datasets: Record<
    string,
    {
      docType: string;
      files: Record<string, { url: string; sha256: string }>;
      revision?: string;
      [k: string]: unknown;
    }
  >;
  [k: string]: unknown;
} {
  return readJson(resolve(ROOT, "datasets/manifest.json"));
}

export function sourcePath(name: string): string {
  return resolve(SOURCES_DIR, name);
}

export function haveSource(name: string): boolean {
  return existsSync(sourcePath(name));
}
