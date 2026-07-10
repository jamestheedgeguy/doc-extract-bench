/** LlamaCloud — LlamaExtract (schema-driven fields for invoices/receipts/
 *  statements) and LlamaParse (tables).
 *  Env: LLAMA_CLOUD_API_KEY. Skipped (never failed) when absent.
 *
 *  LlamaExtract flow: one extraction agent per doc type is created lazily
 *  (idempotent by name), then files are uploaded and extraction jobs polled. */

import type { CanonicalInvoice } from "../schemas/invoice.js";
import type { CanonicalReceipt } from "../schemas/receipt.js";
import type { CanonicalStatement } from "../schemas/statement.js";
import { gridToHtml, type CanonicalTable } from "../schemas/table.js";
import { now, type Adapter, type AdapterResult, type DocType } from "./types.js";

const BASE = "https://api.cloud.llamaindex.ai/api/v1";

// Verified July 2026: LlamaParse $1.25 per 1,000 pages (Pro plans include
// credits); LlamaExtract priced in credits — see docs/methodology.md.
const PRICE: Record<DocType, number> = {
  invoice: 0.01,
  receipt: 0.01,
  statement: 0.01,
  tables: 0.00125,
};

const FIELD_SCHEMAS: Record<Exclude<DocType, "tables">, object> = {
  invoice: {
    type: "object",
    properties: {
      vendorName: { type: ["string", "null"] },
      customerName: { type: ["string", "null"] },
      invoiceNumber: { type: ["string", "null"] },
      issueDate: { type: ["string", "null"], description: "ISO YYYY-MM-DD" },
      dueDate: { type: ["string", "null"], description: "ISO YYYY-MM-DD" },
      currency: { type: ["string", "null"], description: "ISO 4217 code" },
      subtotal: { type: ["number", "null"] },
      tax: { type: ["number", "null"] },
      total: { type: ["number", "null"] },
      lineItems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: ["string", "null"] },
            quantity: { type: ["number", "null"] },
            unitPrice: { type: ["number", "null"] },
            amount: { type: ["number", "null"] },
          },
        },
      },
    },
  },
  receipt: {
    type: "object",
    properties: {
      merchant: { type: ["string", "null"] },
      address: { type: ["string", "null"] },
      date: { type: ["string", "null"], description: "ISO YYYY-MM-DD" },
      subtotal: { type: ["number", "null"] },
      tax: { type: ["number", "null"] },
      serviceCharge: { type: ["number", "null"] },
      total: { type: ["number", "null"] },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: ["string", "null"] },
            quantity: { type: ["number", "null"] },
            unitPrice: { type: ["number", "null"] },
            amount: { type: ["number", "null"] },
          },
        },
      },
    },
  },
  statement: {
    type: "object",
    properties: {
      institution: { type: ["string", "null"] },
      accountHolder: { type: ["string", "null"] },
      periodStart: { type: ["string", "null"] },
      periodEnd: { type: ["string", "null"] },
      currency: { type: ["string", "null"] },
      openingBalance: { type: ["number", "null"] },
      closingBalance: { type: ["number", "null"] },
      transactions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            amount: { type: ["number", "null"], description: "negative = money out" },
            balance: { type: ["number", "null"] },
          },
        },
      },
    },
  },
};

function headers(): Record<string, string> {
  return { authorization: `Bearer ${process.env.LLAMA_CLOUD_API_KEY}` };
}

async function jsonFetch(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`llamacloud ${url} HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const agentCache = new Map<string, string>();

async function extractAgent(docType: Exclude<DocType, "tables">): Promise<string> {
  const name = `doc-extract-bench-${docType}`;
  if (agentCache.has(name)) return agentCache.get(name)!;
  const listed = await jsonFetch(`${BASE}/extraction/extraction-agents/by-name/${name}`, {
    headers: headers(),
  }).catch(() => null);
  let id = listed?.id as string | undefined;
  if (!id) {
    const created = await jsonFetch(`${BASE}/extraction/extraction-agents`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({
        name,
        data_schema: FIELD_SCHEMAS[docType],
        config: { extraction_mode: "BALANCED" },
      }),
    });
    id = created.id as string;
  }
  agentCache.set(name, id!);
  return id!;
}

async function uploadFile(doc: Buffer, mimeType: string): Promise<string> {
  const form = new FormData();
  const ext = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
  form.append("upload_file", new Blob([new Uint8Array(doc)], { type: mimeType }), `doc.${ext}`);
  const res = await jsonFetch(`${BASE}/files`, { method: "POST", headers: headers(), body: form });
  return res.id as string;
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs = 180_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const r = await fn();
    if (r !== null) return r;
    if (Date.now() - start > timeoutMs) throw new Error("llamacloud job timed out");
    await new Promise((r2) => setTimeout(r2, 2000));
  }
}

export const llamaparse: Adapter = {
  name: "llamaparse",

  available() {
    return process.env.LLAMA_CLOUD_API_KEY ? null : "LLAMA_CLOUD_API_KEY not set";
  },

  unitPriceUsd(docType, pages) {
    return docType === "tables" ? PRICE.tables * Math.max(1, pages) : PRICE[docType];
  },

  async run(doc, mimeType, docType): Promise<AdapterResult> {
    const t0 = now();
    if (docType === "tables") {
      // LlamaParse job → JSON result → first table on the first page.
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(doc)], { type: mimeType }), "table.png");
      const job = await jsonFetch(`${BASE}/parsing/upload`, {
        method: "POST",
        headers: headers(),
        body: form,
      });
      const jobId = job.id as string;
      await poll(async () => {
        const s = await jsonFetch(`${BASE}/parsing/job/${jobId}`, { headers: headers() });
        if (s.status === "SUCCESS") return true;
        if (s.status === "ERROR") throw new Error(`llamaparse job failed: ${JSON.stringify(s).slice(0, 200)}`);
        return null;
      });
      const raw = await jsonFetch(`${BASE}/parsing/job/${jobId}/result/json`, { headers: headers() });
      const latencyMs = Math.round(now() - t0);
      return { canonical: this.fromRaw(raw, docType), latencyMs, raw };
    }
    const agentId = await extractAgent(docType);
    const fileId = await uploadFile(doc, mimeType);
    const job = await jsonFetch(`${BASE}/extraction/jobs`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ extraction_agent_id: agentId, file_id: fileId }),
    });
    const jobId = job.id as string;
    await poll(async () => {
      const s = await jsonFetch(`${BASE}/extraction/jobs/${jobId}`, { headers: headers() });
      if (s.status === "SUCCESS") return true;
      if (s.status === "ERROR" || s.status === "FAILED")
        throw new Error(`llamaextract job failed: ${JSON.stringify(s).slice(0, 200)}`);
      return null;
    });
    const raw = await jsonFetch(`${BASE}/extraction/jobs/${jobId}/result`, { headers: headers() });
    const latencyMs = Math.round(now() - t0);
    return { canonical: this.fromRaw(raw, docType), latencyMs, raw };
  },

  fromRaw(raw, docType) {
    if (docType === "tables") {
      // LlamaParse JSON: pages[].items[] with type "table" carrying rows.
      const pages = (raw as { pages?: { items?: { type?: string; rows?: string[][] }[] }[] }).pages ?? [];
      const tables = pages.flatMap((p) => (p.items ?? []).filter((i) => i.type === "table"));
      const first = tables[0];
      const rows = (first?.rows ?? []).map((r) => (Array.isArray(r) ? r.map(String) : []));
      const canonical: CanonicalTable = {
        html: rows.length ? gridToHtml([], rows) : null,
        tableCount: tables.length,
      };
      return canonical;
    }
    const data = ((raw as { data?: unknown }).data ?? raw) as Record<string, unknown>;
    if (docType === "invoice") return data as unknown as CanonicalInvoice;
    if (docType === "receipt") return data as unknown as CanonicalReceipt;
    return data as unknown as CanonicalStatement;
  },
};
