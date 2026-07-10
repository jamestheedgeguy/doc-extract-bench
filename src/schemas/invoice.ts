/** Canonical normalized invoice shape every adapter maps into.
 *  All fields nullable: `null` = "the vendor did not extract this field".
 *  Ground truth uses the same shape; GT `null` = "not annotated / not present". */

export interface InvoiceLineItem {
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
}

export interface CanonicalInvoice {
  vendorName: string | null;
  customerName: string | null;
  invoiceNumber: string | null;
  issueDate: string | null; // ISO YYYY-MM-DD
  dueDate: string | null; // ISO YYYY-MM-DD
  currency: string | null; // ISO 4217
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  lineItems: InvoiceLineItem[];
}

/** Header fields scored for invoices (line items scored separately). */
export const INVOICE_FIELDS = [
  "vendorName",
  "customerName",
  "invoiceNumber",
  "issueDate",
  "dueDate",
  "currency",
  "subtotal",
  "tax",
  "total",
] as const;

export type InvoiceField = (typeof INVOICE_FIELDS)[number];

export const INVOICE_FIELD_TYPES: Record<InvoiceField, "string" | "number" | "date"> = {
  vendorName: "string",
  customerName: "string",
  invoiceNumber: "string",
  issueDate: "date",
  dueDate: "date",
  currency: "string",
  subtotal: "number",
  tax: "number",
  total: "number",
};
