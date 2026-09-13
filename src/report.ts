/** Aggregate results/scored/ → results/latest.json (+ dated history copy)
 *  and regenerate the README results tables between the RESULTS markers.
 *
 *    tsx src/report.ts
 *
 *  Deterministic: reads only committed inputs, so anyone can regenerate the
 *  README numbers offline after `tsx src/run.ts --replay`. */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, readJson, writeJson } from "../datasets/lib.js";

interface Scored {
  vendor: string;
  dataset: string;
  docType: string;
  n: number;
  failures: number;
  latencyMsP50: number | null;
  fieldAccuracy?: number | null;
  anls?: number | null;
  perField?: Record<string, { accuracy: number; n: number }>;
  items?: { precision: number | null; recall: number | null; f1: number | null };
  totalsAccuracy?: number | null;
  teds?: number | null;
  steds?: number | null;
  evaluated?: number;
  normalizedOverall?: number | null;
  normalizedFields?: Record<string, number | null>;
}

const VENDOR_LABELS: Record<string, string> = {
  compound: "Compound Core",
  textract: "AWS Textract",
  docai: "Google Document AI",
  veryfi: "Veryfi",
  llamaparse: "LlamaParse",
};
const VENDOR_ORDER = ["compound", "textract", "docai", "veryfi", "llamaparse"];

function pct(x: number | null | undefined): string {
  return x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`;
}
function f3(x: number | null | undefined): string {
  return x === null || x === undefined ? "—" : x.toFixed(3);
}
function secs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

function main() {
  const scoredDir = resolve(ROOT, "results/scored");
  const all: Scored[] = existsSync(scoredDir)
    ? readdirSync(scoredDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const { docs: _docs, ...agg } = readJson<Scored & { docs: unknown }>(resolve(scoredDir, f));
          return agg as Scored;
        })
    : [];

  const byDataset = (ds: string) =>
    all
      .filter((s) => s.dataset === ds)
      .sort((a, b) => VENDOR_ORDER.indexOf(a.vendor) - VENDOR_ORDER.indexOf(b.vendor));

  const generatedAt = new Date().toISOString();
  const latest = {
    generatedAt,
    runUrl: process.env.BENCHMARK_RUN_URL ?? null,
    results: all,
  };
  writeJson(resolve(ROOT, "results/latest.json"), latest);
  writeJson(resolve(ROOT, "results/history", `${generatedAt.slice(0, 10)}.json`), latest);

  // ---------------- README table ----------------
  const lines: string[] = [];
  lines.push(`_Last generated ${generatedAt.slice(0, 10)} — every number below is recomputable offline from the committed raw responses via \`pnpm replay && pnpm report\`._`);
  lines.push("");

  lines.push("### Invoices — FATURA, n=100 (2 per each of 50 layouts)");
  lines.push("");
  lines.push("| Vendor | Field accuracy | ANLS (diagnostic) | Median latency | Failures |");
  lines.push("|---|---|---|---|---|");
  for (const s of byDataset("fatura"))
    lines.push(`| ${VENDOR_LABELS[s.vendor] ?? s.vendor} | **${pct(s.fieldAccuracy)}** | ${pct(s.anls)} | ${secs(s.latencyMsP50)} | ${s.failures}/${s.n} |`);
  lines.push("");

  lines.push("### Receipts — SROIE test subset, n=100 (merchant / date / address / total)");
  lines.push("");
  lines.push("| Vendor | Field accuracy | ANLS (diagnostic) | Median latency | Failures |");
  lines.push("|---|---|---|---|---|");
  for (const s of byDataset("sroie"))
    lines.push(`| ${VENDOR_LABELS[s.vendor] ?? s.vendor} | **${pct(s.fieldAccuracy)}** | ${pct(s.anls)} | ${secs(s.latencyMsP50)} | ${s.failures}/${s.n} |`);
  lines.push("");

  lines.push("### Receipts — CORD-v2 full official test split, n=100 (line items + totals)");
  lines.push("");
  lines.push("| Vendor | Line-item F1 | Precision | Recall | Totals accuracy | Median latency |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of byDataset("cord"))
    lines.push(`| ${VENDOR_LABELS[s.vendor] ?? s.vendor} | **${pct(s.items?.f1)}** | ${pct(s.items?.precision)} | ${pct(s.items?.recall)} | ${pct(s.totalsAccuracy)} | ${secs(s.latencyMsP50)} |`);
  lines.push("");

  lines.push("### Tables — FinTabNet test subset, n=100 (TEDS against ground-truth HTML)");
  lines.push("");
  lines.push("| Vendor | TEDS | S-TEDS (structure only) | Median latency | Failures |");
  lines.push("|---|---|---|---|---|");
  for (const s of byDataset("fintabnet"))
    lines.push(`| ${VENDOR_LABELS[s.vendor] ?? s.vendor} | **${f3(s.teds)}** | ${f3(s.steds)} | ${secs(s.latencyMsP50)} | ${s.failures}/${s.n} |`);
  lines.push("");

  lines.push("### Bank statements — Bankstatemently Open Benchmark, n=5 (all published statements)");
  lines.push("");
  const stmt = byDataset("bankstatemently");
  const anyEvaluated = stmt.some((s) => (s.evaluated ?? 0) > 0);
  if (anyEvaluated) {
    lines.push("| Vendor | Normalized overall | date | description | amount | balance | Evaluated |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const s of stmt)
      lines.push(
        `| ${VENDOR_LABELS[s.vendor] ?? s.vendor} | **${pct(s.normalizedOverall)}** | ${pct(s.normalizedFields?.date)} | ${pct(s.normalizedFields?.description)} | ${pct(s.normalizedFields?.amount)} | ${pct(s.normalizedFields?.balance)} | ${s.evaluated}/${s.n} |`,
      );
    lines.push("");
    lines.push("_Statement scores are the Bankstatemently evaluation API's `normalizedScore`, reported verbatim (their ground truth is server-side; we never self-score statements). AWS Textract has no bank-statement product. Veryfi's statement product was not run (no credentials — see BYO keys)._");
  } else {
    lines.push("| Vendor | Parses cached | Status |");
    lines.push("|---|---|---|");
    for (const s of stmt)
      lines.push(`| ${VENDOR_LABELS[s.vendor] ?? s.vendor} | ${s.n - s.failures}/${s.n} | evaluation pending (upstream) |`);
    lines.push("");
    lines.push(
      "_Statements are scored exclusively by the [Bankstatemently evaluation API](https://github.com/bankstatemently/bank-statement-parsing-benchmark) (server-side ground truth). At the time of this run their evaluator returned an internal ground-truth error (`parsed ground truth transaction 0 is missing account.kind`) for every published statement PDF, so scores are pending an upstream fix. Our parses are committed under `results/raw/*/bankstatemently/` and will be submitted unchanged once the evaluator is fixed. AWS Textract has no bank-statement product._",
    );
  }
  lines.push("");

  const readmePath = resolve(ROOT, "README.md");
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, "utf8");
    const updated = readme.replace(
      /<!-- RESULTS_START -->[\s\S]*<!-- RESULTS_END -->/,
      `<!-- RESULTS_START -->\n${lines.join("\n")}\n<!-- RESULTS_END -->`,
    );
    writeFileSync(readmePath, updated);
    console.log("README results table regenerated.");
  }
  console.log(`latest.json written (${all.length} vendor×dataset aggregates).`);
}

main();
