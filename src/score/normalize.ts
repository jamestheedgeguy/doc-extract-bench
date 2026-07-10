/** Type-aware normalization — the exact rules behind every headline number.
 *
 *  - amounts  → parse to float; match iff |pred − gt| ≤ 0.005
 *  - dates    → parse to ISO YYYY-MM-DD; exact match after normalization
 *  - strings  → lowercase, collapse whitespace, strip punctuation; exact match
 *
 *  No fuzzy matching contributes to headline numbers. ANLS (a standard
 *  document-VQA similarity) is computed as a SECONDARY diagnostic only.
 */

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export function normalizeString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

export function normalizeAmount(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /-/.test(s);
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastComma > lastDot) {
    // comma-decimal ("1.234,56") or comma-thousands ("1,234")
    const frac = s.length - lastComma - 1;
    s = frac === 3 && lastDot === -1 ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

export function normalizeDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/,. ]+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/([A-Za-z]{3,9})[-/,. ]+(\d{1,2})[-/,. ]+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[2].padStart(2, "0")}`;
  }
  m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) {
    // Ambiguous numeric form: both benchmark receipt datasets (SROIE =
    // Malaysia) and FATURA GT are day-first — documented in methodology.
    return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})(?!\d)/);
  if (m) return `20${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

export type FieldType = "string" | "number" | "date";

/** Deterministic equality after type-aware normalization. */
export function fieldMatches(type: FieldType, pred: unknown, gt: unknown): boolean {
  if (type === "number") {
    const p = normalizeAmount(pred);
    const g = normalizeAmount(gt);
    return p !== null && g !== null && Math.abs(p - g) <= 0.005;
  }
  if (type === "date") {
    const p = normalizeDate(pred);
    const g = normalizeDate(gt);
    return p !== null && g !== null && p === g;
  }
  const p = normalizeString(pred);
  const g = normalizeString(gt);
  return p !== null && g !== null && p === g;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = [...cur];
  }
  return prev[n];
}

/** ANLS similarity (secondary diagnostic only, threshold 0.5 as in DocVQA). */
export function anls(pred: unknown, gt: unknown): number {
  const p = normalizeString(pred);
  const g = normalizeString(gt);
  if (p === null || g === null) return p === g ? 1 : 0;
  const d = levenshtein(p, g) / Math.max(p.length, g.length, 1);
  const sim = 1 - d;
  return sim >= 0.5 ? sim : 0;
}
