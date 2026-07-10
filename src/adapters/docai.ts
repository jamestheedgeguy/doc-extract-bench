/** Google Document AI — Invoice parser (invoices), Expense parser (receipts),
 *  Lending Bank Statement parser (statements), Form parser (tables).
 *
 *  Env:
 *    DOCAI_PROCESSOR_INVOICE / DOCAI_PROCESSOR_EXPENSE /
 *    DOCAI_PROCESSOR_BANK_STATEMENT / DOCAI_PROCESSOR_FORM
 *      — full processor resource names
 *        ("projects/<p>/locations/<loc>/processors/<id>")
 *    GOOGLE_ACCESS_TOKEN — OAuth token; if unset the adapter shells out to
 *      `gcloud auth print-access-token` once per run. */

import { execFileSync } from "node:child_process";
import { normalizeAmount } from "../score/normalize.js";
import type { CanonicalInvoice } from "../schemas/invoice.js";
import type { CanonicalReceipt } from "../schemas/receipt.js";
import type { CanonicalStatement, StatementTransaction } from "../schemas/statement.js";
import type { CanonicalTable } from "../schemas/table.js";
import { now, type Adapter, type AdapterResult, type DocType } from "./types.js";

const PROCESSOR_ENV: Record<DocType, string> = {
  invoice: "DOCAI_PROCESSOR_INVOICE",
  receipt: "DOCAI_PROCESSOR_EXPENSE",
  statement: "DOCAI_PROCESSOR_BANK_STATEMENT",
  tables: "DOCAI_PROCESSOR_FORM",
};

// Verified July 2026: Invoice + Expense parsers $0.01/page (first 1M/mo);
// Bank Statement parser (Lending) $0.75/document (1-10 pages);
// Form parser $0.03/page? No — Form Parser is $0.015/page above OCR? See
// docs/methodology.md for the cited pricing table.
const PRICE: Record<DocType, (pages: number) => number> = {
  invoice: (p) => 0.01 * Math.max(1, p),
  receipt: (p) => 0.01 * Math.max(1, p),
  statement: () => 0.75,
  tables: (p) => 0.03 * Math.max(1, p),
};

let cachedToken: string | null = null;
function accessToken(): string {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  if (!cachedToken)
    cachedToken = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
  return cachedToken;
}

interface DocaiEntity {
  type?: string;
  mentionText?: string;
  normalizedValue?: {
    text?: string;
    moneyValue?: { units?: string | number; nanos?: number; currencyCode?: string };
    dateValue?: { year?: number; month?: number; day?: number };
  };
  properties?: DocaiEntity[];
}
interface DocaiDocument {
  text?: string;
  entities?: DocaiEntity[];
  pages?: {
    tables?: {
      headerRows?: { cells?: { layout?: DocaiLayout }[] }[];
      bodyRows?: { cells?: { layout?: DocaiLayout }[] }[];
    }[];
  }[];
}
interface DocaiLayout {
  textAnchor?: { textSegments?: { startIndex?: string | number; endIndex?: string | number }[] };
}

function entityText(e: DocaiEntity | undefined): string | null {
  if (!e) return null;
  const nv = e.normalizedValue;
  if (nv?.dateValue?.year) {
    const d = nv.dateValue;
    return `${d.year}-${String(d.month ?? 1).padStart(2, "0")}-${String(d.day ?? 1).padStart(2, "0")}`;
  }
  const t = (nv?.text ?? e.mentionText ?? "").trim();
  return t || null;
}

function entityAmount(e: DocaiEntity | undefined): number | null {
  if (!e) return null;
  const mv = e.normalizedValue?.moneyValue;
  if (mv && (mv.units !== undefined || mv.nanos !== undefined)) {
    return Number(mv.units ?? 0) + (mv.nanos ?? 0) / 1e9;
  }
  return normalizeAmount(entityText(e));
}

function find(entities: DocaiEntity[] | undefined, ...types: string[]): DocaiEntity | undefined {
  return entities?.find((e) => types.includes(e.type ?? ""));
}

function findAll(entities: DocaiEntity[] | undefined, type: string): DocaiEntity[] {
  return entities?.filter((e) => e.type === type) ?? [];
}

function prop(e: DocaiEntity, suffix: string): DocaiEntity | undefined {
  return e.properties?.find((p) => (p.type ?? "").endsWith(suffix));
}

function layoutText(doc: DocaiDocument, layout: DocaiLayout | undefined): string {
  const segs = layout?.textAnchor?.textSegments ?? [];
  return segs
    .map((s) => (doc.text ?? "").slice(Number(s.startIndex ?? 0), Number(s.endIndex ?? 0)))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export const docai: Adapter = {
  name: "docai",

  available(docType) {
    if (!process.env[PROCESSOR_ENV[docType]])
      return `${PROCESSOR_ENV[docType]} not set (create the processor once and export its resource name)`;
    return null;
  },

  unitPriceUsd(docType, pages) {
    return PRICE[docType](pages);
  },

  async run(doc, mimeType, docType): Promise<AdapterResult> {
    const name = process.env[PROCESSOR_ENV[docType]]!;
    const location = name.split("/locations/")[1]?.split("/")[0] ?? "us";
    const t0 = now();
    const res = await fetch(`https://${location}-documentai.googleapis.com/v1/${name}:process`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken()}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        rawDocument: { content: doc.toString("base64"), mimeType },
        // keep responses committable: skip full-page image/layout payloads
        fieldMask: "text,entities,pages.tables",
      }),
    });
    const raw = (await res.json()) as Record<string, unknown>;
    const latencyMs = Math.round(now() - t0);
    if (!res.ok) throw new Error(`docai ${docType} HTTP ${res.status}: ${JSON.stringify(raw).slice(0, 300)}`);
    return { canonical: this.fromRaw(raw, docType), latencyMs, raw };
  },

  fromRaw(raw, docType) {
    const doc = ((raw as { document?: DocaiDocument }).document ?? raw) as DocaiDocument;
    const ents = doc.entities;
    if (docType === "invoice") {
      const canonical: CanonicalInvoice = {
        vendorName: entityText(find(ents, "supplier_name")),
        customerName: entityText(find(ents, "receiver_name")),
        invoiceNumber: entityText(find(ents, "invoice_id")),
        issueDate: entityText(find(ents, "invoice_date")),
        dueDate: entityText(find(ents, "due_date")),
        currency:
          entityText(find(ents, "currency")) ??
          find(ents, "total_amount")?.normalizedValue?.moneyValue?.currencyCode ??
          null,
        subtotal: entityAmount(find(ents, "net_amount")),
        tax: entityAmount(find(ents, "total_tax_amount")),
        total: entityAmount(find(ents, "total_amount")),
        lineItems: findAll(ents, "line_item").map((li) => ({
          description: entityText(prop(li, "description")),
          quantity: entityAmount(prop(li, "quantity")),
          unitPrice: entityAmount(prop(li, "unit_price")),
          amount: entityAmount(prop(li, "amount")),
        })),
      };
      return canonical;
    }
    if (docType === "receipt") {
      const canonical: CanonicalReceipt = {
        merchant: entityText(find(ents, "supplier_name")),
        address: entityText(find(ents, "supplier_address")),
        date: entityText(find(ents, "receipt_date")),
        subtotal: entityAmount(find(ents, "net_amount")),
        tax: entityAmount(find(ents, "total_tax_amount")),
        serviceCharge: null,
        total: entityAmount(find(ents, "total_amount")),
        items: findAll(ents, "line_item").map((li) => ({
          description: entityText(prop(li, "description")),
          quantity: entityAmount(prop(li, "quantity")),
          unitPrice: entityAmount(prop(li, "unit_price")),
          amount: entityAmount(prop(li, "amount")),
        })),
      };
      return canonical;
    }
    if (docType === "statement") {
      const txs: StatementTransaction[] = [];
      for (const item of findAll(ents, "table_item")) {
        const deposit = entityAmount(prop(item, "transaction_deposit"));
        const withdrawal = entityAmount(prop(item, "transaction_withdrawal"));
        const date =
          entityText(prop(item, "transaction_deposit_date")) ??
          entityText(prop(item, "transaction_withdrawal_date"));
        const desc =
          entityText(prop(item, "transaction_deposit_description")) ??
          entityText(prop(item, "transaction_withdrawal_description"));
        if (deposit === null && withdrawal === null && !desc) continue;
        txs.push({
          date,
          description: desc,
          amount: deposit !== null ? Math.abs(deposit) : withdrawal !== null ? -Math.abs(withdrawal) : null,
          balance: null,
        });
      }
      const canonical: CanonicalStatement = {
        institution: entityText(find(ents, "bank_name")),
        accountHolder: entityText(find(ents, "client_name")),
        periodStart: entityText(find(ents, "statement_start_date")),
        periodEnd: entityText(find(ents, "statement_end_date")),
        currency: null,
        openingBalance: entityAmount(find(ents, "starting_balance")),
        closingBalance: entityAmount(find(ents, "ending_balance")),
        transactions: txs,
      };
      return canonical;
    }
    // tables — Form parser
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const tables = (doc.pages ?? []).flatMap((p) => p.tables ?? []);
    const t = tables[0];
    let html: string | null = null;
    if (t) {
      const tr = (row: { cells?: { layout?: DocaiLayout }[] }) =>
        `<tr>${(row.cells ?? []).map((c) => `<td>${esc(layoutText(doc, c.layout))}</td>`).join("")}</tr>`;
      const head = (t.headerRows ?? []).map(tr).join("");
      const body = (t.bodyRows ?? []).map(tr).join("");
      html = `<table>${head ? `<thead>${head}</thead>` : ""}<tbody>${body}</tbody></table>`;
    }
    const canonical: CanonicalTable = { html, tableCount: tables.length };
    return canonical;
  },
};
