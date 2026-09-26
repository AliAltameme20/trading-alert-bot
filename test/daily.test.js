import test from 'node:test';
import assert from 'node:assert/strict';
import { runDaily, formatDaily, exitRule } from '../lib/daily.js';
import { CONFIG } from '../lib/protocol.js';
import { emptyLedger, resolve, updateKillSwitch, liveStats } from '../lib/ledger.js';
import { sessionClock, etInstant, cleanBars, earningsWindow } from '../lib/market.js';
import { barsFromReturns, randomWalk, ar1 } from './synthetic.js';

// Synthetic exchange: 1,000 sessions of weekday bars ending on the "completed" session.
function world({ n = 60, validated = true, earningsFor = null, aiVeto = false, verified = true, spyDrift = 0.0008, cell: cellOverride } = {}) {
  const spy = barsFromReturns(randomWalk(1000, 999, { drift: spyDrift, vol: 0.007 }), { seed: 999, volume: 5e7 });
  const dates = spy.map(b => b.t.slice(0, 10));
  const mk = (ret, seed) => barsFromReturns(ret, { seed, volume: 3e6, vol: 0.02 }).map((b, i) => ({ ...b, t: spy[i].t }));
  const bars = { SPY: spy };
  for (let s = 1; s <= n; s++) bars['S' + s] = mk(ar1(1000, s, 0.12, { vol: 0.02, drift: 0.0006 }), s);
  const last = dates.at(-1), next = new Date(Date.parse(last) + 86400000).toISOString().slice(0, 10);
  const sessions = [...dates, next, '2099-01-01'].map(d => ({ date: d, open: etInstant(d, '09:30'), close: etInstant(d, '16:00') }));
  const now = new Date(etInstant(last, '20:00'));
  const cell = cellOverride || { pass: true, fails: [], pooled: { n: 900, avgR: 0.2, pf: 1.5, t: 4, winRate: 0.5 } };
  const validation = validated ? { generatedAt: now.toISOString(), cells: Object.fromEntries(['pullback', 'breakout', 'dip'].map(k => [k, { 'random walk': cell, trending: cell, 'mean-reverting': cell }])) } : null;
  const calls = { ai: 0 };
  const services = {
    calendar: async () => sessions, sessionClock,
    universe: async () => ({ assets: Object.keys(bars).filter(s => s !== 'SPY').map(symbol => ({ symbol, name: symbol + ' Corp' })) }),
    dailyBars: async (syms, start, end) => ({ feed: 'sip', bars: Object.fromEntries(syms.filter(s => bars[s]).map(s => [s, cleanBars(bars[s].filter(b => b.t.slice(0, 10) >= new Date(start).toISOString().slice(0, 10)), end)])) }),
    earningsWindow: async () => ({ verified, sources: ['test'], bySymbol: new Map(earningsFor ? earningsFor.map(s => [s, next]) : []) }),
    recentNews: async () => [{ headline: 'Synthetic headline', url: 'https://example.com' }],
    aiVeto: async () => { calls.ai++; return { ran: true, veto: aiVeto, why: aiVeto ? 'AI flagged (test)' : 'no disqualifier (test)' }; },
  };
  return { services, now, validation, calls, bars, next, last };
}

test('validated cells produce at most MAX_NEW live signals with levels, size and edge evidence', async () => {
  const w = world(), ledger = emptyLedger();
  const out = await runDaily({ now: w.now, services: w.services, ledger, validation: w.validation, settings: { maxNew: 1 } });
  assert.equal(out.status, 'signal'); assert.equal(out.signals.length, 1);
  const msg = formatDaily(out);
  assert.match(msg, /BUY LIMIT S\d+ @ \$/); assert.match(msg, /Stop \$/); assert.match(msg, /out-of-sample trades/); assert.match(msg, /Funnel:/);
  assert.equal(ledger.signals.filter(s => s.kind === 'live').length, 1);
});
test('no validation file → zero trades, only shadow logging', async () => {
  const w = world({ validated: false }), ledger = emptyLedger();
  const out = await runDaily({ now: w.now, services: w.services, ledger, validation: null });
  assert.equal(out.signals.length, 0); assert.match(formatDaily(out), /NO TRADE — No setup has validated/);
  assert.ok(ledger.signals.every(s => s.kind === 'shadow'));
});
test('earnings inside 5 sessions and unverifiable earnings both block (fail-closed)', async () => {
  const w1 = world(); const o1 = await runDaily({ now: w1.now, services: { ...w1.services, earningsWindow: async () => ({ verified: true, sources: [], bySymbol: new Map(Object.keys(w1.bars).map(s => [s, w1.next])) }) }, ledger: emptyLedger(), validation: w1.validation });
  assert.equal(o1.signals.length, 0); assert.ok(o1.vetoed.every(v => /earnings/.test(v.why)));
  const w2 = world({ verified: false }); const o2 = await runDaily({ now: w2.now, services: w2.services, ledger: emptyLedger(), validation: w2.validation });
  assert.equal(o2.signals.length, 0); assert.ok(o2.vetoed.some(v => /unverifiable/.test(v.why)));
});
test('the AI can only withhold, never add', async () => {
  const w = world({ aiVeto: true }); const out = await runDaily({ now: w.now, services: w.services, ledger: emptyLedger(), validation: w.validation });
  assert.equal(out.signals.length, 0); assert.ok(out.vetoed.some(v => /AI flagged/.test(v.why)));
});
test('risk-off tape blocks every long before any stock is read', async () => {
  const w = world({ spyDrift: -0.002 }); const out = await runDaily({ now: w.now, services: w.services, ledger: emptyLedger(), validation: w.validation });
  assert.equal(out.status, 'regime-block'); assert.match(formatDaily(out), /regime does not support/);
});
test('after the next open, the run refuses to send a stale signal', async () => {
  const w = world(); const late = new Date(etInstant(w.next, '10:00'));
  const out = await runDaily({ now: late, services: w.services, ledger: emptyLedger(), validation: w.validation });
  assert.equal(out.status, 'missed');
});
test('ledger scores outcomes with the backtest engine; kill switch pauses and resumes', () => {
  const L = emptyLedger();
  const mk = (i, r) => ({ id: 'x' + i, symbol: 'X', kind: 'live', status: 'closed', result: { r, exitDate: `2026-01-${String(i).padStart(2, '0')}` } });
  L.signals = Array.from({ length: 16 }, (_, i) => mk(i + 1, -0.5));
  assert.equal(updateKillSwitch(L), 'paused'); assert.equal(L.pause.paused, true);
  L.signals.push(...Array.from({ length: 20 }, (_, i) => ({ ...mk(i + 17, 1), kind: 'paused' })));
  assert.equal(updateKillSwitch(L), 'resumed');
  const L2 = emptyLedger();
  L2.signals.push({ id: 'a', symbol: 'A', kind: 'live', asOf: '2026-01-02', status: 'pending', plan: { limit: 100, stop: 95, target: 110, maxSessions: 5 } });
  resolve(L2, { A: [{ t: '2026-01-05T05:00:00Z', o: 99, h: 111, l: 98, c: 110, v: 1 }] });
  assert.equal(L2.signals[0].status, 'closed'); assert.equal(L2.signals[0].result.reason, 'target');
  assert.equal(liveStats(L2).n, 1);
});
test('DST-safe session clock', () => {
  assert.equal(etInstant('2026-07-01', '16:00').toISOString(), '2026-07-01T20:00:00.000Z');
  assert.equal(etInstant('2026-12-01', '16:00').toISOString(), '2026-12-01T21:00:00.000Z');
});
test('SIP queries end with an exact timestamp at least 16 minutes old', async () => {
  const { endStamp } = await import('../lib/market.js');
  const now = Date.parse('2026-09-25T21:30:00Z');
  assert.equal(endStamp('2026-09-25', now), '2026-09-25T21:14:00.000Z');
  assert.equal(endStamp('2026-09-24', now), '2026-09-24T23:59:59.000Z');
});

test('the message states the exit each setup was validated with', () => {
  assert.match(exitRule({ exitAboveSma: 5, maxSessions: 5 }), /closes above its 5-day avg/);
  assert.match(exitRule({ target: 110, maxSessions: 10 }), /Target \$110\.00/);
  const timeOnly = exitRule({ target: null, maxSessions: 20 });   // gapdrift, high52, leaderdip
  assert.match(timeOnly, /close of session 20/); assert.doesNotMatch(timeOnly, /avg/);
});
test('probation cells send a labelled signal at reduced risk, and full cells outrank them', async () => {
  const probation = { pass: false, fails: ['fold 2: +0.02R < +0.05R'], pooled: { n: 900, avgR: 0.04, pf: 1.1, t: 4, winRate: 0.5 }, folds: [{ n: 450, avgR: 0.06 }, { n: 450, avgR: 0.02 }] };
  const w = world({ cell: probation }), ledger = emptyLedger();
  const out = await runDaily({ now: w.now, services: w.services, ledger, validation: w.validation, settings: { equity: 10000, riskPct: 0.01 } });
  assert.equal(out.status, 'signal');
  const s = out.signals[0];
  assert.equal(s.best.tier, 'probation'); assert.equal(s.rec.tier, 'probation');
  assert.equal(s.read.sizing.riskDollars, 10000 * 0.01 * out.regime.riskScale * CONFIG.probationRiskScale);
  assert.match(formatDaily(out), /\[PROBATION · reduced size\] BUY LIMIT/);
  assert.ok(out.enabledCells.every(c => c.endsWith('(probation)')));
  const weak = { ...probation, pooled: { ...probation.pooled, t: 2 } };
  const w2 = world({ cell: weak }), o2 = await runDaily({ now: w2.now, services: w2.services, ledger: emptyLedger(), validation: w2.validation });
  assert.equal(o2.signals.length, 0, 't < 3 stays off');
});
test('a report after the signal-day close blocks the trade', async () => {
  const w = world(); let asked;
  const services = { ...w.services, earningsWindow: async (dates, opts) => { asked = opts; return { verified: true, sources: ['test'], bySymbol: new Map(Object.keys(w.bars).map(s => [s, w.last])) }; } };
  const out = await runDaily({ now: w.now, services, ledger: emptyLedger(), validation: w.validation });
  assert.equal(asked.signalDate, w.last);
  assert.equal(out.signals.length, 0); assert.ok(out.vetoed.length && out.vetoed.every(v => /after the close/.test(v.why)));
});
test('earnings calendar: signal-day reports block unless a source confirms before the open', async () => {
  const saved = process.env.FINNHUB_API_KEY; process.env.FINNHUB_API_KEY = 'k';
  const rows = { '2026-09-25': [{ symbol: 'AMC1', time: 'time-after-hours' }, { symbol: 'BMO1', time: 'time-pre-market' }, { symbol: 'UNK1', time: 'time-not-supplied' }, { symbol: 'MIX1', time: 'time-not-supplied' }], '2026-09-28': [{ symbol: 'NEXT', time: 'time-pre-market' }] };
  const fetchImpl = async u => {
    const url = new URL(u);
    if (url.host === 'finnhub.io') return { ok: true, json: async () => ({ earningsCalendar: [{ symbol: 'MIX1', date: '2026-09-25', hour: 'bmo' }] }) };
    return { ok: true, json: async () => ({ data: { rows: rows[url.searchParams.get('date')] || [] } }) };
  };
  try {
    const e = await earningsWindow(['2026-09-28', '2026-09-29'], { fetchImpl, signalDate: '2026-09-25' });
    assert.equal(e.verified, true);
    assert.equal(e.bySymbol.get('AMC1'), '2026-09-25'); assert.equal(e.bySymbol.get('UNK1'), '2026-09-25', 'unknown timing fails closed');
    assert.equal(e.bySymbol.has('BMO1'), false); assert.equal(e.bySymbol.has('MIX1'), false, 'one source confirming pre-market is enough');
    assert.equal(e.bySymbol.get('NEXT'), '2026-09-28');
  } finally { if (saved === undefined) delete process.env.FINNHUB_API_KEY; else process.env.FINNHUB_API_KEY = saved; }
});
test('a split during the hold rescales the plan instead of scoring garbage', () => {
  const L = emptyLedger();
  L.signals.push({ id: 'a', symbol: 'A', kind: 'live', asOf: '2026-01-02', status: 'pending', plan: { limit: 100, stop: 95, target: 110, maxSessions: 5, close: 99 } });
  // 2-for-1 split mid-trade: split-adjusted history halves the signal bar too
  resolve(L, { A: [{ t: '2026-01-02T05:00:00Z', o: 49, h: 50, l: 49, c: 49.5, v: 1 }, { t: '2026-01-05T05:00:00Z', o: 49.8, h: 50.5, l: 49.6, c: 50.2, v: 1 }, { t: '2026-01-06T05:00:00Z', o: 50.3, h: 55.2, l: 50.1, c: 55, v: 1 }] });
  const s = L.signals[0];
  assert.equal(s.status, 'closed'); assert.equal(s.result.reason, 'target'); assert.equal(s.result.splitFactor, 0.5);
  assert.ok(Math.abs(s.result.r - (55 - 49.8 - CONFIG.costPct * (49.8 + 55)) / (49.8 - 47.5)) < 1e-9);
});
