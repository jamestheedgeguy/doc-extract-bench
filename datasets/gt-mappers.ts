/** Deterministic mappers from each dataset's native annotation format to the
 *  canonical schemas. These rules were fixed BEFORE any vendor API call and
 *  are documented in docs/methodology.md. No doc is ever excluded or remapped
 *  after seeing vendor results. */

import type { CanonicalInvoice } from "../src/schemas/invoice.js";

// ---------------------------------------------------------------- helpers

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Parse the date formats that appear in FATURA/SROIE ground truth into ISO
 *  YYYY-MM-DD. Returns null when unparseable (field then drops out of GT). */
export function parseGtDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/); // already ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/,. ]+(\d{4})/); // 14-Apr-2022 / 22 MAR 2018
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/([A-Za-z]{3,9})[-/,. ]+(\d{1,2})[-/,. ]+(\d{4})/); // Apr 14, 2022
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[2].padStart(2, "0")}`;
  }
  m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/); // dd/mm/yyyy (both datasets are day-first)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})(?!\d)/); // dd/mm/yy
  if (m) return `20${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/** Last plain number in a label text, ignoring parenthesised percentages —
 *  e.g. "TAX VAT (4.83%) 17.79 EUR" → 17.79; "TOTAL: $385.83" → 385.83. */
export function lastAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.replace(/\([^)]*%[^)]*\)/g, "");
  // comma-grouped thousands first, else a plain number (so "1942.43" is one
  // match, not "194" + "2.43")
  const matches = s.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g);
  if (!matches || !matches.length) return null;
  const n = Number(matches[matches.length - 1].replace(/[ ,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const CURRENCY_CODES = /\b(USD|EUR|GBP|INR|CAD|AUD|JPY|CNY|CHF|SGD|MYR|IDR|HKD|NZD)\b/i;
const CURRENCY_SYMBOLS: [RegExp, string][] = [
  [/€/, "EUR"],
  [/£/, "GBP"],
  [/₹/, "INR"],
  [/¥/, "JPY"],
  [/\$/, "USD"],
];

export function findCurrency(texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const m = t.match(CURRENCY_CODES);
    if (m) return m[1].toUpperCase();
  }
  for (const t of texts) {
    if (!t) continue;
    for (const [re, code] of CURRENCY_SYMBOLS) if (re.test(t)) return code;
  }
  return null;
}

// ---------------------------------------------------------------- FATURA

interface FaturaField {
  text?: string;
  bbox?: unknown;
}
type FaturaAnnotation = Record<string, FaturaField | FaturaField[] | FaturaField[][]>;

function ftext(a: FaturaAnnotation, key: string): string | null {
  const v = a[key];
  if (!v || Array.isArray(v)) return null;
  const t = (v as FaturaField).text;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

function stripLabel(raw: string | null, labels: RegExp): string | null {
  if (!raw) return null;
  const s = raw.replace(labels, "").trim().replace(/^[:#\s]+/, "").trim();
  return s || null;
}

/** FATURA Original_Format annotation → canonical invoice GT.
 *  FATURA has no line-item text ground truth (TABLE is bbox-only), so
 *  invoices are scored on header fields only. */
export function faturaToInvoiceGt(annRaw: string): CanonicalInvoice {
  const a = JSON.parse(annRaw) as FaturaAnnotation;

  const buyerRaw = ftext(a, "BUYER");
  const buyerFirst = buyerRaw
    ? stripLabel(buyerRaw.split("\n")[0], /^\s*(bill(ed)?\s*to|buyer|client|customer)\s*[:\-]?/i)
    : null;

  const sellerName = stripLabel(ftext(a, "SELLER_NAME"), /^\s*(seller|from|name|company)\s*[:\-]?/i);

  const numberRaw = ftext(a, "NUMBER");
  const invoiceNumber = numberRaw
    ? stripLabel(numberRaw, /^\s*(tax\s+)?invoice\s*(#|id|no\.?|num(ber)?)?\s*[:#\-]?/i)
    : null;

  const dateRaw = ftext(a, "DATE");
  const dueRaw = ftext(a, "DUE_DATE");
  const subRaw = ftext(a, "SUB_TOTAL");
  const taxRaw = ftext(a, "TAX");
  const totalRaw = ftext(a, "TOTAL");

  return {
    vendorName: sellerName,
    customerName: buyerFirst,
    invoiceNumber,
    issueDate: parseGtDate(dateRaw?.replace(/^[^:]*:/, "") ?? dateRaw),
    dueDate: parseGtDate(dueRaw?.replace(/^[^:]*:/, "") ?? dueRaw),
    currency: findCurrency([totalRaw, subRaw, taxRaw]),
    subtotal: lastAmount(subRaw),
    tax: lastAmount(taxRaw),
    total: lastAmount(totalRaw),
    lineItems: [],
  };
}

// ---------------------------------------------------------------- CORD-v2

interface CordMenuItem {
  nm?: string | string[];
  cnt?: string | string[];
  price?: string | string[];
  unitprice?: string | string[];
  [k: string]: unknown;
}
interface CordGtParse {
  menu?: CordMenuItem | CordMenuItem[];
  sub_total?: Record<string, string | string[]>;
  total?: Record<string, string | string[]>;
}

function cordStr(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  const s = Array.isArray(v) ? v.join(" ") : v;
  return s.trim() || null;
}

/** CORD prices are Indonesian-formatted ("25,000" = 25000; "12.000" = 12000). */
export function cordAmount(v: string | string[] | undefined): number | null {
  const s = cordStr(v);
  if (!s) return null;
  let t = s.replace(/[^\d,.\-]/g, "");
  // In IDR receipts both "," and "." are thousands separators; a trailing
  // 1-2 digit group after the last separator would be decimals, which IDR
  // does not use — CORD GT totals are integers with 3-digit groups.
  t = t.replace(/[.,](?=\d{3}(\D|$))/g, "");
  t = t.replace(/,/g, ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function cordQty(v: string | string[] | undefined): number | null {
  const s = cordStr(v);
  if (!s) return null;
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export interface CordGt {
  items: { description: string | null; quantity: number | null; unitPrice: number | null; amount: number | null }[];
  subtotal: number | null;
  tax: number | null;
  serviceCharge: number | null;
  total: number | null;
}

export function cordToReceiptGt(groundTruth: string): CordGt {
  const gt = JSON.parse(groundTruth) as { gt_parse: CordGtParse };
  const p = gt.gt_parse ?? {};
  const menu = p.menu === undefined ? [] : Array.isArray(p.menu) ? p.menu : [p.menu];
  const items = menu.map((m) => ({
    description: cordStr(m.nm),
    quantity: cordQty(m.cnt),
    unitPrice: cordAmount(m.unitprice),
    amount: cordAmount(m.price),
  }));
  const sub = p.sub_total ?? {};
  const tot = p.total ?? {};
  return {
    items,
    subtotal: cordAmount(sub.subtotal_price),
    tax: cordAmount(sub.tax_price),
    serviceCharge: cordAmount(sub.service_price),
    total: cordAmount(tot.total_price),
  };
}

// ------------------------------------------------------------- FinTabNet

/** Rebuild ground-truth HTML from FinTabNet_OTSL's structure tokens + cell
 *  content tokens (the PubTabNet convention: cell text slots into each
 *  <td>…</td> in document order). */
export function fintabnetToHtml(structureTokens: string[], cells: { tokens: string[] }[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out: string[] = ["<table>"];
  let cellIdx = 0;
  for (let i = 0; i < structureTokens.length; i++) {
    const tok = structureTokens[i];
    out.push(tok);
    if (tok === "</td>") continue;
    if (tok === "<td>" || tok === ">") {
      // "<td>" opens+closes immediately in the token stream ("<td>","</td>");
      // spanned cells appear as "<td", ' colspan="2"', ">", "</td>".
      // Cell content tokens are per-character in FinTabNet_OTSL.
      const content = cells[cellIdx]?.tokens?.join("") ?? "";
      out.push(esc(content));
      cellIdx++;
    }
  }
  out.push("</table>");
  return out.join("");
}
