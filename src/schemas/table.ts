/** Canonical table shape. Scored with TEDS (content) and S-TEDS (structure
 *  only) against ground-truth HTML, so the canonical form IS html: adapters
 *  must render their vendor's table output as a minimal <table> tree using
 *  only <table>, <thead>, <tbody>, <tr>, <td> (+ rowspan/colspan attrs).
 *  <th> is normalized to <td> before scoring. */

export interface CanonicalTable {
  /** Minimal normalized HTML for the FIRST table detected on the page. */
  html: string | null;
  /** How many tables the vendor found (diagnostic only). */
  tableCount: number;
}

/** Build minimal table HTML from a headers+rows grid (no spans). */
export function gridToHtml(headers: string[], rows: string[][]): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tr = (cells: string[]) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;
  const head = headers.length ? `<thead>${tr(headers)}</thead>` : "";
  const body = `<tbody>${rows.map(tr).join("")}</tbody>`;
  return `<table>${head}${body}</table>`;
}
