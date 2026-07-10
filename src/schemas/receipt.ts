/** Canonical normalized receipt shape. Two receipt datasets score different
 *  slices of it: SROIE scores header fields {merchant, date, address, total};
 *  CORD-v2 scores line items + totals (merchant/date are blurred in CORD). */

export interface ReceiptItem {
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
}

export interface CanonicalReceipt {
  merchant: string | null;
  address: string | null;
  date: string | null; // ISO YYYY-MM-DD
  subtotal: number | null;
  tax: number | null;
  serviceCharge: number | null;
  total: number | null;
  items: ReceiptItem[];
}

/** SROIE header fields. */
export const SROIE_FIELDS = ["merchant", "date", "address", "total"] as const;
export type SroieField = (typeof SROIE_FIELDS)[number];
export const SROIE_FIELD_TYPES: Record<SroieField, "string" | "number" | "date"> = {
  merchant: "string",
  date: "date",
  address: "string",
  total: "number",
};

/** CORD total-block fields (merchant/date blurred in CORD-v2 — never scored). */
export const CORD_TOTAL_FIELDS = ["subtotal", "tax", "serviceCharge", "total"] as const;
export type CordTotalField = (typeof CORD_TOTAL_FIELDS)[number];
export const CORD_TOTAL_FIELD_TYPES: Record<CordTotalField, "string" | "number" | "date"> = {
  subtotal: "number",
  tax: "number",
  serviceCharge: "number",
  total: "number",
};
