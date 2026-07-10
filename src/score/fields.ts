/** Per-field scoring over GT-present fields, micro-averaged.
 *
 *  A field is scored only when the ground truth has a non-null value for it
 *  ("GT-present"). Missing prediction for a GT-present field = wrong.
 *  Fields absent from GT are never scored (they neither help nor hurt).
 */

import { anls, fieldMatches, type FieldType } from "./normalize.js";

export interface FieldScore {
  field: string;
  gtPresent: boolean;
  correct: boolean;
  anls: number;
}

export interface FieldsResult {
  perField: FieldScore[];
  /** fields scored (GT-present) */
  scored: number;
  correct: number;
  /** micro accuracy over GT-present fields; null when nothing scoreable */
  accuracy: number | null;
  /** mean ANLS over GT-present fields (secondary diagnostic) */
  anls: number | null;
}

export function scoreFields<F extends string>(
  fields: readonly F[],
  types: Record<F, FieldType>,
  pred: Partial<Record<F, unknown>>,
  gt: Partial<Record<F, unknown>>,
): FieldsResult {
  const perField: FieldScore[] = [];
  for (const f of fields) {
    const g = gt[f];
    const gtPresent = g !== null && g !== undefined && String(g).trim() !== "";
    if (!gtPresent) {
      perField.push({ field: f, gtPresent: false, correct: false, anls: 0 });
      continue;
    }
    const p = pred[f];
    perField.push({
      field: f,
      gtPresent: true,
      correct: fieldMatches(types[f], p, g),
      anls: types[f] === "string" ? anls(p, g) : fieldMatches(types[f], p, g) ? 1 : 0,
    });
  }
  const scoredFields = perField.filter((s) => s.gtPresent);
  const correct = scoredFields.filter((s) => s.correct).length;
  return {
    perField,
    scored: scoredFields.length,
    correct,
    accuracy: scoredFields.length ? correct / scoredFields.length : null,
    anls: scoredFields.length
      ? scoredFields.reduce((a, s) => a + s.anls, 0) / scoredFields.length
      : null,
  };
}
