/** Veryfi — receipts + invoices via POST /api/v8/partner/documents.
 *  Env: VERYFI_CLIENT_ID, VERYFI_API_KEY, VERYFI_USERNAME.
 *  Skipped (never failed) when credentials are absent.
 *
 *  Note: Veryfi's free tier is 100 docs/month — when only the free tier is
 *  available a cycle can cover receipts only (partial coverage is labeled in
 *  the results). */

import type { CanonicalInvoice } from "../schemas/invoice.js";
import type { CanonicalReceipt } from "../schemas/receipt.js";
import { now, type Adapter, type AdapterResult, type DocType } from "./types.js";

// Verified July 2026 (veryfi.com/pricing): $0.08/receipt, $0.16/invoice,
// $0.25/bank-statement — with a $500/month platform minimum.
const PRICE: Record<DocType, number> = {
  invoice: 0.16,
  receipt: 0.08,
  statement: 0.25,
  tables: 0,
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export const veryfi: Adapter = {
  name: "veryfi",

  available(docType) {
    if (docType === "tables") return "no product (Veryfi has no generic table-extraction API)";
    if (!process.env.VERYFI_CLIENT_ID || !process.env.VERYFI_API_KEY || !process.env.VERYFI_USERNAME)
      return "no Veryfi credentials (set VERYFI_CLIENT_ID, VERYFI_API_KEY, VERYFI_USERNAME)";
    return null;
  },

  unitPriceUsd(docType) {
    return PRICE[docType];
  },

  async run(doc, mimeType, docType): Promise<AdapterResult> {
    const ext = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
    const t0 = now();
    const res = await fetch("https://api.veryfi.com/api/v8/partner/documents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "client-id": process.env.VERYFI_CLIENT_ID!,
        authorization: `apikey ${process.env.VERYFI_USERNAME}:${process.env.VERYFI_API_KEY}`,
      },
      body: JSON.stringify({ file_name: `doc.${ext}`, file_data: doc.toString("base64") }),
    });
    const raw = (await res.json()) as Record<string, unknown>;
    const latencyMs = Math.round(now() - t0);
    if (!res.ok) throw new Error(`veryfi HTTP ${res.status}: ${JSON.stringify(raw).slice(0, 300)}`);
    return { canonical: this.fromRaw(raw, docType), latencyMs, raw };
  },

  fromRaw(raw, docType) {
    const d = rec(raw);
    const vendor = rec(d.vendor);
    const items = (Array.isArray(d.line_items) ? d.line_items : []).map((liRaw) => {
      const li = rec(liRaw);
      return {
        description: str(li.description),
        quantity: num(li.quantity),
        unitPrice: num(li.price),
        amount: num(li.total),
      };
    });
    if (docType === "invoice") {
      const canonical: CanonicalInvoice = {
        vendorName: str(vendor.name),
        customerName: str(d.bill_to_name) ?? str(rec(d.bill_to).name),
        invoiceNumber: str(d.invoice_number),
        issueDate: str(d.date)?.slice(0, 10) ?? null,
        dueDate: str(d.due_date)?.slice(0, 10) ?? null,
        currency: str(d.currency_code),
        subtotal: num(d.subtotal),
        tax: num(d.tax),
        total: num(d.total),
        lineItems: items,
      };
      return canonical;
    }
    const canonical: CanonicalReceipt = {
      merchant: str(vendor.name),
      address: str(vendor.address),
      date: str(d.date)?.slice(0, 10) ?? null,
      subtotal: num(d.subtotal),
      tax: num(d.tax),
      serviceCharge: null,
      total: num(d.total),
      items,
    };
    return canonical;
  },
};
