/** AWS Textract — AnalyzeExpense for invoices + receipts, AnalyzeDocument
 *  (TABLES) for tables. Textract has NO bank-statement product → reported
 *  honestly as "no product" for statements.
 *  Env/credentials: standard AWS credential chain (AWS_PROFILE, env keys,
 *  ~/.aws). Region: AWS_REGION (default us-east-1). */

import { normalizeAmount } from "../score/normalize.js";
import {
  AnalyzeDocumentCommand,
  AnalyzeExpenseCommand,
  TextractClient,
  type Block,
  type ExpenseDocument,
  type ExpenseField,
} from "@aws-sdk/client-textract";
import type { CanonicalInvoice } from "../schemas/invoice.js";
import type { CanonicalReceipt } from "../schemas/receipt.js";
import type { CanonicalTable } from "../schemas/table.js";
import { now, type Adapter, type AdapterResult, type DocType } from "./types.js";

let client: TextractClient | null = null;
function getClient(): TextractClient {
  if (!client) client = new TextractClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  return client;
}

// Verified July 2026, us-east-1: AnalyzeExpense $0.01/page (first 1M),
// AnalyzeDocument TABLES $0.015/page.
const PRICE_PER_PAGE: Record<DocType, number> = {
  invoice: 0.01,
  receipt: 0.01,
  statement: 0,
  tables: 0.015,
};

function summary(doc: ExpenseDocument | undefined, type: string): string | null {
  const f = doc?.SummaryFields?.find((s) => s.Type?.Text === type);
  const v = f?.ValueDetection?.Text?.trim();
  return v || null;
}

function amount(v: string | null): number | null {
  return normalizeAmount(v);
}

function currencyOf(doc: ExpenseDocument | undefined): string | null {
  for (const f of doc?.SummaryFields ?? []) {
    const c = (f as ExpenseField & { Currency?: { Code?: string } }).Currency?.Code;
    if (c) return c;
  }
  return null;
}

function lineItems(doc: ExpenseDocument | undefined) {
  const items: { description: string | null; quantity: number | null; unitPrice: number | null; amount: number | null }[] = [];
  for (const group of doc?.LineItemGroups ?? []) {
    for (const li of group.LineItems ?? []) {
      const get = (t: string) =>
        li.LineItemExpenseFields?.find((f) => f.Type?.Text === t)?.ValueDetection?.Text?.trim() ?? null;
      items.push({
        description: get("ITEM"),
        quantity: amount(get("QUANTITY")),
        unitPrice: amount(get("UNIT_PRICE")),
        amount: amount(get("PRICE")),
      });
    }
  }
  return items;
}

/** Reconstruct the first table on the page from TABLE/CELL blocks. */
function tableHtml(blocks: Block[]): { html: string | null; tableCount: number } {
  const byId = new Map(blocks.map((b) => [b.Id!, b]));
  const tables = blocks.filter((b) => b.BlockType === "TABLE");
  if (!tables.length) return { html: null, tableCount: 0 };
  const t = tables[0];
  const cellIds =
    t.Relationships?.filter((r) => r.Type === "CHILD").flatMap((r) => r.Ids ?? []) ?? [];
  const cells = cellIds.map((id) => byId.get(id)).filter((b): b is Block => b?.BlockType === "CELL");
  const text = (cell: Block) =>
    (cell.Relationships?.filter((r) => r.Type === "CHILD").flatMap((r) => r.Ids ?? []) ?? [])
      .map((id) => byId.get(id))
      .filter((b): b is Block => !!b && (b.BlockType === "WORD" || b.BlockType === "SELECTION_ELEMENT"))
      .map((b) => (b.BlockType === "WORD" ? b.Text ?? "" : ""))
      .join(" ")
      .trim();
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const maxRow = Math.max(...cells.map((c) => c.RowIndex ?? 0));
  const rows: string[] = [];
  for (let r = 1; r <= maxRow; r++) {
    const rowCells = cells
      .filter((c) => c.RowIndex === r)
      .sort((a, b) => (a.ColumnIndex ?? 0) - (b.ColumnIndex ?? 0));
    const tds = rowCells.map((c) => {
      const attrs =
        ((c.ColumnSpan ?? 1) > 1 ? ` colspan="${c.ColumnSpan}"` : "") +
        ((c.RowSpan ?? 1) > 1 ? ` rowspan="${c.RowSpan}"` : "");
      return `<td${attrs}>${esc(text(c))}</td>`;
    });
    if (tds.length) rows.push(`<tr>${tds.join("")}</tr>`);
  }
  return { html: `<table><tbody>${rows.join("")}</tbody></table>`, tableCount: tables.length };
}

export const textract: Adapter = {
  name: "textract",

  available(docType) {
    if (docType === "statement") return "no product (Textract has no bank-statement parser)";
    if (!process.env.AWS_PROFILE && !process.env.AWS_ACCESS_KEY_ID)
      return "no AWS credentials (set AWS_PROFILE or AWS_ACCESS_KEY_ID)";
    return null;
  },

  unitPriceUsd(docType, pages) {
    return PRICE_PER_PAGE[docType] * Math.max(1, pages);
  },

  async run(doc, _mimeType, docType): Promise<AdapterResult> {
    const t0 = now();
    if (docType === "tables") {
      const res = await getClient().send(
        new AnalyzeDocumentCommand({ Document: { Bytes: doc }, FeatureTypes: ["TABLES"] }),
      );
      const latencyMs = Math.round(now() - t0);
      const raw = JSON.parse(JSON.stringify(res));
      return { canonical: this.fromRaw(raw, docType), latencyMs, raw };
    }
    const res = await getClient().send(new AnalyzeExpenseCommand({ Document: { Bytes: doc } }));
    const latencyMs = Math.round(now() - t0);
    const raw = JSON.parse(JSON.stringify(res));
    return { canonical: this.fromRaw(raw, docType), latencyMs, raw };
  },

  fromRaw(raw, docType) {
    if (docType === "tables") {
      const blocks = ((raw as { Blocks?: Block[] }).Blocks ?? []) as Block[];
      const { html, tableCount } = tableHtml(blocks);
      const canonical: CanonicalTable = { html, tableCount };
      return canonical;
    }
    const doc = (raw as { ExpenseDocuments?: ExpenseDocument[] }).ExpenseDocuments?.[0];
    if (docType === "invoice") {
      const canonical: CanonicalInvoice = {
        vendorName: summary(doc, "VENDOR_NAME") ?? summary(doc, "NAME"),
        customerName: summary(doc, "RECEIVER_NAME"),
        invoiceNumber: summary(doc, "INVOICE_RECEIPT_ID"),
        issueDate: summary(doc, "INVOICE_RECEIPT_DATE"),
        dueDate: summary(doc, "DUE_DATE"),
        currency: currencyOf(doc),
        subtotal: amount(summary(doc, "SUBTOTAL")),
        tax: amount(summary(doc, "TAX")),
        total: amount(summary(doc, "TOTAL")),
        lineItems: lineItems(doc),
      };
      return canonical;
    }
    const canonical: CanonicalReceipt = {
      merchant: summary(doc, "VENDOR_NAME") ?? summary(doc, "NAME"),
      address: summary(doc, "ADDRESS") ?? summary(doc, "VENDOR_ADDRESS"),
      date: summary(doc, "INVOICE_RECEIPT_DATE"),
      subtotal: amount(summary(doc, "SUBTOTAL")),
      tax: amount(summary(doc, "TAX")),
      serviceCharge: amount(summary(doc, "SERVICE_CHARGE")),
      total: amount(summary(doc, "TOTAL")),
      items: lineItems(doc),
    };
    return canonical;
  },
};
