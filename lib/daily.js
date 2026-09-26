// One run = one completed session. Resolve the ledger, read every liquid stock through the
// protocol, keep only validated-edge candidates, apply earnings + AI veto, format one message.
// Services are injected so the whole pipeline runs offline in tests.
import { CONFIG, SETUPS, marketRegime, readSymbol, sessionsUntil, fmtR, mean, median, configForFeed, prepare, attachMomentumRanks, momentumUniverse, cellStatus } from './protocol.js';
import { addSignal, resolve, liveStats, updateKillSwitch, openSymbols } from './ledger.js';
import { addDays } from './market.js';

const money = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

export async function runDaily({ now = new Date(), services, ledger, validation, settings = {}, cfg = CONFIG, log = () => {} }) {
  // cfg is re-bound below once we know which data feed Alpaca granted
  const S = { equity: 10000, riskPct: 0.005, maxNew: 1, maxOpen: 3, shadowPerDay: 3, ...settings };
  const out = { status: 'no-signal', funnel: {}, signals: [], shadows: [], exits: [], vetoed: [] };

  const sessions = await services.calendar(addDays(now, -1200), addDays(now, 45));   // +45d covers a 20-session hold
  const clock = services.sessionClock(sessions, now);
  if (!clock.target) throw new Error('No completed session found');
  out.session = clock.target.date; out.nextSession = clock.next?.date; out.future = clock.future; out.equity = S.equity;
  if (!clock.entryWindowOpen) { out.status = 'missed'; return out; }
  const through = clock.target.date, histStart = addDays(through + 'T00:00:00Z', -1150);

  // 1. score what already happened
  const ledgerSyms = [...new Set(ledger.signals.filter(s => ['pending', 'open'].includes(s.status)).map(s => s.symbol))];
  if (ledgerSyms.length) {
    const since = ledger.signals.filter(s => ['pending', 'open'].includes(s.status)).map(s => s.asOf).sort()[0];
    // Split-adjusted only: plan levels are nominal prices, and resolve() rescales them if a split lands mid-trade.
    const { bars } = await services.dailyBars(ledgerSyms, addDays(since + 'T00:00:00Z', -10), through, { adjustment: 'split' });
    out.exits = resolve(ledger, bars, cfg);
  }
  const kill = updateKillSwitch(ledger, now);
  out.kill = kill; out.paused = ledger.pause.paused;

  // 2. regime
  const { bars: spyMap, feed } = await services.dailyBars(['SPY'], histStart, through);
  const spy = spyMap.SPY;
  if (!spy || spy.at(-1).t.slice(0, 10) !== through) throw new Error(`SPY bar for ${through} missing — data not settled`);
  cfg = configForFeed(feed, cfg);
  const regime = marketRegime(spy, cfg); out.regime = regime; out.feed = feed;

  // 3. universe → liquidity prefilter on recent bars → full history for survivors
  const { assets } = await services.universe();
  let symbols = assets.map(a => a.symbol); const names = new Map(assets.map(a => [a.symbol, a.name]));
  if (S.universeLimit) symbols = symbols.slice(0, S.universeLimit);
  out.funnel.universe = symbols.length;
  const { bars: recent } = await services.dailyBars(symbols, addDays(through + 'T00:00:00Z', -40), through, { onProgress: log });
  const liquid = symbols.filter(s => { const b = recent[s]; if (!b || b.length < 15 || b.at(-1).t.slice(0, 10) !== through) return false; return b.at(-1).c >= cfg.minPrice && median(b.slice(-20).map(x => x.c * x.v)) >= cfg.minDollarAdv; });
  out.funnel.liquid = liquid.length;
  if (!regime.allowsLongs) { out.status = 'regime-block'; return finish(out, ledger); }
  const { bars: hist } = await services.dailyBars(liquid, histStart, through, { onProgress: log });

  const prepared = {};
  for (const sym of liquid) { const bars = hist[sym]; if (bars && bars.length >= 220 && bars.at(-1).t.slice(0, 10) === through) prepared[sym] = prepare(bars, cfg); }
  attachMomentumRanks(momentumUniverse(prepared, cfg));
  const reads = [];
  for (const [sym, s] of Object.entries(prepared))
    reads.push(readSymbol({ symbol: sym, bars: s.bars, spy, regime, validation, cfg, equity: S.equity, riskPct: S.riskPct, now, prepared: s }));
  const withSetup = reads.filter(r => r.stage !== 'liquidity' && r.stage !== 'setup');
  out.funnel.setup = withSetup.length;
  out.funnel.character = withSetup.filter(r => r.stage !== 'character').length;
  const cands = reads.filter(r => r.candidates.length).sort((a, b) => (b.tier === 'full') - (a.tier === 'full') || b.rank - a.rank || b.dollarAdv - a.dollarAdv);
  out.funnel.validated = cands.length;

  // 4. earnings (fail-closed) + AI veto on the top few only
  const held = openSymbols(ledger), room = Math.max(0, S.maxOpen - held.size);
  const window = clock.future.slice(0, cfg.earningsBlockSessions + 1);
  const pool = cands.filter(r => !held.has(r.symbol)).slice(0, 8);
  // The signal day itself is checked too: a report after today's close lands before the entry.
  const earn = pool.length ? await services.earningsWindow(window, { signalDate: through }) : { verified: true, bySymbol: new Map(), sources: [] };
  out.earningsSources = earn.sources;
  const passedEarnings = [];
  for (const r of pool) {
    const d = earn.bySymbol.get(r.symbol);
    const n = d ? sessionsUntil(d, clock.future) : Infinity;
    if (!earn.verified && cfg.earningsUnknownBlocks) { out.vetoed.push({ symbol: r.symbol, why: 'earnings date unverifiable — withheld (fail-closed)' }); continue; }
    if (d && d <= through) { out.vetoed.push({ symbol: r.symbol, why: `earnings ${d} after the close (or timing unconfirmed) — lands before entry` }); continue; }
    if (n <= cfg.earningsBlockSessions) { out.vetoed.push({ symbol: r.symbol, why: `earnings ${d} (${n} sessions) — event risk, not this trade` }); continue; }
    r.earnings = d ? `next ${d}` : `none in next ${cfg.earningsBlockSessions} sessions`;
    passedEarnings.push(r);
  }
  out.funnel.earnings = passedEarnings.length;
  const finalists = [];
  for (const r of passedEarnings) {
    if (finalists.length >= Math.min(S.maxNew, room || S.maxNew)) break;
    const best = r.candidates[0];
    if (!(r.sizing.shares >= 1)) { out.vetoed.push({ symbol: r.symbol, why: `1 share risks ${money(best.plan.riskPerShare)} — above your risk budget` }); continue; }
    const news = await services.recentNews(r.symbol, now).catch(() => []);
    r.news = news;
    r.ai = await services.aiVeto({ symbol: r.symbol, plan: best.plan, news, sessionsToEarnings: r.earnings });
    if (r.ai.veto) { out.vetoed.push({ symbol: r.symbol, why: r.ai.why }); continue; }
    finalists.push(r);
  }
  out.funnel.final = finalists.length;

  // 5. log: live, paused (would-have-been-live), or no-room; plus shadow cells for forward evidence
  const kind = ledger.pause.paused ? 'paused' : 'live';
  for (const r of finalists) {
    const best = r.candidates[0];
    if (kind === 'live' && room <= 0) { out.vetoed.push({ symbol: r.symbol, why: `already ${held.size} open signals (max ${S.maxOpen})` }); continue; }
    const rec = addSignal(ledger, { symbol: r.symbol, setup: best.key, label: best.label, character: r.character.label, asOf: through, plan: best.plan, kind, tier: best.tier, sizing: r.sizing });
    if (rec) out.signals.push({ rec, read: r, name: names.get(r.symbol), best });
  }
  for (const r of reads.filter(x => x.shadow).sort((a, b) => b.dollarAdv - a.dollarAdv).slice(0, S.shadowPerDay)) {
    const rec = addSignal(ledger, { symbol: r.symbol, setup: r.shadow.key, label: SETUPS[r.shadow.key].label, character: r.character.label, asOf: through, plan: r.shadow.plan, kind: 'shadow' });
    if (rec) out.shadows.push(rec);
  }
  out.status = out.signals.length ? (kind === 'live' ? 'signal' : 'paused-signal') : 'no-signal';
  out.enabledCells = validation ? Object.entries(validation.cells || {}).flatMap(([k, l]) => Object.keys(l).map(lab => [k, lab, cellStatus(validation, k, lab, now, cfg)]).filter(([, , c]) => c.enabled).map(([k, lab, c]) => `${k}/${lab}${c.tier === 'probation' ? ' (probation)' : ''}`)) : [];
  return finish(out, ledger);
}
function finish(out, ledger) { out.stats = liveStats(ledger); return out; }

const pct = v => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
const bigMoney = v => v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6)}M`;

// Why the setup fired, in plain words, from the numbers that made it fire.
const WHY = {
  pullback: P => `It's in an uptrend (price above its 20-day average, which is above the 50-day) and has pulled back toward the 20-day average without breaking down. RSI ${P.rsi.toFixed(0)}, so not overbought.`,
  breakout: P => `It closed above its highest price of the past 20 days (${money(P.high20)}) while in a long-term uptrend (50-day average above the 200-day).`,
  gapdrift: P => `It opened ${pct(P.gapPct)} higher on ${P.volMult.toFixed(1)}× its normal volume and held the gain into the close.`,
  high52: () => `It made its first new 52-week high in over a month, inside an established uptrend.`,
  leaderdip: P => `It's one of the strongest stocks of the past year (top ${Math.max(1, Math.round((1 - P.momPct) * 100))}% of the 1,200 most liquid stocks) and has dipped below its 10-day average.`,
  dip: P => `It dropped sharply over the last 2 days (RSI(2) ${P.rsi2.toFixed(0)}, very oversold) while still above its 200-day average.`,
};

// The exit that was validated for this plan, as lines of the message. Never a generic default.
export function exitLines(p, future = []) {
  const last = future[p.maxSessions - 1], by = last ? `${day(last)} (day ${p.maxSessions})` : `day ${p.maxSessions} of the trade`;
  if (p.exitAboveSma) {
    const trigger = p.prevCloses?.length === p.exitAboveSma - 1 ? ` On day 1 that means a close above ${money(mean(p.prevCloses))}.` : '';
    return [`Target: no fixed price. Sell at the close on the first day it closes above its ${p.exitAboveSma}-day average (market-on-close order).${trigger}`, `Time limit: otherwise sell at the close on ${by}.`];
  }
  if (p.target) return [`Target: ${money(p.target)} (${pct(p.target / p.limit - 1)}). Enter it as a GTC sell-limit. Pair it with the stop as one OCO/bracket order if your broker allows; otherwise cancel the other order as soon as one fills.`, `Time limit: if neither the stop nor the target is hit, sell at the close on ${by}.`, `Reward : risk = ${((p.target - p.limit) / p.riskPerShare).toFixed(1)} : 1`];
  return [`Target: none. This setup was tested as a timed hold: sell at the close on ${by}, unless the stop is hit first.`];
}

function formatSignal({ rec, read, name, best }, out) {
  const p = best.plan, c = best.cell, P = read.profile || {}, sz = read.sizing, eq = out.equity || 0;
  const paused = rec.kind === 'paused', probation = best.tier === 'probation', open = day(out.nextSession);
  const loss = sz.shares * p.riskPerShare, gain = p.target ? sz.shares * (p.target - p.limit) : null, ofAcct = v => eq ? ` (${(v / eq * 100).toFixed(1)}% of account)` : '';
  const L = [];
  L.push(`${paused ? '⛔ PAUSED, DO NOT TRADE:' : '🟢 BUY'} ${rec.symbol}${name ? ` · ${name}` : ''}`);
  if (probation) L.push(`🟡 Probation: half size (edge is positive but below the full bar)`);
  L.push(`${best.label} · for the ${open} open`);

  L.push('', '📋 THE TRADE');
  L.push(`Buy limit: ${money(p.limit)}. Day order; if it doesn't fill on ${open}, skip it.`);
  L.push(`Stop loss: ${money(p.stop)} (${pct(p.stop / p.limit - 1)}). Enter it as a GTC sell-stop right after the buy fills.`);
  L.push(...exitLines(p, out.future));

  L.push('', `💵 POSITION${eq ? ` (${money(eq)} account)` : ''}`);
  L.push(`Buy ${sz.shares} share${sz.shares === 1 ? '' : 's'} ≈ ${money(sz.notional)}`);
  L.push(`If stopped: −${money(loss)}${ofAcct(loss)}`);
  if (gain != null) L.push(`If target hits: +${money(gain)}${ofAcct(gain)}`);
  L.push('Fees not included. A gap at the open can fill past the stop.');

  if (read.profile) {
    const side = (v, n) => `${P.close > v ? 'above' : 'below'} its ${n}-day avg (${money(v)})`;
    L.push('', '📊 THE STOCK');
    L.push(`Last close: ${money(P.close)} (${pct(P.changePct)} on the day)`);
    L.push(`Trend: ${side(P.sma50, 50)} and ${side(P.sma200, 200)}`);
    L.push(`52-week range: ${money(P.low52)} to ${money(P.high52)}; ${P.close >= P.high52 ? 'at the high' : `${((1 - P.close / P.high52) * 100).toFixed(1)}% below the high`}`);
    if (Number.isFinite(P.spyRet6m)) L.push(`Last 6 months: ${pct(P.ret6m)} vs S&P 500 ${pct(P.spyRet6m)}`);
    L.push(`Typical daily move: ${(P.atrPct * 100).toFixed(1)}% · RSI ${P.rsi.toFixed(0)}`);
    L.push(`Traded per day: ${bigMoney(read.dollarAdv)}`);
  }

  L.push('', '🔎 WHY THIS ONE');
  if (read.profile && WHY[best.key]) L.push(WHY[best.key](P));
  L.push(`Tested on ${c.pooled.n.toLocaleString()} past trades like this over 2 years it was never tuned on: won ${Math.round(c.pooled.winRate * 100)}% of the time, averaging ${fmtR(c.pooled.avgR)} after costs (R = the amount risked).`);
  if (read.stockHistory?.n) L.push(`This stock alone: ${read.stockHistory.n} past trades, ${fmtR(read.stockHistory.avgR)} average (too few to judge).`);

  L.push('', '✅ CHECKS');
  L.push(`Earnings: ${read.earnings}`);
  L.push(`AI news check: ${read.ai.why}`);
  L.push(read.news?.[0] ? `Latest news: ${read.news[0].headline}\n${read.news[0].url}` : 'Latest news: none in 72h');
  L.push(...read.notes.map(n => `⚠️ ${n}`));
  return L.join('\n');
}

export function formatDaily(out, { test = false } = {}) {
  const L = [], f = out.funnel;
  L.push(`${test ? 'TEST — ' : ''}📈 SIGNALS for ${day(out.nextSession)} open · from ${day(out.session)} close`);
  const R = out.regime;
  if (R) L.push(`Market: ${R.state} — SPY ${R.above ? 'above' : 'below'} 200-day (slope ${(R.slope * 100).toFixed(1)}%/mo), volatility percentile ${Math.round(R.volPct * 100)}`);
  if (out.kill === 'paused') L.push(`⛔ AUTO-PAUSED: ${out.paused && 'live results turned negative'} — signals below are logged, NOT for trading, until the record recovers.`);
  if (out.kill === 'resumed') L.push('✅ Auto-pause lifted: forward results recovered.');
  if (out.status === 'regime-block') L.push('NO TRADE — the market regime does not support new longs. Every long setup degrades together in this tape.');
  for (const sig of out.signals) L.push(formatSignal(sig, out));
  if (!out.signals.length && out.status !== 'regime-block') {
    const why = !out.enabledCells?.length ? 'No setup has validated out-of-sample edge yet, so nothing is sent as a trade.' : out.vetoed.length ? 'Candidates existed but were withheld (below).' : 'No stock passed every gate today.';
    L.push(`NO TRADE — ${why}`);
  }
  if (out.vetoed.length) L.push('Withheld:\n' + out.vetoed.slice(0, 6).map(v => `• ${v.symbol}: ${v.why}`).join('\n'));
  const closed = out.exits.filter(s => s.status === 'closed' && s.kind === 'live'), filled = out.exits.filter(s => s.status === 'open' && s.kind === 'live'), nofill = out.exits.filter(s => s.status === 'nofill' && s.kind === 'live');
  if (closed.length || filled.length || nofill.length) L.push('Your signals:\n' + [
    ...closed.map(s => `• ${s.symbol}: sold ${money(s.result.exit)} (${s.result.reason}) → ${fmtR(s.result.r)} · bought ${money(s.result.entry)} ${day(s.result.entryDate)}, sold ${day(s.result.exitDate)}`),
    ...filled.map(s => `• ${s.symbol}: bought ${money(s.result.entry)}, now ${money(s.result.mark)} (${fmtR(s.result.markR)}) · stop ${money(s.plan.stop)}${s.plan.target ? ` · target ${money(s.plan.target)}` : ''} stay in place`),
    ...nofill.map(s => `• ${s.symbol}: not filled, order expired`)].join('\n'));
  const st = out.stats;
  L.push(st?.n ? `Live record: ${st.n} closed · avg ${fmtR(st.avgR)} · win ${Math.round(st.winRate * 100)}% · PF ${Number.isFinite(st.pf) ? st.pf.toFixed(2) : '∞'}` : 'Live record: no closed signals yet.');
  if (f.universe) L.push(`Funnel: ${f.universe} stocks → ${f.liquid ?? 0} liquid → ${f.setup ?? 0} with a setup → ${f.character ?? 0} series fit → ${f.validated ?? 0} validated edge → ${f.earnings ?? 0} of the top 8 clear of earnings → ${f.final ?? 0} after AI check${out.shadows.length ? ` · ${out.shadows.length} shadow logged` : ''}`);
  L.push(`Data: ${out.feed === 'sip' ? 'consolidated (SIP)' : 'IEX-only'} daily bars. Research signals only; the bot never places orders.`);
  return L.join('\n\n');
}
