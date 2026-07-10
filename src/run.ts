/** Benchmark runner.
 *
 *    tsx src/run.ts                         # run everything available
 *    tsx src/run.ts --vendor kynth          # one vendor
 *    tsx src/run.ts --doctype invoice       # one doc type
 *    tsx src/run.ts --limit 5               # first N docs per dataset (smoke)
 *    tsx src/run.ts --replay                # re-score committed raw responses
 *                                           #   (zero keys, zero API calls)
 *    tsx src/run.ts --dry-run               # cost gate only, no calls
 *
 *  COST GATE: before ANY paid vendor call the runner prints per-vendor
 *  doc counts × unit price and refuses to run if the projected total
 *  exceeds MAX_RUN_USD (default 60).
 *
 *  Raw vendor responses are written verbatim to
 *  results/raw/<vendor>/<dataset>/<docId>.json and committed, so every
 *  number in the README can be recomputed offline with --replay. */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FILES_DIR, GT_DIR, ROOT, SUBSETS_DIR, readJson, writeJson, type Subset } from "../datasets/lib.js";
import { kynth } from "./adapters/kynth.js";
import { textract } from "./adapters/textract.js";
import { docai } from "./adapters/docai.js";
import { veryfi } from "./adapters/veryfi.js";
import { llamaparse } from "./adapters/llamaparse.js";
import type { Adapter, DocType } from "./adapters/types.js";
import { INVOICE_FIELDS, INVOICE_FIELD_TYPES, type CanonicalInvoice } from "./schemas/invoice.js";
import {
  CORD_TOTAL_FIELDS,
  CORD_TOTAL_FIELD_TYPES,
  SROIE_FIELDS,
  SROIE_FIELD_TYPES,
  type CanonicalReceipt,
} from "./schemas/receipt.js";
import type { CanonicalStatement } from "./schemas/statement.js";
import type { CanonicalTable } from "./schemas/table.js";
import { scoreFields, type FieldsResult } from "./score/fields.js";
import { scoreItems, type ItemsResult } from "./score/lineitems.js";
import { teds } from "./score/teds.js";

// ------------------------------------------------------------ CLI parsing

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const REPLAY = process.argv.includes("--replay");
const DRY_RUN = process.argv.includes("--dry-run");
const VENDORS_FILTER = argValue("--vendor")?.split(",") ?? null;
const DOCTYPE_FILTER = argValue("--doctype")?.split(",") ?? null;
const LIMIT = argValue("--limit") ? Number(argValue("--limit")) : null;
const MAX_RUN_USD = Number(process.env.MAX_RUN_USD ?? argValue("--max-usd") ?? 60);

const ADAPTERS: Adapter[] = [kynth, textract, docai, veryfi, llamaparse];

// ------------------------------------------------------------ datasets

interface DatasetSpec {
  name: string;
  docType: DocType;
  subsetFile: string;
  fileFor(id: string): { path: string; mimeType: string };
  /** page count for per-page pricing (images = 1) */
  pages(id: string): number;
}

// Page counts for the bankstatemently PDFs (from upstream statement-info.json).
const BSB_PAGES: Record<string, number> = { "bsb-001": 3, "bsb-002": 4, "bsb-003": 3, "bsb-004": 4, "bsb-005": 2 };

export function safeId(id: string): string {
  return id.replace(/[/:#]/g, "_");
}

const DATASETS: DatasetSpec[] = [
  {
    name: "fatura",
    docType: "invoice",
    subsetFile: "invoice-fatura.json",
    fileFor: (id) => ({ path: resolve(FILES_DIR, "fatura", `${id}.jpg`), mimeType: "image/jpeg" }),
    pages: () => 1,
  },
  {
    name: "sroie",
    docType: "receipt",
    subsetFile: "receipt-sroie.json",
    fileFor: (id) => ({ path: resolve(FILES_DIR, "sroie", `${id}.jpg`), mimeType: "image/jpeg" }),
    pages: () => 1,
  },
  {
    name: "cord",
    docType: "receipt",
    subsetFile: "receipt-cord.json",
    fileFor: (id) => ({ path: resolve(FILES_DIR, "cord", `${id}.png`), mimeType: "image/png" }),
    pages: () => 1,
  },
  {
    name: "fintabnet",
    docType: "tables",
    subsetFile: "tables-fintabnet.json",
    fileFor: (id) => ({ path: resolve(FILES_DIR, "fintabnet", `${safeId(id)}.png`), mimeType: "image/png" }),
    pages: () => 1,
  },
  {
    name: "bankstatemently",
    docType: "statement",
    subsetFile: "statement-bankstatemently.json",
    fileFor: (id) => ({ path: resolve(FILES_DIR, "bankstatemently", `${id}.pdf`), mimeType: "application/pdf" }),
    pages: (id) => BSB_PAGES[id] ?? 1,
  },
];

interface RawRecord {
  vendor: string;
  dataset: string;
  docId: string;
  at: string;
  latencyMs: number;
  raw: unknown;
  error?: string;
}

function rawPath(vendor: string, dataset: string, docId: string): string {
  return resolve(ROOT, "results/raw", vendor, dataset, `${safeId(docId)}.json`);
}

function evalPath(vendor: string, docId: string): string {
  return resolve(ROOT, "results/raw", vendor, "bankstatemently-eval", `${safeId(docId)}.json`);
}

// ------------------------------------------------------------ live runs

async function runLive(): Promise<void> {
  // ----- plan + cost gate ---------------------------------------------
  interface Task {
    adapter: Adapter;
    ds: DatasetSpec;
    ids: string[];
    costUsd: number;
  }
  const tasks: Task[] = [];
  const skips: string[] = [];
  for (const ds of DATASETS) {
    if (DOCTYPE_FILTER && !DOCTYPE_FILTER.includes(ds.docType)) continue;
    const subset = readJson<Subset>(resolve(SUBSETS_DIR, ds.subsetFile));
    const allIds = LIMIT ? subset.ids.slice(0, LIMIT) : subset.ids;
    for (const adapter of ADAPTERS) {
      if (VENDORS_FILTER && !VENDORS_FILTER.includes(adapter.name)) continue;
      const why = adapter.available(ds.docType);
      if (why) {
        skips.push(`${adapter.name}/${ds.name}: SKIPPED — ${why}`);
        continue;
      }
      const ids = allIds.filter((id) => !existsSync(rawPath(adapter.name, ds.name, id)));
      const costUsd = ids.reduce((a, id) => a + adapter.unitPriceUsd(ds.docType, ds.pages(id)), 0);
      tasks.push({ adapter, ds, ids, costUsd });
    }
  }

  console.log("\n=== COST GATE ===");
  let total = 0;
  for (const t of tasks) {
    const unit = t.ids.length ? t.costUsd / t.ids.length : 0;
    console.log(
      `${t.adapter.name.padEnd(11)} ${t.ds.name.padEnd(16)} ${String(t.ids.length).padStart(4)} docs × ~$${unit.toFixed(4)} = $${t.costUsd.toFixed(2)}`,
    );
    total += t.costUsd;
  }
  for (const s of skips) console.log(s);
  console.log(`TOTAL projected: $${total.toFixed(2)} (cap $${MAX_RUN_USD.toFixed(2)})`);
  if (total > MAX_RUN_USD) {
    console.error(`REFUSING TO RUN: projected cost $${total.toFixed(2)} > MAX_RUN_USD $${MAX_RUN_USD}`);
    process.exit(1);
  }
  if (DRY_RUN) return;

  // ----- execute -------------------------------------------------------
  for (const t of tasks) {
    let done = 0;
    for (const id of t.ids) {
      const { path, mimeType } = t.ds.fileFor(id);
      const doc = readFileSync(path);
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await t.adapter.run(doc, mimeType, t.ds.docType);
          const rec: RawRecord = {
            vendor: t.adapter.name,
            dataset: t.ds.name,
            docId: id,
            at: new Date().toISOString(),
            latencyMs: r.latencyMs,
            raw: r.raw,
          };
          writeJson(rawPath(t.adapter.name, t.ds.name, id), rec);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await new Promise((r2) => setTimeout(r2, 3000 * (attempt + 1)));
        }
      }
      if (lastErr) {
        const rec: RawRecord = {
          vendor: t.adapter.name,
          dataset: t.ds.name,
          docId: id,
          at: new Date().toISOString(),
          latencyMs: 0,
          raw: null,
          error: String(lastErr instanceof Error ? lastErr.message : lastErr).slice(0, 500),
        };
        writeJson(rawPath(t.adapter.name, t.ds.name, id), rec);
        console.error(`  ${t.adapter.name}/${t.ds.name}/${id}: FAILED — ${rec.error}`);
      }
      done++;
      if (done % 10 === 0 || done === t.ids.length)
        console.log(`${t.adapter.name}/${t.ds.name}: ${done}/${t.ids.length}`);
    }
  }

  // ----- statements: submit parses to the Bankstatemently evaluator -----
  await submitStatementEvals();
}

/** Convert a canonical statement parse into a Bankstatemently submission and
 *  cache the evaluator's verdict verbatim. Their GT is server-side; we never
 *  self-score statements. */
async function submitStatementEvals(): Promise<void> {
  const ds = DATASETS.find((d) => d.name === "bankstatemently")!;
  if (DOCTYPE_FILTER && !DOCTYPE_FILTER.includes("statement")) return;
  const key = process.env.BANKSTATEMENTLY_API_KEY;
  const subset = readJson<Subset>(resolve(SUBSETS_DIR, ds.subsetFile));
  for (const adapter of ADAPTERS) {
    if (VENDORS_FILTER && !VENDORS_FILTER.includes(adapter.name)) continue;
    if (adapter.available("statement")) continue;
    for (const id of subset.ids) {
      const rp = rawPath(adapter.name, ds.name, id);
      const ep = evalPath(adapter.name, id);
      if (!existsSync(rp) || existsSync(ep)) continue;
      if (!key) {
        console.log(`${adapter.name}/${id}: parse cached but BANKSTATEMENTLY_API_KEY not set — eval pending`);
        continue;
      }
      const rec = readJson<RawRecord>(rp);
      if (rec.error) continue;
      const canonical = adapter.fromRaw(rec.raw, "statement") as CanonicalStatement;
      const { createHash } = await import("node:crypto");
      const pdf = readFileSync(ds.fileFor(id).path);
      const contentHash = createHash("sha256").update(pdf).digest("hex");
      const transactions = canonical.transactions
        .filter((tx) => tx.amount !== null)
        .map((tx) => ({
          date: tx.date ?? "",
          description: tx.description ?? "",
          amount: Math.abs(tx.amount!),
          direction: tx.amount! < 0 ? "debit" : "credit",
          ...(tx.balance !== null ? { balance: tx.balance } : {}),
          // Our adapters emit normalized values only, so originalData carries
          // the same normalized values — we therefore report the evaluator's
          // normalizedScore (parsedScore would unfairly penalize formatting).
          originalData: {
            Date: tx.date ?? "",
            Description: tx.description ?? "",
            Amount: String(tx.amount),
            ...(tx.balance !== null ? { Balance: String(tx.balance) } : {}),
          },
        }));
      const res = await fetch("https://api.bankstatemently.com/v1/benchmark/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({ contentHash, transactions }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        console.error(`${adapter.name}/${id}: evaluator HTTP ${res.status} — ${JSON.stringify(body).slice(0, 200)}`);
        continue;
      }
      writeJson(ep, { vendor: adapter.name, docId: id, at: new Date().toISOString(), evaluation: body });
      console.log(`${adapter.name}/${id}: evaluated`);
    }
  }
}

// ------------------------------------------------------------ scoring

interface DocScore {
  docId: string;
  latencyMs: number;
  error?: string;
  fields?: FieldsResult;
  items?: ItemsResult;
  totalsFields?: FieldsResult;
  teds?: number;
  steds?: number;
  statement?: unknown;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function scoreAll(): void {
  const rawRoot = resolve(ROOT, "results/raw");
  if (!existsSync(rawRoot)) {
    console.log("no raw results yet");
    return;
  }
  for (const vendor of readdirSync(rawRoot)) {
    const adapter = ADAPTERS.find((a) => a.name === vendor);
    if (!adapter) continue;
    for (const ds of DATASETS) {
      const dir = resolve(rawRoot, vendor, ds.name);
      if (!existsSync(dir)) continue;
      const subset = readJson<Subset>(resolve(SUBSETS_DIR, ds.subsetFile));
      const docs: DocScore[] = [];
      for (const id of subset.ids) {
        const rp = rawPath(vendor, ds.name, id);
        if (!existsSync(rp)) continue;
        const rec = readJson<RawRecord>(rp);
        const d: DocScore = { docId: id, latencyMs: rec.latencyMs };
        if (rec.error) {
          d.error = rec.error;
          docs.push(d);
          continue;
        }
        const canonical = adapter.fromRaw(rec.raw, ds.docType);
        if (ds.name === "fatura") {
          const gt = readJson<CanonicalInvoice>(resolve(GT_DIR, "fatura", `${id}.json`));
          d.fields = scoreFields(INVOICE_FIELDS, INVOICE_FIELD_TYPES, canonical as CanonicalInvoice, gt);
        } else if (ds.name === "sroie") {
          const gtPath = resolve(FILES_DIR, "sroie-gt", `${id}.json`);
          if (!existsSync(gtPath))
            throw new Error("SROIE GT missing — run `pnpm fetch --gt-sroie` (keyless) first");
          const gt = readJson<Record<string, string | null>>(gtPath);
          d.fields = scoreFields(SROIE_FIELDS, SROIE_FIELD_TYPES, canonical as CanonicalReceipt, gt);
        } else if (ds.name === "cord") {
          const gt = readJson<{
            items: { description: string | null; quantity: number | null; unitPrice: number | null; amount: number | null }[];
            subtotal: number | null;
            tax: number | null;
            serviceCharge: number | null;
            total: number | null;
          }>(resolve(GT_DIR, "cord", `${id}.json`));
          const pred = canonical as CanonicalReceipt;
          d.items = scoreItems(pred.items, gt.items);
          d.totalsFields = scoreFields(CORD_TOTAL_FIELDS, CORD_TOTAL_FIELD_TYPES, pred, gt);
        } else if (ds.name === "fintabnet") {
          const gtHtml = readFileSync(resolve(GT_DIR, "fintabnet", `${safeId(id)}.html`), "utf8");
          const predHtml = (canonical as CanonicalTable).html ?? "";
          d.teds = teds(predHtml, gtHtml);
          d.steds = teds(predHtml, gtHtml, { structureOnly: true });
        } else if (ds.name === "bankstatemently") {
          const ep = evalPath(vendor, id);
          if (existsSync(ep)) d.statement = readJson<{ evaluation: unknown }>(ep).evaluation;
        }
        docs.push(d);
      }
      if (!docs.length) continue;

      // aggregate
      const ok = docs.filter((d) => !d.error);
      const agg: Record<string, unknown> = {
        vendor,
        dataset: ds.name,
        docType: ds.docType,
        n: docs.length,
        failures: docs.length - ok.length,
        latencyMsP50: median(ok.map((d) => d.latencyMs).filter((x) => x > 0)),
      };
      if (ds.name === "fatura" || ds.name === "sroie") {
        const scored = ok.reduce((a, d) => a + (d.fields?.scored ?? 0), 0);
        const correct = ok.reduce((a, d) => a + (d.fields?.correct ?? 0), 0);
        agg.fieldAccuracy = scored ? correct / scored : null;
        agg.fieldsScored = scored;
        agg.anls = scored
          ? ok.reduce((a, d) => a + (d.fields?.anls ?? 0) * (d.fields?.scored ?? 0), 0) / scored
          : null;
        const perField: Record<string, { correct: number; scored: number }> = {};
        for (const d of ok)
          for (const f of d.fields?.perField ?? []) {
            if (!f.gtPresent) continue;
            perField[f.field] ??= { correct: 0, scored: 0 };
            perField[f.field].scored++;
            if (f.correct) perField[f.field].correct++;
          }
        agg.perField = Object.fromEntries(
          Object.entries(perField).map(([k, v]) => [k, { accuracy: v.correct / v.scored, n: v.scored }]),
        );
      } else if (ds.name === "cord") {
        const gtCount = ok.reduce((a, d) => a + (d.items?.gtCount ?? 0), 0);
        const predCount = ok.reduce((a, d) => a + (d.items?.predCount ?? 0), 0);
        const correct = ok.reduce((a, d) => a + (d.items?.correct ?? 0), 0);
        const p = predCount ? correct / predCount : null;
        const r = gtCount ? correct / gtCount : null;
        agg.items = {
          precision: p,
          recall: r,
          f1: p !== null && r !== null && p + r > 0 ? (2 * p * r) / (p + r) : 0,
          gtItems: gtCount,
          predItems: predCount,
          correct,
        };
        const tScored = ok.reduce((a, d) => a + (d.totalsFields?.scored ?? 0), 0);
        const tCorrect = ok.reduce((a, d) => a + (d.totalsFields?.correct ?? 0), 0);
        agg.totalsAccuracy = tScored ? tCorrect / tScored : null;
      } else if (ds.name === "fintabnet") {
        const t = ok.map((d) => d.teds ?? 0);
        const s = ok.map((d) => d.steds ?? 0);
        agg.teds = t.length ? t.reduce((a, b) => a + b, 0) / t.length : null;
        agg.steds = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
      } else if (ds.name === "bankstatemently") {
        const evals = ok
          .map((d) => d.statement as { normalizedScore?: { overall?: number; fields?: Record<string, number> } } | undefined)
          .filter((e): e is NonNullable<typeof e> => !!e?.normalizedScore);
        agg.evaluated = evals.length;
        agg.normalizedOverall = evals.length
          ? evals.reduce((a, e) => a + (e.normalizedScore?.overall ?? 0), 0) / evals.length
          : null;
        const fieldKeys = ["date", "description", "amount", "balance"];
        agg.normalizedFields = Object.fromEntries(
          fieldKeys.map((k) => [
            k,
            evals.length
              ? evals.reduce((a, e) => a + (e.normalizedScore?.fields?.[k] ?? 0), 0) / evals.length
              : null,
          ]),
        );
      }
      const outPath = resolve(ROOT, "results/scored", `${vendor}-${ds.name}.json`);
      writeJson(outPath, { ...agg, docs });
      console.log(`scored ${vendor}/${ds.name}: ${JSON.stringify({ ...agg, docs: undefined })}`);
    }
  }
}

async function main() {
  if (!REPLAY && !DRY_RUN) {
    await runLive();
  } else if (DRY_RUN) {
    await runLive();
    return;
  }
  scoreAll();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
