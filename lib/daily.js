// One run = one completed session. Resolve the ledger, read every liquid stock through the
// protocol, keep only validated-edge candidates, apply earnings + AI veto, format one message.
// Services are injected so the whole pipeline runs offline in tests.
import { CONFIG, SETUPS, marketRegime, readSymbol, sessionsUntil, fmtR, median, configForFeed } from './protocol.js';
import { addSignal, resolve, liveStats, updateKillSwitch, openSymbols } from './ledger.js';
import { addDays } from './market.js';

const money = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

export async function runDaily({ now = new Date(), services, ledger, validation, settings = {}, cfg = CONFIG, log = () => {} }) {
  // cfg is re-bound below once we know which data feed Alpaca granted
  const S = { equity: 10000, riskPct: 0.005, maxNew: 1, maxOpen: 3, shadowPerDay: 3, ...settings };
  const out = { status: 'no-signal', funnel: {}, signals: [], shadows: [], exits: [], vetoed: [] };

  const sessions = await services.calendar(addDays(now, -1200), addDays(now, 20));
  const clock = services.sessionClock(sessions, now);
  if (!clock.target) throw new Error('No completed session found');
  out.session = clock.target.date; out.nextSession = clock.next?.date;
  if (!clock.entryWindowOpen) { out.status = 'missed'; return out; }
  const through = clock.target.date, histStart = addDays(through + 'T00:00:00Z', -1150);

  // 1. score what already happened
  const ledgerSyms = [...new Set(ledger.signals.filter(s => ['pending', 'open'].includes(s.status)).map(s => s.symbol))];
  if (ledgerSyms.length) {
    const since = ledger.signals.filter(s => ['pending', 'open'].includes(s.status)).map(s => s.asOf).sort()[0];
    const { bars } = await services.dailyBars(ledgerSyms, addDays(since + 'T00:00:00Z', -10), through);
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

  const reads = [];
  for (const sym of liquid) {
    const bars = hist[sym]; if (!bars || bars.length < 220) continue;
    reads.push(readSymbol({ symbol: sym, bars, spy, regime, validation, cfg, equity: S.equity, riskPct: S.riskPct, now }));
  }
  const withSetup = reads.filter(r => r.stage !== 'liquidity' && r.stage !== 'setup');
  out.funnel.setup = withSetup.length;
  out.funnel.character = withSetup.filter(r => r.stage !== 'character').length;
  const cands = reads.filter(r => r.candidates.length).sort((a, b) => b.rank - a.rank || b.dollarAdv - a.dollarAdv);
  out.funnel.validated = cands.length;

  // 4. earnings (fail-closed) + AI veto on the top few only
  const held = openSymbols(ledger), room = Math.max(0, S.maxOpen - held.size);
  const window = clock.future.slice(0, cfg.earningsBlockSessions + 1);
  const pool = cands.filter(r => !held.has(r.symbol)).slice(0, 8);
  const earn = pool.length ? await services.earningsWindow(window) : { verified: true, bySymbol: new Map(), sources: [] };
  out.earningsSources = earn.sources;
  const passedEarnings = [];
  for (const r of pool) {
    const d = earn.bySymbol.get(r.symbol);
    const n = d ? sessionsUntil(d, clock.future) : Infinity;
    if (!earn.verified && cfg.earningsUnknownBlocks) { out.vetoed.push({ symbol: r.symbol, why: 'earnings date unverifiable — withheld (fail-closed)' }); continue; }
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
    const rec = addSignal(ledger, { symbol: r.symbol, setup: best.key, label: best.label, character: r.character.label, asOf: through, plan: best.plan, kind, sizing: r.sizing });
    if (rec) out.signals.push({ rec, read: r, name: names.get(r.symbol), best });
  }
  for (const r of reads.filter(x => x.shadow).sort((a, b) => b.dollarAdv - a.dollarAdv).slice(0, S.shadowPerDay)) {
    const rec = addSignal(ledger, { symbol: r.symbol, setup: r.shadow.key, label: SETUPS[r.shadow.key].label, character: r.character.label, asOf: through, plan: r.shadow.plan, kind: 'shadow' });
    if (rec) out.shadows.push(rec);
  }
  out.status = out.signals.length ? (kind === 'live' ? 'signal' : 'paused-signal') : 'no-signal';
  out.enabledCells = validation ? Object.entries(validation.cells || {}).flatMap(([k, l]) => Object.entries(l).filter(([, c]) => c.pass).map(([lab]) => `${k}/${lab}`)) : [];
  return finish(out, ledger);
}
function finish(out, ledger) { out.stats = liveStats(ledger); return out; }

export function formatDaily(out, { test = false } = {}) {
  const L = [], f = out.funnel;
  L.push(`${test ? 'TEST — ' : ''}📈 SIGNALS for ${day(out.nextSession)} open · from ${day(out.session)} close`);
  const R = out.regime;
  if (R) L.push(`Market: ${R.state} — SPY ${R.above ? 'above' : 'below'} 200-day (slope ${(R.slope * 100).toFixed(1)}%/mo), volatility percentile ${Math.round(R.volPct * 100)}`);
  if (out.kill === 'paused') L.push(`⛔ AUTO-PAUSED: ${out.paused && 'live results turned negative'} — signals below are logged, NOT for trading, until the record recovers.`);
  if (out.kill === 'resumed') L.push('✅ Auto-pause lifted: forward results recovered.');
  if (out.status === 'regime-block') L.push('NO TRADE — the market regime does not support new longs. Every long setup degrades together in this tape.');
  for (const { rec, read, name, best } of out.signals) {
    const p = best.plan, c = best.cell, z = read.character.z;
    L.push([
      `${rec.kind === 'paused' ? '[PAUSED — do not trade] ' : ''}BUY LIMIT ${rec.symbol} @ ${money(p.limit)} — day order, skip if unfilled`,
      `${name || ''}`.trim(),
      `Setup: ${best.label} · series ${read.character.label}${Number.isFinite(z) ? ` (z* ${z.toFixed(2)})` : ''}`,
      `Stop ${money(p.stop)} (1R = ${money(p.riskPerShare)}/sh)` + (p.target ? ` · Target ${money(p.target)}` : ` · Exit on first close above 5-day avg`) + ` · Max ${p.maxSessions} sessions`,
      `Size: ${read.sizing.shares} sh (${money(read.sizing.notional)}) → ${money(read.sizing.shares * p.riskPerShare)} at risk if stopped (budget ${money(read.sizing.riskDollars)})`,
      `Edge: ${c.pooled.n.toLocaleString()} out-of-sample trades in this setup×series cell averaged ${fmtR(c.pooled.avgR)} after costs (PF ${c.pooled.pf.toFixed(2)}), positive in both test years.`,
      `This stock's own history with the rule: ${read.stockHistory.n} trades, ${fmtR(read.stockHistory.avgR)} (info only — too few to judge).`,
      `Earnings: ${read.earnings}. AI check: ${read.ai.why}.`,
      ...read.notes.map(n => `Note: ${n}`),
      read.news?.[0] ? `News: ${read.news[0].headline}\n${read.news[0].url}` : 'News: none in 72h',
    ].filter(Boolean).join('\n'));
  }
  if (!out.signals.length && out.status !== 'regime-block') {
    const why = !out.enabledCells?.length ? 'No setup has validated out-of-sample edge yet, so nothing is sent as a trade.' : out.vetoed.length ? 'Candidates existed but were withheld (below).' : 'No stock passed every gate today.';
    L.push(`NO TRADE — ${why}`);
  }
  if (out.vetoed.length) L.push('Withheld:\n' + out.vetoed.slice(0, 6).map(v => `• ${v.symbol}: ${v.why}`).join('\n'));
  const closed = out.exits.filter(s => s.status === 'closed' && s.kind === 'live'), filled = out.exits.filter(s => s.status === 'open' && s.kind === 'live'), nofill = out.exits.filter(s => s.status === 'nofill' && s.kind === 'live');
  if (closed.length || filled.length || nofill.length) L.push('Your signals:\n' + [
    ...closed.map(s => `• ${s.symbol} closed ${s.result.reason} ${fmtR(s.result.r)} (${s.result.entryDate} → ${s.result.exitDate})`),
    ...filled.map(s => `• ${s.symbol} filled ${money(s.result.entry)}, now ${fmtR(s.result.markR)} — stop ${money(s.plan.stop)} stays`),
    ...nofill.map(s => `• ${s.symbol} not filled — cancelled`)].join('\n'));
  const st = out.stats;
  L.push(st?.n ? `Live record: ${st.n} closed · avg ${fmtR(st.avgR)} · win ${Math.round(st.winRate * 100)}% · PF ${Number.isFinite(st.pf) ? st.pf.toFixed(2) : '∞'}` : 'Live record: no closed signals yet.');
  if (f.universe) L.push(`Funnel: ${f.universe} stocks → ${f.liquid ?? 0} liquid → ${f.setup ?? 0} with a setup → ${f.character ?? 0} series fit → ${f.validated ?? 0} validated edge → ${f.earnings ?? 0} of the top 8 clear of earnings → ${f.final ?? 0} after AI check${out.shadows.length ? ` · ${out.shadows.length} shadow logged` : ''}`);
  L.push(`Data: ${out.feed === 'sip' ? 'consolidated (SIP)' : 'IEX-only'} daily bars. Research signals, no orders placed. Place the stop as a GTC order with your broker; a gap can fill below it.`);
  return L.join('\n\n');
}
