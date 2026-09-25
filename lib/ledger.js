// Durable record of every signal (live and shadow) and its scored outcome, plus the
// live kill switch. Outcomes are scored with the SAME simulateTrade() the validation uses.
import { simulateTrade, tradeStats, CONFIG } from './protocol.js';

export const KILL = { window: 20, minClosed: 15, pauseBelowAvgR: 0, resumeAboveAvgR: 0.05 }; // [A]

export function emptyLedger() { return { version: 1, signals: [], pause: { paused: false } }; }

export function addSignal(ledger, { symbol, setup, label, character, asOf, plan, kind, sizing, createdAt = new Date().toISOString() }) {
  const id = `${asOf}:${symbol}:${setup}`;
  if (ledger.signals.some(s => s.id === id)) return null;
  const keep = ['limit', 'stop', 'target', 'maxSessions', 'exitAboveSma', 'prevCloses', 'riskPerShare', 'close', 'atr'];
  const rec = { id, symbol, setup, label, character, asOf, createdAt, kind, plan: Object.fromEntries(keep.filter(k => plan[k] !== undefined).map(k => [k, plan[k]])), sizing: sizing || null, status: 'pending' };
  ledger.signals.push(rec);
  return rec;
}

// barsBySymbol: completed daily bars. Returns the signals whose status changed this run.
export function resolve(ledger, barsBySymbol, cfg = CONFIG) {
  const changed = [];
  for (const s of ledger.signals) {
    if (['closed', 'nofill'].includes(s.status)) continue;
    const bars = barsBySymbol[s.symbol]; if (!bars) continue;
    const after = bars.filter(b => b.t.slice(0, 10) > s.asOf);
    const res = simulateTrade(s.plan, after, cfg);
    if (res.status === 'pending') continue;
    const before = s.status;
    s.status = res.status; s.result = res;
    if (before !== s.status || res.status === 'closed') changed.push(s);
  }
  return changed;
}

// "Would-have-been-live" signals: live ones plus those withheld only because of a pause.
const counted = s => s.kind === 'live' || s.kind === 'paused';
export function liveStats(ledger, { window = Infinity, kinds = ['live'] } = {}) {
  const closed = ledger.signals.filter(s => kinds.includes(s.kind) && s.status === 'closed').sort((a, b) => a.result.exitDate.localeCompare(b.result.exitDate));
  return tradeStats(closed.slice(-window).map(s => s.result.r));
}
export function updateKillSwitch(ledger, now = new Date()) {
  const recent = ledger.signals.filter(s => counted(s) && s.status === 'closed').sort((a, b) => a.result.exitDate.localeCompare(b.result.exitDate)).slice(-KILL.window);
  const st = tradeStats(recent.map(s => s.result.r)), p = ledger.pause;
  if (!p.paused && st.n >= KILL.minClosed && st.avgR < KILL.pauseBelowAvgR) {
    ledger.pause = { paused: true, since: now.toISOString(), reason: `last ${st.n} signals averaged ${st.avgR.toFixed(2)}R` };
    return 'paused';
  }
  if (p.paused && st.n >= KILL.minClosed && st.avgR > KILL.resumeAboveAvgR) {
    ledger.pause = { paused: false, resumedAt: now.toISOString(), reason: `last ${st.n} signals recovered to ${st.avgR.toFixed(2)}R` };
    return 'resumed';
  }
  return null;
}
export function openSymbols(ledger) { return new Set(ledger.signals.filter(s => s.kind === 'live' && ['pending', 'open'].includes(s.status)).map(s => s.symbol)); }
