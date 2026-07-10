/** Common adapter contract. Every vendor adapter maps one document into the
 *  canonical schema for its doc type and returns the verbatim raw response
 *  (committed under results/raw/ so anyone can re-score with zero keys).
 *
 *  Missing credentials NEVER fail a run — the vendor is reported as SKIPPED
 *  with the reason. A vendor with no product for a doc type is reported as
 *  "no product" (e.g. Textract has no bank-statement parser). */

export type DocType = "invoice" | "receipt" | "statement" | "tables";

export interface AdapterResult {
  /** Canonical normalized output (schema depends on docType). */
  canonical: unknown;
  latencyMs: number;
  /** Verbatim vendor response — committed to results/raw/. */
  raw: unknown;
}

export interface Adapter {
  name: string;
  /** null → ready to run this doc type; otherwise the skip reason. */
  available(docType: DocType): string | null;
  /** USD price for one document of this type (pages = page count for
   *  per-page-priced vendors). Used by the pre-run cost gate. */
  unitPriceUsd(docType: DocType, pages: number): number;
  run(doc: Buffer, mimeType: string, docType: DocType): Promise<AdapterResult>;
  /** Map a previously cached raw response back to canonical form (replay). */
  fromRaw(raw: unknown, docType: DocType): unknown;
}

export function now(): number {
  return performance.now();
}
