/** Download + sha256-verify every dataset source, then materialize the
 *  per-document inputs (and ground truth) for the pre-registered subsets.
 *
 *    pnpm fetch                # download sources + materialize subsets
 *    pnpm fetch --verify       # verify hashes of already-downloaded sources
 *    pnpm fetch --gt-sroie     # only fetch samples.json + rebuild SROIE GT
 *                              #   (the light path used by keyless CI replay)
 *
 *  License note (SROIE): receipt images are downloaded by script and are
 *  NEVER committed to this repository; the derived SROIE ground truth also
 *  stays out of the repo and is re-derived from the pinned upstream source.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import unzipper from "unzipper";
const openZip = unzipper.Open;
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import {
  FILES_DIR,
  GT_DIR,
  ROOT,
  SUBSETS_DIR,
  download,
  manifest,
  readJson,
  sha256File,
  sourcePath,
  writeJson,
  type Subset,
} from "../datasets/lib.js";
import { cordToReceiptGt, faturaToInvoiceGt, fintabnetToHtml } from "../datasets/gt-mappers.js";

const VERIFY_ONLY = process.argv.includes("--verify");
const GT_SROIE_ONLY = process.argv.includes("--gt-sroie");

export function safeId(id: string): string {
  return id.replace(/[/:#]/g, "_");
}

async function fetchSources(): Promise<void> {
  const m = manifest();
  let manifestDirty = false;
  for (const [dsName, ds] of Object.entries(m.datasets)) {
    if (GT_SROIE_ONLY && dsName !== "sroie") continue;
    for (const [name, spec] of Object.entries(ds.files)) {
      const dest = sourcePath(name);
      if (!existsSync(dest)) {
        if (VERIFY_ONLY) {
          console.error(`missing source: ${name}`);
          process.exitCode = 1;
          continue;
        }
        console.log(`downloading ${name} …`);
        await download(spec.url, dest);
      }
      const hash = sha256File(dest);
      if (spec.sha256 === "FILLED_BY_FETCH") {
        spec.sha256 = hash;
        manifestDirty = true;
        console.log(`pinned ${name} sha256=${hash}`);
      } else if (hash !== spec.sha256) {
        throw new Error(`sha256 mismatch for ${name}: got ${hash}, manifest says ${spec.sha256}`);
      } else {
        console.log(`ok ${name}`);
      }
    }
  }
  if (manifestDirty) {
    writeFileSync(resolve(ROOT, "datasets/manifest.json"), JSON.stringify(m, null, 2) + "\n");
    console.log("manifest.json updated with pinned hashes — commit it.");
  }
}

function subset(name: string): Subset | null {
  const p = resolve(SUBSETS_DIR, `${name}.json`);
  return existsSync(p) ? readJson<Subset>(p) : null;
}

async function materializeFatura(): Promise<void> {
  const sub = subset("invoice-fatura");
  if (!sub) return;
  const outDir = resolve(FILES_DIR, "fatura");
  mkdirSync(outDir, { recursive: true });
  const zip = await openZip.file(sourcePath("FATURA.zip"));
  const byPath = new Map(zip.files.map((f) => [f.path, f]));
  for (const id of sub.ids) {
    const imgOut = resolve(outDir, `${id}.jpg`);
    if (!existsSync(imgOut)) {
      const e = byPath.get(`invoices_dataset_final/images/${id}.jpg`);
      if (!e) throw new Error(`FATURA image missing: ${id}`);
      writeFileSync(imgOut, await e.buffer());
    }
    const gtOut = resolve(GT_DIR, "fatura", `${id}.json`);
    if (!existsSync(gtOut)) {
      const e = byPath.get(`invoices_dataset_final/Annotations/Original_Format/${id}.json`);
      if (!e) throw new Error(`FATURA annotation missing: ${id}`);
      writeJson(gtOut, faturaToInvoiceGt((await e.buffer()).toString("utf8")));
    }
  }
  console.log(`fatura: ${sub.ids.length} docs materialized`);
}

async function materializeSroie(): Promise<void> {
  const sub = subset("receipt-sroie");
  if (!sub) return;
  const m = manifest();
  const rev = m.datasets.sroie.revision as string;
  const samples = (
    JSON.parse(readFileSync(sourcePath("samples.json"), "utf8")) as {
      samples: { filepath: string; company?: string; date?: string; address?: string; total?: string }[];
    }
  ).samples;
  const byId = new Map(samples.map((s) => [s.filepath.replace(/^data\//, "").replace(/\.jpg$/, ""), s]));
  const imgDir = resolve(FILES_DIR, "sroie");
  const gtDir = resolve(FILES_DIR, "sroie-gt"); // intentionally under files/ → git-ignored
  mkdirSync(imgDir, { recursive: true });
  mkdirSync(gtDir, { recursive: true });
  let n = 0;
  for (const id of sub.ids) {
    const s = byId.get(id);
    if (!s) throw new Error(`SROIE sample missing from samples.json: ${id}`);
    writeJson(resolve(gtDir, `${id}.json`), {
      merchant: s.company ?? null,
      date: s.date ?? null,
      address: s.address ?? null,
      total: s.total ?? null,
    });
    if (GT_SROIE_ONLY) continue;
    const imgOut = resolve(imgDir, `${id}.jpg`);
    if (!existsSync(imgOut)) {
      await download(
        `https://huggingface.co/datasets/Voxel51/scanned_receipts/resolve/${rev}/data/${id}.jpg`,
        imgOut,
      );
      n++;
    }
  }
  console.log(`sroie: GT for ${sub.ids.length} docs${GT_SROIE_ONLY ? " (gt only)" : `, ${n} images downloaded`}`);
}

async function materializeCord(): Promise<void> {
  const sub = subset("receipt-cord");
  if (!sub) return;
  const outDir = resolve(FILES_DIR, "cord");
  mkdirSync(outDir, { recursive: true });
  const done = sub.ids.every(
    (id) => existsSync(resolve(outDir, `${id}.png`)) && existsSync(resolve(GT_DIR, "cord", `${id}.json`)),
  );
  if (done) {
    console.log("cord: already materialized");
    return;
  }
  const file = await asyncBufferFromFile(sourcePath("cord-test.parquet"));
  const rows = await parquetReadObjects({ file, columns: ["image", "ground_truth"], compressors });
  if (rows.length !== 100) throw new Error(`CORD test split: expected 100 rows, got ${rows.length}`);
  rows.forEach((row, i) => {
    const id = `cord-test-${String(i).padStart(4, "0")}`;
    if (!sub.ids.includes(id)) return;
    const img = row.image as { bytes: Uint8Array; path?: string };
    writeFileSync(resolve(outDir, `${id}.png`), Buffer.from(img.bytes));
    writeJson(resolve(GT_DIR, "cord", `${id}.json`), cordToReceiptGt(String(row.ground_truth)));
  });
  console.log(`cord: ${sub.ids.length} docs materialized`);
}

async function materializeFintabnet(): Promise<void> {
  const sub = subset("tables-fintabnet");
  if (!sub) return;
  const outDir = resolve(FILES_DIR, "fintabnet");
  mkdirSync(outDir, { recursive: true });
  const shards = ["fintabnet-test-0.parquet", "fintabnet-test-1.parquet"];
  const wanted = sub.ids
    .map((id) => {
      const m = id.match(/^(\d+):(\d+):(.*)$/);
      if (!m) throw new Error(`bad fintabnet id: ${id}`);
      return { id, shard: Number(m[1]), row: Number(m[2]) };
    })
    .sort((a, b) => a.shard - b.shard || a.row - b.row);
  for (const w of wanted) {
    const imgOut = resolve(outDir, `${safeId(w.id)}.png`);
    const gtOut = resolve(GT_DIR, "fintabnet", `${safeId(w.id)}.html`);
    if (existsSync(imgOut) && existsSync(gtOut)) continue;
    const file = await asyncBufferFromFile(sourcePath(shards[w.shard]));
    const rows = await parquetReadObjects({
      file,
      columns: ["image", "html", "cells", "filename", "imgid"],
      rowStart: w.row,
      rowEnd: w.row + 1,
      compressors,
    });
    const row = rows[0];
    const expected = `${w.shard}:${w.row}:${row.filename}#${row.imgid}`;
    if (expected !== w.id) throw new Error(`fintabnet row identity mismatch: ${expected} != ${w.id}`);
    const img = row.image as { bytes: Uint8Array };
    writeFileSync(imgOut, Buffer.from(img.bytes));
    // `cells` is nested one level ([[cell,…]]) in the parquet encoding.
    const cellList = (row.cells as { tokens: string[] }[][])[0] ?? [];
    const html = fintabnetToHtml(row.html as string[], cellList);
    mkdirSync(resolve(GT_DIR, "fintabnet"), { recursive: true });
    writeFileSync(gtOut, html);
  }
  console.log(`fintabnet: ${sub.ids.length} tables materialized`);
}

async function materializeBankstatemently(): Promise<void> {
  const sub = subset("statement-bankstatemently");
  if (!sub) return;
  const outDir = resolve(FILES_DIR, "bankstatemently");
  mkdirSync(outDir, { recursive: true });
  for (const id of sub.ids) {
    const src = sourcePath(`${id}-statement.pdf`);
    const dest = resolve(outDir, `${id}.pdf`);
    if (!existsSync(dest)) writeFileSync(dest, readFileSync(src));
  }
  console.log(`bankstatemently: ${sub.ids.length} statements materialized`);
}

async function main() {
  await fetchSources();
  if (VERIFY_ONLY) return;
  if (GT_SROIE_ONLY) {
    await materializeSroie();
    return;
  }
  await materializeFatura();
  await materializeSroie();
  await materializeCord();
  await materializeFintabnet();
  await materializeBankstatemently();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
