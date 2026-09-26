import test from 'node:test';
import assert from 'node:assert/strict';
import { SETUPS, prepare, attachMomentumRanks, CONFIG, varianceRatio, seriesCharacter, simulateTrade, backtest, judgeCell, cellStatus, atrSeries, rsiSeries, marketRegime, readSymbol, tradeStats } from '../lib/protocol.js';
import { dailyIndicators } from '../lib/morning-strategy.js';
import { barsFromReturns, randomWalk, ar1 } from './synthetic.js';

test('variance ratio: ~2σ false-positive rate on random walks, 0.123 SE at T=756 q=10', () => {
  let wrong = 0;
  for (let s = 1; s <= 300; s++) { const bars = barsFromReturns(randomWalk(757, s)); const ch = seriesCharacter(bars.map(b => b.c)); if (ch.label !== 'random walk') wrong++; }
  assert.ok(wrong / 300 < 0.08, `false-positive rate ${wrong / 300}`);
  const v = varianceRatio(barsFromReturns(randomWalk(757, 1)).map(b => b.c));
  assert.ok(Math.abs(v.se - 0.123) < 0.002);
});
test('variance ratio detects genuine AR(1) structure at least half the time', () => {
  let t = 0, m = 0;
  for (let s = 1; s <= 100; s++) {
    if (seriesCharacter(barsFromReturns(ar1(757, s, 0.15)).map(b => b.c)).label === 'trending') t++;
    if (seriesCharacter(barsFromReturns(ar1(757, s + 999, -0.15)).map(b => b.c)).label === 'mean-reverting') m++;
  }
  assert.ok(t >= 40 && m >= 40, `trend ${t} mr ${m}`);
});
test('refuses to classify under 500 bars', () => {
  assert.equal(seriesCharacter(barsFromReturns(randomWalk(400, 3)).map(b => b.c)).label, 'insufficient');
});
test('ATR and RSI match the original Wilder implementation', () => {
  const bars = barsFromReturns(randomWalk(120, 5)).map(b => ({ ...b, t: b.t }));
  const prev = bars.at(-1).t.slice(0, 10);
  const orig = dailyIndicators(bars, prev);
  assert.ok(Math.abs(atrSeries(bars).at(-1) - orig.atr14) < 1e-9);
  assert.ok(Math.abs(rsiSeries(bars.map(b => b.c)).at(-1) - orig.rsi14) < 1e-9);
});
const bar = (d, o, h, l, c) => ({ t: `2026-01-${String(d).padStart(2, '0')}T05:00:00Z`, o, h, l, c, v: 1e6 });
const plan = { limit: 100, stop: 95, target: 110, maxSessions: 5 };
const cfg0 = { ...CONFIG, costPct: 0 };
test('trade simulation: limit fills, never chases, stop wins ties, gaps honoured, time exit', () => {
  assert.equal(simulateTrade(plan, [bar(2, 101, 103, 100.5, 102)], cfg0).status, 'nofill');
  const lim = simulateTrade(plan, [bar(2, 101, 103, 99, 102), bar(3, 102, 111, 101, 109)], cfg0);
  assert.equal(lim.entry, 100); assert.equal(lim.reason, 'target'); assert.equal(lim.r, 2);
  assert.equal(simulateTrade(plan, [bar(2, 99, 111, 94, 100)], cfg0).reason, 'stop');
  const gap = simulateTrade(plan, [bar(2, 99, 100, 98, 99), bar(3, 90, 91, 89, 90)], cfg0);
  assert.equal(gap.reason, 'stop (gap)'); assert.equal(gap.exit, 90); assert.ok(gap.r < -2);
  const t = simulateTrade(plan, [1, 2, 3, 4, 5].map(k => bar(1 + k, 100, 101, 99, 100 + k / 10)), cfg0);
  assert.equal(t.reason, 'time'); assert.equal(t.sessions, 5);
  assert.equal(simulateTrade(plan, [bar(2, 99, 100, 98, 99)], cfg0).status, 'open');
  assert.equal(simulateTrade(plan, [bar(2, 94, 96, 93, 95)], cfg0).status, 'nofill');
});
test('costs are charged in R on both sides', () => {
  const r = simulateTrade(plan, [bar(2, 100, 111, 99, 109)], { ...CONFIG, costPct: 0.0005 });
  assert.ok(Math.abs(r.r - (10 - 0.0005 * 210) / 5) < 1e-12);
});
test('backtest has no look-ahead: truncating the future never changes past trades', () => {
  const bars = barsFromReturns(randomWalk(800, 11, { drift: 0.0008 }));
  const full = backtest(bars, 'pullback'), part = backtest(bars.slice(0, 500), 'pullback');
  const early = full.filter(t => t.i + t.sessions < 499);
  assert.deepEqual(part.slice(0, early.length).map(t => t.r), early.map(t => t.r));
});
test('regime is risk-off in a falling tape and blocks every long', () => {
  const spy = barsFromReturns(randomWalk(760, 21, { drift: -0.002, vol: 0.008 }));
  const reg = marketRegime(spy);
  assert.equal(reg.allowsLongs, false);
  const r = readSymbol({ symbol: 'X', bars: barsFromReturns(randomWalk(760, 22, { drift: 0.001 })), spy, regime: reg, equity: 1e4, riskPct: 0.005 });
  assert.match(r.blockers[0], /regime/);
});

test('RSI(2) dip exits on the first close above its 5-day average', () => {
  const p = { limit: 100, stop: 90, target: null, maxSessions: 5, exitAboveSma: 5, prevCloses: [104, 103, 101, 99] };
  const r = simulateTrade(p, [bar(2, 99, 100, 98, 99), bar(3, 99, 104, 99, 103)], cfg0);
  assert.equal(r.reason, 'close > SMA5'); assert.equal(r.exit, 103);
});
test('a cell is only enabled when every fold clears the bar and validation is fresh', () => {
  const good = { n: 200, avgR: 0.1, rs: Array.from({ length: 200 }, (_, i) => i % 2 ? 1.2 : -1) };
  assert.equal(judgeCell([good, good]).pass, true);
  assert.equal(judgeCell([good, { ...good, avgR: -0.01 }]).pass, false);
  assert.equal(judgeCell([good, { ...good, n: 40 }]).pass, false);
  const v = { generatedAt: '2026-09-01T00:00:00Z', cells: { pullback: { trending: { pass: true, fails: [] } } } };
  assert.equal(cellStatus(v, 'pullback', 'trending', new Date('2026-09-20')).enabled, true);
  assert.equal(cellStatus(v, 'pullback', 'trending', new Date('2026-12-20')).enabled, false);
  assert.equal(cellStatus(null, 'pullback', 'trending').enabled, false);
});
test('without a validation file nothing is ever a live candidate', () => {
  let live = 0;
  const spy = barsFromReturns(randomWalk(760, 40, { drift: 0.0008, vol: 0.006 }));
  const reg = marketRegime(spy);
  for (let s = 1; s <= 80; s++) {
    const r = readSymbol({ symbol: 'S' + s, bars: barsFromReturns(randomWalk(760, s, { drift: 0.0006, vol: 0.02 }), { seed: s, volume: 3e6 }), spy, regime: reg, validation: null, equity: 1e4, riskPct: 0.005 });
    live += r.candidates.length;
  }
  assert.equal(live, 0);
});

test('new setups fire only on their pre-registered conditions', () => {
  const base = barsFromReturns(randomWalk(300, 77, { drift: 0.002, vol: 0.01 }), { seed: 77, volume: 3e6 });
  const last = base.at(-1), gap = { ...last, t: '2099-01-01T05:00:00Z', o: last.c * 1.05, l: last.c * 1.04, h: last.c * 1.09, c: last.c * 1.08, v: 2e7 };
  const s1 = prepare([...base, gap]);
  const g = SETUPS.gapdrift.at(s1, s1.bars.length - 1);
  assert.ok(g, 'gap on 6x volume that closes strong fires'); assert.equal(g.maxSessions, 20); assert.equal(g.target, null);
  const weak = prepare([...base, { ...gap, c: gap.l * 1.001 }]);
  assert.equal(SETUPS.gapdrift.at(weak, weak.bars.length - 1), null, 'gap that fades does not');
  const s2 = prepare(base);
  assert.equal(SETUPS.leaderdip.at(s2, s2.bars.length - 1), null, 'no cross-sectional rank → never fires');
});
test('momentum ranks are cross-sectional percentiles per date', () => {
  const u = {}; for (let k = 0; k < 60; k++) u['S' + k] = prepare(barsFromReturns(randomWalk(300, 500 + k, { drift: (k - 30) * 0.0001 }), { seed: 500 + k }));
  attachMomentumRanks(u);
  const last = Object.values(u).map(s => s.momPct.at(-1));
  assert.equal(Math.min(...last), 0); assert.equal(Math.max(...last), 1);
});
