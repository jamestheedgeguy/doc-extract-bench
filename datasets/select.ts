/** Deterministic, seeded subset selection — the PRE-REGISTRATION step.
 *
 *  Reads the dataset sources already downloaded by `pnpm fetch`, derives each
 *  benchmark subset from the committed seed, and writes the ID lists to
 *  datasets/subsets/*.json. Those ID lists are committed BEFORE any vendor
 *  API call is made; no document is ever added or removed after results are
 *  seen. Re-running this script must always reproduce the committed lists
 *  byte-for-byte (guarded by --check).
 *
 *    pnpm select            # write subsets
 *    pnpm select --check    # verify committed subsets match re-derivation
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import unzipper from "unzipper";
const openZip = unzipper.Open;
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import {
  SUBSETS_DIR,
  manifest,
  readJson,
  seededSample,
  sourcePath,
  writeJson,
  type Subset,
} from "./lib.js";

const CHECK = process.argv.includes("--check");

function emit(name: string, subset: Subset): void {
  const path = resolve(SUBSETS_DIR, `${name}.json`);
  if (CHECK) {
    const committed = readJson<Subset>(path);
    const same = JSON.stringify(committed.ids) === JSON.stringify(subset.ids);
    if (!same) {
      console.error(`MISMATCH: ${name} — committed subset differs from re-derivation`);
      process.exitCode = 1;
    } else {
      console.log(`ok: ${name} (${subset.ids.length} ids)`);
    }
    return;
  }
  if (existsSync(path)) {
    // Never silently overwrite a pre-registered list.
    const committed = readJson<Subset>(path);
    subset = { ...subset, selectedAt: committed.selectedAt };
    if (JSON.stringify(committed.ids) !== JSON.stringify(subset.ids)) {
      throw new Error(`${name}: subset already registered and derivation changed — refusing to overwrite`);
    }
  }
  writeJson(path, subset);
  console.log(`${name}: ${subset.ids.length} ids`);
}

async function main() {
  const m = manifest();
  const seed = m.seed;
  const now = new Date().toISOString();

  // ---- FATURA: 2 per template from the official strat1 test split --------
  {
    const zipPath = sourcePath("FATURA.zip");
    if (!existsSync(zipPath)) throw new Error("run `pnpm fetch` first (FATURA.zip missing)");
    const zip = await openZip.file(zipPath);
    const csvEntry = zip.files.find((f) => f.path === "invoices_dataset_final/strat1_test.csv");
    if (!csvEntry) throw new Error("strat1_test.csv not found in FATURA.zip");
    const csv = (await csvEntry.buffer()).toString("utf8");
    const byTemplate = new Map<number, string[]>();
    for (const line of csv.split("\n").slice(1)) {
      const img = line.split(",")[0]?.trim();
      const mt = img?.match(/^Template(\d+)_Instance(\d+)\.jpg$/);
      if (!mt) continue;
      const t = Number(mt[1]);
      if (!byTemplate.has(t)) byTemplate.set(t, []);
      byTemplate.get(t)!.push(img.replace(/\.jpg$/, ""));
    }
    const ids: string[] = [];
    for (const t of [...byTemplate.keys()].sort((a, b) => a - b)) {
      // Independent seeded draw per template (seed offset by template number).
      ids.push(...seededSample(byTemplate.get(t)!, 2, seed + t, (x) => x));
    }
    emit("invoice-fatura", {
      dataset: "fatura",
      docType: "invoice",
      seed,
      selectedAt: now,
      note: "2 docs per each of the 50 templates, drawn from the official strat1 test split (per-template seed = seed + templateNumber)",
      ids,
    });
  }

  // ---- SROIE: seeded 100 of the annotated samples -------------------------
  {
    const samplesPath = sourcePath("samples.json");
    if (!existsSync(samplesPath)) throw new Error("run `pnpm fetch` first (samples.json missing)");
    const samples = (JSON.parse(readFileSync(samplesPath, "utf8")) as { samples: { filepath: string; company?: string }[] })
      .samples;
    const annotated = samples.filter((s) => typeof s.company === "string");
    const picked = seededSample(annotated, 100, seed, (s) => s.filepath);
    emit("receipt-sroie", {
      dataset: "sroie",
      docType: "receipt",
      seed,
      selectedAt: now,
      note: `seeded 100 of ${annotated.length} annotated receipts`,
      ids: picked.map((s) => s.filepath.replace(/^data\//, "").replace(/\.jpg$/, "")),
    });
  }

  // ---- CORD-v2: the full official test split ------------------------------
  {
    emit("receipt-cord", {
      dataset: "cord",
      docType: "receipt",
      seed: null,
      selectedAt: now,
      note: "the FULL official test split (100 docs) — no sampling; id = row index in the official test parquet",
      ids: Array.from({ length: 100 }, (_, i) => `cord-test-${String(i).padStart(4, "0")}`),
    });
  }

  // ---- FinTabNet_OTSL: seeded 100 of the official test split --------------
  {
    const rows: { filename: string; imgid: number | bigint; shard: number; row: number }[] = [];
    for (const [shard, name] of ["fintabnet-test-0.parquet", "fintabnet-test-1.parquet"].entries()) {
      const p = sourcePath(name);
      if (!existsSync(p)) throw new Error(`run \`pnpm fetch\` first (${name} missing)`);
      const file = await asyncBufferFromFile(p);
      const objs = await parquetReadObjects({ file, columns: ["filename", "imgid"], compressors });
      objs.forEach((o, i) =>
        rows.push({ filename: String(o.filename), imgid: o.imgid as number, shard, row: i }),
      );
    }
    const picked = seededSample(rows, 100, seed, (r) => `${r.filename}#${r.imgid}`);
    emit("tables-fintabnet", {
      dataset: "fintabnet",
      docType: "tables",
      seed,
      selectedAt: now,
      note: `seeded 100 of ${rows.length} tables in the official test split; id = <shard>:<row>:<filename>#<imgid>`,
      ids: picked.map((r) => `${r.shard}:${r.row}:${r.filename}#${r.imgid}`),
    });
  }

  // ---- Bankstatemently: every published statement --------------------------
  {
    emit("statement-bankstatemently", {
      dataset: "bankstatemently",
      docType: "statement",
      seed: null,
      selectedAt: now,
      note: "all statements published upstream at the pinned commit (bsb-006..bsb-015 are 'coming soon' and not yet downloadable) — n=5",
      ids: ["bsb-001", "bsb-002", "bsb-003", "bsb-004", "bsb-005"],
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
