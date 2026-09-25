import test from 'node:test';
import assert from 'node:assert/strict';
import { isFreshDailyBar, rsi, sma, summarizeBars } from '../lib/indicators.js';

test('indicators require enough complete history', () => {
  assert.equal(sma([1, 2], 3), null);
  assert.equal(rsi([1, 2], 14), null);
  assert.equal(summarizeBars([{ t: '2026-09-17', c: 10, v: 100 }]), null);
});

test('rising bars yield a constructive trend and high RSI', () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({
    t: new Date(Date.UTC(2026, 5, i + 1)).toISOString(), c: 100 + i, v: 100000,
  }));
  const chart = summarizeBars(bars);
  assert.equal(chart.trendUp, true);
  assert.equal(chart.rsi14, 100);
});

test('stale or future price data is rejected', () => {
  const now = new Date('2026-09-17T22:00:00Z');
  assert.equal(isFreshDailyBar('2026-09-01T00:00:00Z', now), false);
  assert.equal(isFreshDailyBar('2026-09-18T00:00:00Z', now), false);
});
