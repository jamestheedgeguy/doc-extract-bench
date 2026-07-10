/**
 * TEDS scorer tests.
 *
 * The fixtures in ./teds-fixtures/fixtures.json carry expected values computed
 * by the reference Python implementation (IBM PubTabNet src/metric.py, commit
 * 8ffde9024bd331f5a61c3c549fdf30dd3c3e43a5, via apted + distance + lxml), with
 * the port's documented normalizations applied on both sides (th -> td,
 * inline tags stripped via the reference's own ignore_nodes). Expected values
 * are rounded to 6 decimals, so the achievable tolerance is 5e-7.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { teds } from './teds.js';

interface Fixture {
  name: string;
  pred: string;
  gt: string;
  expected: { teds: number; steds: number };
}

const fixtures: Fixture[] = JSON.parse(
  readFileSync(new URL('./teds-fixtures/fixtures.json', import.meta.url), 'utf8'),
);

// Expected values are the Python reference outputs rounded to 6 decimals, so
// ±5e-7 is the tightest defensible bound. (Against the unrounded reference the
// TS port's measured deviation is exactly 0 on every fixture.)
const TOLERANCE = 5e-7;

test('fixtures are present', () => {
  assert.ok(fixtures.length >= 20, `expected >= 20 fixtures, got ${fixtures.length}`);
});

for (const f of fixtures) {
  test(`TEDS matches Python reference: ${f.name}`, () => {
    const got = teds(f.pred, f.gt);
    assert.ok(
      Math.abs(got - f.expected.teds) <= TOLERANCE,
      `teds: got ${got}, expected ${f.expected.teds} (|diff|=${Math.abs(got - f.expected.teds)})`,
    );
    const gotStruct = teds(f.pred, f.gt, { structureOnly: true });
    assert.ok(
      Math.abs(gotStruct - f.expected.steds) <= TOLERANCE,
      `steds: got ${gotStruct}, expected ${f.expected.steds} (|diff|=${Math.abs(gotStruct - f.expected.steds)})`,
    );
  });
}

test('score is symmetric-ish sanity: identical input scores 1', () => {
  const t = '<table><tr><td>a</td></tr></table>';
  assert.equal(teds(t, t), 1);
  assert.equal(teds(t, t, { structureOnly: true }), 1);
});

test('empty and non-table inputs score 0', () => {
  const t = '<table><tr><td>a</td></tr></table>';
  assert.equal(teds('', t), 0);
  assert.equal(teds(t, ''), 0);
  assert.equal(teds('<div>nope</div>', t), 0);
  assert.equal(teds(t, 'plain text'), 0);
});

test('scores are within [0, 1] and structureOnly >= content score on text-only edits', () => {
  const pred = '<table><tr><td>aXc</td><td>q</td></tr></table>';
  const gt = '<table><tr><td>abc</td><td>q</td></tr></table>';
  const t = teds(pred, gt);
  const s = teds(pred, gt, { structureOnly: true });
  assert.ok(t > 0 && t < 1);
  assert.equal(s, 1);
});

test('a ~2000-node pair scores in under 5 seconds', () => {
  const makeTable = (rows: number, cols: number, mutate: boolean): string => {
    const parts: string[] = ['<table><tbody>'];
    for (let r = 0; r < rows; r++) {
      parts.push('<tr>');
      for (let c = 0; c < cols; c++) {
        const text = mutate && (r * cols + c) % 17 === 0 ? `cell ${r}-${c}!` : `cell ${r}-${c}`;
        parts.push(`<td>${text}</td>`);
      }
      parts.push('</tr>');
    }
    parts.push('</tbody></table>');
    return parts.join('');
  };
  // 180 rows x 10 cols + tr + tbody ≈ 1981 nodes per tree
  const pred = makeTable(180, 10, true);
  const gt = makeTable(180, 10, false);
  const startedAt = performance.now();
  const score = teds(pred, gt);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(score > 0.9 && score < 1, `score ${score}`);
  assert.ok(elapsedMs < 5000, `took ${elapsedMs.toFixed(0)}ms`);
});
