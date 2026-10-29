const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/renderer/costs.js');

test('addSpend accumulates per model within a month', () => {
  let s = C.addSpend(undefined, 'gemini-2.5-pro', 1000, 500, '2026-10');
  s = C.addSpend(s, 'gemini-2.5-pro', 200, 100, '2026-10');
  s = C.addSpend(s, 'claude-opus-5-5', 50, 25, '2026-10');
  assert.strictEqual(s.month, '2026-10');
  assert.deepStrictEqual(s.models['gemini-2.5-pro'], { in: 1200, out: 600 });
  assert.deepStrictEqual(s.models['claude-opus-5-5'], { in: 50, out: 25 });
});

test('addSpend rolls over to a new month, keeping the old one under prev', () => {
  let s = C.addSpend(undefined, 'm', 1000, 1000, '2026-10');
  s = C.addSpend(s, 'm', 7, 3, '2026-11');
  assert.strictEqual(s.month, '2026-11');
  assert.deepStrictEqual(s.models.m, { in: 7, out: 3 });
  assert.deepStrictEqual(s.prev, { month: '2026-10', models: { m: { in: 1000, out: 1000 } } });
});

test('costUSD prices only models in the table and reports unpriced ones', () => {
  const models = { a: { in: 2_000_000, out: 1_000_000 }, b: { in: 500, out: 500 } };
  const { total, priced, unpriced } = C.costUSD(models, { a: { in: 1.25, out: 10 } });
  assert.strictEqual(total, 2 * 1.25 + 1 * 10);
  assert.strictEqual(priced, true);
  assert.strictEqual(unpriced, 1);
  const none = C.costUSD(models, {});
  assert.strictEqual(none.total, 0);
  assert.strictEqual(none.priced, false);
});

test('capReached only fires with a positive cap and enough priced spend', () => {
  const spend = { month: '2026-10', models: { m: { in: 10_000_000, out: 0 } } };
  const prices = { m: { in: 2, out: 10 } }; // $20 spent
  assert.strictEqual(C.capReached(spend, prices, 0), false);
  assert.strictEqual(C.capReached(spend, prices, 25), false);
  assert.strictEqual(C.capReached(spend, prices, 20), true);
  assert.strictEqual(C.capReached(spend, {}, 5), false); // no prices -> no measurable spend
});

test('formatUSD covers the small and large ends', () => {
  assert.strictEqual(C.formatUSD(0), '$0.00');
  assert.strictEqual(C.formatUSD(0.004), '<$0.01');
  assert.strictEqual(C.formatUSD(1.234), '$1.23');
  assert.strictEqual(C.formatUSD(1234.5), '$1,235');
});

test('monthKey formats as YYYY-MM', () => {
  assert.strictEqual(C.monthKey(new Date(2026, 0, 5)), '2026-01');
  assert.strictEqual(C.monthKey(new Date(2026, 11, 31)), '2026-12');
});
