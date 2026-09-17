/** Packet Intake — shells out to `python -m packet_intake.extract --file … --json`.
 *  Maps PacketBench ExtractionResult (jamestheedgeguy/packet-intake PR #3,
 *  tip 34d10dac) into this harness's canonical invoice/receipt/table schemas.
 *
 *  Env:
 *    PACKET_INTAKE_PYTHON — Python executable (default `python3` on PATH)
 *    PACKET_INTAKE_ROOT   — checkout of packet-intake; `src/` is prepended to
 *                           PYTHONPATH so `python -m packet_intake.extract` works
 *                           without a site-packages install
 *
 *  Live Layer 1 uses OpenRouter only *inside* Packet Intake (OPENROUTER_API_KEY
 *  in that environment). This adapter never calls Textract or Document AI.
 *
 *  Cost gate: $0.04/doc conservative estimate (two OpenRouter vision calls).
 *  When a prior ExtractionResult is in hand, sum model_runs[].cost_usd instead
 *  (see costFromRaw). The estimate is used before any live run because raw is
 *  not yet known. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { normalizeAmount } from "../score/normalize.js";
import type { CanonicalInvoice, InvoiceLineItem } from "../schemas/invoice.js";
import type { CanonicalReceipt, ReceiptItem } from "../schemas/receipt.js";
import type { CanonicalStatement } from "../schemas/statement.js";
import type { CanonicalTable } from "../schemas/table.js";
import { now, type Adapter, type AdapterResult, type DocType } from "./types.js";

/** Conservative per-document estimate for the pre-run cost gate. */
export const PACKET_INTAKE_UNIT_PRICE_USD = 0.04;

const CLI_TIMEOUT_MS = 420_000;
const PROBE_TIMEOUT_MS = 8_000;

interface StringField {
  value?: string | null;
  confidence?: number | null;
}
interface DecimalField {
  value?: string | number | null;
  confidence?: number | null;
}
interface ModelRun {
  model_id?: string;
  purpose?: string;
  cost_usd?: number | null;
  latency_ms?: number | null;
}
interface ExtractionResult {
  header?: {
    invoice_number?: StringField;
    invoice_date?: StringField;
    due_date?: StringField;
    vendor_name?: StringField;
    vendor_address?: StringField;
    vendor_tax_id?: StringField;
    customer_name?: StringField;
    po_number?: StringField;
    currency?: StringField;
    payment_terms?: StringField;
    iban?: StringField;
  };
  line_items?: {
    description?: StringField;
    sku?: StringField;
    quantity?: DecimalField;
    unit_price?: DecimalField;
    amount?: DecimalField;
    currency?: StringField;
  }[];
  totals?: {
    subtotal?: DecimalField;
    tax?: DecimalField;
    freight?: DecimalField;
    discount?: DecimalField;
    total?: DecimalField;
  };
  table_html?: StringField;
  table_html_raw?: StringField;
  model_runs?: ModelRun[];
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function fieldValue(v: unknown): unknown {
  if (v && typeof v === "object" && "value" in (v as object)) return (v as { value: unknown }).value;
  return v;
}

function strField(v: unknown): string | null {
  const val = fieldValue(v);
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s || null;
}

function numField(v: unknown): number | null {
  return normalizeAmount(fieldValue(v));
}

function extFor(mimeType: string): string {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/tiff") return "tiff";
  return "bin";
}

function pythonBin(): string {
  const override = process.env.PACKET_INTAKE_PYTHON?.trim();
  return override || "python3";
}

function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const root = process.env.PACKET_INTAKE_ROOT?.trim();
  if (root) {
    const extra = [join(root, "src"), root].join(delimiter);
    env.PYTHONPATH = env.PYTHONPATH ? `${extra}${delimiter}${env.PYTHONPATH}` : extra;
  }
  return env;
}

function cliCwd(): string | undefined {
  const root = process.env.PACKET_INTAKE_ROOT?.trim();
  return root || undefined;
}

const SKIP_CLI =
  "packet_intake CLI not configured (set PACKET_INTAKE_PYTHON and/or PACKET_INTAKE_ROOT, or install packet-intake on PATH)";

function probeCli(): string | null {
  const python = pythonBin();
  const r = spawnSync(python, ["-c", "import packet_intake.extract"], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    env: cliEnv(),
    cwd: cliCwd(),
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return SKIP_CLI;
    return `${SKIP_CLI} (${r.error.message})`;
  }
  if (r.status !== 0) return SKIP_CLI;
  return null;
}

/** Sum model_runs[].cost_usd from a prior ExtractionResult, or null if unknown. */
export function costFromRaw(raw: unknown): number | null {
  const runs = (rec(raw).model_runs as ModelRun[] | undefined) ?? [];
  if (!Array.isArray(runs) || !runs.length) return null;
  let sum = 0;
  let any = false;
  for (const run of runs) {
    const c = run?.cost_usd;
    if (typeof c === "number" && Number.isFinite(c)) {
      sum += c;
      any = true;
    }
  }
  return any ? sum : null;
}

function parseCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`packetintake CLI produced non-JSON stdout: ${trimmed.slice(0, 200)}`);
  }
}

function invokeCli(filePath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), ["-m", "packet_intake.extract", "--file", filePath, "--json"], {
      env: cliEnv(),
      cwd: cliCwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`packetintake CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `packetintake CLI exit ${code}: ${(stderr || stdout).trim().slice(0, 500) || "no output"}`,
          ),
        );
        return;
      }
      try {
        resolve(parseCliJson(stdout));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

function lineItems(raw: ExtractionResult): InvoiceLineItem[] {
  const items: InvoiceLineItem[] = [];
  for (const li of raw.line_items ?? []) {
    items.push({
      description: strField(li.description),
      quantity: numField(li.quantity),
      unitPrice: numField(li.unit_price),
      amount: numField(li.amount),
    });
  }
  return items;
}

function receiptItems(raw: ExtractionResult): ReceiptItem[] {
  return lineItems(raw);
}

function tableHtmlOf(raw: ExtractionResult): string | null {
  // Prefer the minimized TEDS-friendly HTML; fall back to the raw table string.
  return strField(raw.table_html) ?? strField(raw.table_html_raw);
}

export const packetintake: Adapter = {
  name: "packetintake",

  available(docType) {
    if (docType === "statement")
      return "no product (Packet Intake does not map bank statements yet)";
    return probeCli();
  },

  unitPriceUsd() {
    // Cost gate only — live spend is OpenRouter via Packet Intake, recorded on
    // ExtractionResult.model_runs[].cost_usd. See PACKET_INTAKE_UNIT_PRICE_USD.
    return PACKET_INTAKE_UNIT_PRICE_USD;
  },

  async run(doc, mimeType, docType): Promise<AdapterResult> {
    const why = this.available(docType);
    if (why) throw new Error(why);

    const dir = mkdtempSync(join(tmpdir(), "packetintake-"));
    const file = join(dir, `doc.${extFor(mimeType)}`);
    const t0 = now();
    try {
      writeFileSync(file, doc);
      const raw = await invokeCli(file);
      const latencyMs = Math.round(now() - t0);
      return { canonical: this.fromRaw(raw, docType), latencyMs, raw };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  fromRaw(raw, docType) {
    const er = rec(raw) as ExtractionResult;
    const header = er.header ?? {};
    const totals = er.totals ?? {};

    if (docType === "tables") {
      const html = tableHtmlOf(er);
      const canonical: CanonicalTable = { html, tableCount: html ? 1 : 0 };
      return canonical;
    }

    if (docType === "invoice") {
      const canonical: CanonicalInvoice = {
        vendorName: strField(header.vendor_name),
        customerName: strField(header.customer_name),
        invoiceNumber: strField(header.invoice_number),
        issueDate: strField(header.invoice_date),
        dueDate: strField(header.due_date),
        currency: strField(header.currency),
        subtotal: numField(totals.subtotal),
        tax: numField(totals.tax),
        total: numField(totals.total),
        lineItems: lineItems(er),
      };
      return canonical;
    }

    if (docType === "receipt") {
      const canonical: CanonicalReceipt = {
        merchant: strField(header.vendor_name),
        address: strField(header.vendor_address),
        date: strField(header.invoice_date),
        subtotal: numField(totals.subtotal),
        tax: numField(totals.tax),
        serviceCharge: null,
        total: numField(totals.total),
        items: receiptItems(er),
      };
      return canonical;
    }

    const canonical: CanonicalStatement = {
      institution: null,
      accountHolder: null,
      periodStart: null,
      periodEnd: null,
      currency: strField(header.currency),
      openingBalance: null,
      closingBalance: null,
      transactions: [],
    };
    return canonical;
  },
};
