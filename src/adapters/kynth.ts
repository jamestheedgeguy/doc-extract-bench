/** Kynth Core — https://api.kynth.studio
 *  POST /v1/{invoice,receipt,statement,tables} with
 *  { file: { data: <base64>, mimeType } }, Bearer auth.
 *  Env: KYNTH_API_KEY (optional KYNTH_BASE_URL for a dev server). */

import type { CanonicalInvoice } from "../schemas/invoice.js";
import type { CanonicalReceipt } from "../schemas/receipt.js";
import type { CanonicalStatement } from "../schemas/statement.js";
import { gridToHtml, type CanonicalTable } from "../schemas/table.js";
import { now, type Adapter, type AdapterResult, type DocType } from "./types.js";

const BASE = (process.env.KYNTH_BASE_URL ?? "https://api.kynth.studio").replace(/\/$/, "");

const ENDPOINT: Record<DocType, string> = {
  invoice: "invoice",
  receipt: "receipt",
  statement: "statement",
  tables: "tables",
};

// Published per-call rates (success-only billing, no minimums) — July 2026.
const PRICE: Record<DocType, number> = {
  invoice: 0.08,
  receipt: 0.06,
  statement: 0.12,
  tables: 0.08,
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}

export const kynth: Adapter = {
  name: "kynth",

  available() {
    return process.env.KYNTH_API_KEY ? null : "KYNTH_API_KEY not set";
  },

  unitPriceUsd(docType) {
    return PRICE[docType];
  },

  async run(doc, mimeType, docType): Promise<AdapterResult> {
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.KYNTH_API_KEY}`,
    };
    // Dense multi-page statements and dense tables can exceed the
    // synchronous 60s window — use the async job flow (billed identically).
    const useAsync = docType === "statement" || docType === "tables";
    // The API accepts request bodies up to ~4.5 MB. A handful of CORD photos
    // exceed that as base64 JSON, so oversized images are re-encoded as
    // JPEG q90 for transport ONLY for this vendor (documented in
    // docs/methodology.md — pixel content identical, lossless layouts).
    if (doc.length > 3_000_000 && mimeType.startsWith("image/")) {
      const sharp = (await import("sharp")).default;
      doc = await sharp(doc).jpeg({ quality: 90 }).toBuffer();
      mimeType = "image/jpeg";
    }
    const t0 = now();
    const res = await fetch(`${BASE}/v1/${ENDPOINT[docType]}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        file: { data: doc.toString("base64"), mimeType },
        ...(useAsync ? { async: true } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`kynth /v1/${ENDPOINT[docType]} HTTP ${res.status}: non-JSON response ${text.slice(0, 200)}`);
    }
    if (!res.ok && res.status !== 202)
      throw new Error(`kynth /v1/${ENDPOINT[docType]} HTTP ${res.status}: ${JSON.stringify(raw).slice(0, 300)}`);
    if (useAsync && raw.jobId) {
      const deadline = Date.now() + 300_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        const jr = await fetch(`${BASE}/v1/jobs/${raw.jobId}`, { headers, signal: AbortSignal.timeout(30_000) });
        const job = (await jr.json()) as Record<string, unknown>;
        if (job.status === "succeeded") {
          raw = (job.result ?? {}) as Record<string, unknown>;
          break;
        }
        if (job.status === "failed") throw new Error(`kynth job failed: ${JSON.stringify(job.error).slice(0, 300)}`);
        if (Date.now() > deadline) throw new Error("kynth job timed out after 300s");
      }
    }
    const latencyMs = Math.round(now() - t0);
    return { canonical: this.fromRaw(raw, docType), latencyMs, raw };
  },

  fromRaw(raw, docType) {
    // The API returns extraction fields at the top level of the response
    // body (usage/model metadata alongside); tolerate a data-wrapped shape.
    const top = rec(raw);
    const data = top.data && typeof top.data === "object" ? rec(top.data) : top;
    if (docType === "invoice") {
      const vendor = rec(data.vendor);
      const canonical: CanonicalInvoice = {
        vendorName: str(vendor.name),
        customerName: str(data.customer),
        invoiceNumber: str(data.invoiceNumber),
        issueDate: str(data.issueDate),
        dueDate: str(data.dueDate),
        currency: str(data.currency),
        subtotal: num(data.subtotal),
        tax: num(data.tax),
        total: num(data.total),
        lineItems: arr(data.lineItems).map((li) => ({
          description: str(li.description),
          quantity: num(li.quantity),
          unitPrice: num(li.unitPrice),
          amount: num(li.amount),
        })),
      };
      return canonical;
    }
    if (docType === "receipt") {
      const canonical: CanonicalReceipt = {
        merchant: str(data.merchant),
        address: str(data.location),
        date: str(data.date),
        subtotal: num(data.subtotal),
        tax: num(data.tax),
        serviceCharge: null,
        total: num(data.total),
        items: arr(data.items).map((it) => ({
          description: str(it.description),
          quantity: num(it.quantity),
          unitPrice: num(it.unitPrice),
          amount: num(it.amount),
        })),
      };
      return canonical;
    }
    if (docType === "statement") {
      const canonical: CanonicalStatement = {
        institution: str(data.institution),
        accountHolder: str(data.accountHolder),
        periodStart: str(data.periodStart),
        periodEnd: str(data.periodEnd),
        currency: str(data.currency),
        openingBalance: num(data.openingBalance),
        closingBalance: num(data.closingBalance),
        transactions: arr(data.transactions).map((tx) => {
          const amount = num(tx.amount);
          const debit = str(tx.direction)?.toLowerCase() === "debit";
          return {
            date: str(tx.date),
            description: str(tx.description),
            amount: amount === null ? null : debit ? -Math.abs(amount) : Math.abs(amount),
            balance: num(tx.balance),
          };
        }),
      };
      return canonical;
    }
    // tables
    const tables = arr(data.tables);
    const first = tables[0];
    const canonical: CanonicalTable = {
      html: first
        ? gridToHtml(
            (Array.isArray(first.headers) ? first.headers : []).map(String),
            (Array.isArray(first.rows) ? first.rows : []).map((r) => (Array.isArray(r) ? r.map(String) : [])),
          )
        : null,
      tableCount: tables.length,
    };
    return canonical;
  },
};
