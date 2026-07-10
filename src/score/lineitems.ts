/** Line-item / transaction alignment + P/R/F1.
 *
 *  Greedy 1:1 alignment: candidate pairs are ranked by (amount match first,
 *  then description similarity); each GT item and each predicted item is
 *  used at most once. An aligned item is CORRECT iff every GT-present field
 *  on it matches under the type-aware rules (no partial credit).
 */

import { fieldMatches, levenshtein, normalizeAmount, normalizeString } from "./normalize.js";

export interface Item {
  description?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  amount?: unknown;
}

export interface ItemsResult {
  gtCount: number;
  predCount: number;
  matched: number;
  correct: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

function descSim(a: unknown, b: unknown): number {
  const p = normalizeString(a);
  const g = normalizeString(b);
  if (p === null || g === null) return 0;
  return 1 - levenshtein(p, g) / Math.max(p.length, g.length, 1);
}

const ITEM_FIELDS = ["description", "quantity", "unitPrice", "amount"] as const;
const ITEM_TYPES = {
  description: "string",
  quantity: "number",
  unitPrice: "number",
  amount: "number",
} as const;

export function scoreItems(pred: Item[], gt: Item[]): ItemsResult {
  // Rank all candidate pairs: amount-equal pairs first, then by description
  // similarity (descending). Deterministic tie-break on (gtIdx, predIdx).
  const pairs: { gi: number; pi: number; amountEq: boolean; sim: number }[] = [];
  gt.forEach((g, gi) => {
    pred.forEach((p, pi) => {
      const ga = normalizeAmount(g.amount);
      const pa = normalizeAmount(p.amount);
      const amountEq = ga !== null && pa !== null && Math.abs(ga - pa) <= 0.005;
      const sim = descSim(p.description, g.description);
      if (amountEq || sim > 0) pairs.push({ gi, pi, amountEq, sim });
    });
  });
  pairs.sort(
    (a, b) =>
      Number(b.amountEq) - Number(a.amountEq) || b.sim - a.sim || a.gi - b.gi || a.pi - b.pi,
  );

  const gtUsed = new Set<number>();
  const predUsed = new Set<number>();
  let correct = 0;
  for (const { gi, pi } of pairs) {
    if (gtUsed.has(gi) || predUsed.has(pi)) continue;
    gtUsed.add(gi);
    predUsed.add(pi);
    const g = gt[gi];
    const p = pred[pi];
    const allMatch = ITEM_FIELDS.every((f) => {
      const gv = g[f];
      if (gv === null || gv === undefined || String(gv).trim() === "") return true; // GT-absent
      return fieldMatches(ITEM_TYPES[f], p[f], gv);
    });
    if (allMatch) correct++;
  }

  const precision = pred.length ? correct / pred.length : null;
  const recall = gt.length ? correct / gt.length : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : precision === null || recall === null
        ? null
        : 0;
  return {
    gtCount: gt.length,
    predCount: pred.length,
    matched: gtUsed.size,
    correct,
    precision,
    recall,
    f1,
  };
}
