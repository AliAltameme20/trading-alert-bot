// Stock Readout Protocol, ported to the bot. Pure functions over Alpaca daily bars
// ({t,o,h,l,c,v}), oldest first, split+dividend adjusted, COMPLETED sessions only.
//
// A signal is sent only when every gate passes, in this order:
//   liquidity → market regime → a pre-registered setup fires → series character fits the
//   setup's family → that (setup, character) cell has VALIDATED out-of-sample edge across the
//   universe (scripts/validate.js) → earnings not inside 5 sessions (fail-closed) → AI veto.
// Edge is measured across the whole universe, not per stock: a single stock produces only
// ~6 setups in three years, far too few to tell skill from luck (see scripts/calibrate.js).
// The same simulateTrade() scores the validation backtest AND the live ledger, so the edge
// the gate measured is the edge the ledger tracks.
//
// Thresholds marked [A] are assumptions, not derived values. Change them here only.

export const CONFIG = {
  // 00 liquidity (consolidated SIP dollar volume)
  minPrice: 5,
  minDollarAdv: 20e6,          // [A] median 20-session dollar volume (consolidated)
  iexVolumeShare: 0.025,       // [A] IEX prints ~2–3% of US volume; scales the gate if SIP is refused
  maxOrderPctAdv: 0.01,
  // 01 regime (SPY)
  regimeMa: 200, regimeSlopeBars: 21, regimeVolPctMax: 0.80, volWindow: 20,
  // 02 relative strength
  rsLookback: 126, betaWindow: 252, highR2: 0.70,
  // 03 volatility
  atrPeriod: 14,
  // 04 series character
  vrQ: 10, vrZ: 2.0, vrMinBars: 500, overnightShareMax: 0.55,
  // shared execution assumptions
  limitAtr: 0.25,              // [A] buy limit = close + 0.25 ATR, day order — never chase
  minRiskPct: 0.005, maxRiskPct: 0.08,
  costPct: 0.0005,             // [A] 5 bps per side slippage+fees
  // validated-edge gate, per (setup, character) cell, out-of-sample across the universe
  cellMinTrades: 150,          // [A] per fold
  cellMinAvgR: 0.05,           // [A] net of costs, in every fold
  cellMinPF: 1.15,             // [A] pooled
  validationMaxAgeDays: 45,
  // 09 events
  earningsBlockSessions: 5,
  earningsUnknownBlocks: true, // fail closed: no verified date → no signal
};

// Liquidity gate measured on the feed actually used.
export function configForFeed(feed, cfg = CONFIG) {
  return feed === 'iex' ? { ...cfg, minDollarAdv: cfg.minDollarAdv * cfg.iexVolumeShare } : cfg;
}

// ------------------------------------------------------------------ math
export const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
export function sd(a) { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
export function median(a) { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }

export function rollingMean(a, n) {
  const out = new Array(a.length).fill(NaN); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}
export function ema(a, span) {
  const k = 2 / (span + 1), out = new Array(a.length); out[0] = a[0];
  for (let i = 1; i < a.length; i++) out[i] = a[i] * k + out[i - 1] * (1 - k);
  return out;
}
// Wilder smoothing: seed with the simple mean of the first n values, then (prev*(n-1)+x)/n.
export function wilderSeries(a, n) {
  const out = new Array(a.length).fill(NaN); if (a.length < n) return out;
  let v = mean(a.slice(0, n)); out[n - 1] = v;
  for (let i = n; i < a.length; i++) { v = (v * (n - 1) + a[i]) / n; out[i] = v; }
  return out;
}
export function atrSeries(bars, n = 14) {
  const tr = bars.slice(1).map((b, i) => Math.max(b.h - b.l, Math.abs(b.h - bars[i].c), Math.abs(b.l - bars[i].c)));
  const w = wilderSeries(tr, n), out = new Array(bars.length).fill(NaN);
  w.forEach((v, i) => { out[i + 1] = v; });
  return out;
}
export function rsiSeries(closes, n = 14) {
  const ch = closes.slice(1).map((c, i) => c - closes[i]);
  const g = wilderSeries(ch.map(x => Math.max(0, x)), n), l = wilderSeries(ch.map(x => Math.max(0, -x)), n);
  const out = new Array(closes.length).fill(NaN);
  for (let i = 0; i < ch.length; i++) if (Number.isFinite(g[i])) out[i + 1] = l[i] === 0 ? (g[i] === 0 ? 50 : 100) : 100 - 100 / (1 + g[i] / l[i]);
  return out;
}
// Yang–Zhang volatility (annualised): overnight + open-to-close + Rogers–Satchell.
export function yangZhang(bars, n = 20) {
  const out = new Array(bars.length).fill(NaN), k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const on = [], oc = [], rs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], o = Math.log(b.o), h = Math.log(b.h), l = Math.log(b.l), c = Math.log(b.c);
    on.push(o - Math.log(bars[i - 1].c)); oc.push(c - o); rs.push((h - c) * (h - o) + (l - c) * (l - o));
    if (on.length >= n) {
      const w = x => x.slice(-n), v = sd(w(on)) ** 2 + k * sd(w(oc)) ** 2 + (1 - k) * mean(w(rs));
      out[i] = Math.sqrt(Math.max(v, 0) * 252);
    }
  }
  return out;
}

// Lo–MacKinlay (1988) overlapping variance ratio, bias-corrected, with the
// heteroskedasticity-robust z*(q). Default is random walk; |z*| must exceed 2 to argue out of it.
export function varianceRatio(closes, q = 10) {
  const p = closes.map(Math.log), r = p.slice(1).map((x, i) => x - p[i]), T = r.length, mu = mean(r);
  const e = r.map(x => x - mu), ss = e.reduce((s, x) => s + x * x, 0);
  const sigA = ss / (T - 1);
  let sq = 0; for (let t = q; t < p.length; t++) { const d = p[t] - p[t - q] - q * mu; sq += d * d; }
  const m = q * (T - q + 1) * (1 - q / T), sigC = sq / m, vr = sigC / sigA;
  let theta = 0;
  for (let j = 1; j < q; j++) {
    let s = 0; for (let t = j; t < T; t++) s += e[t] ** 2 * e[t - j] ** 2;
    theta += (2 * (q - j) / q) ** 2 * (s / ss ** 2);
  }
  const z = (vr - 1) / Math.sqrt(theta), se = Math.sqrt(2 * (2 * q - 1) * (q - 1) / (3 * q * T));
  return { vr, z, se, bars: closes.length };
}
export function seriesCharacter(closes, cfg = CONFIG) {
  if (closes.length < cfg.vrMinBars) return { label: 'insufficient', bars: closes.length };
  const v = varianceRatio(closes, cfg.vrQ);
  return { ...v, label: v.z > cfg.vrZ ? 'trending' : v.z < -cfg.vrZ ? 'mean-reverting' : 'random walk' };
}
export function characterAllows(ch, cfg = CONFIG) {
  if (ch.label === 'insufficient') return false;
  if (cfg.characterGate === 'require-trending') return ch.label === 'trending';
  return ch.label !== 'mean-reverting';
}
export function overnightShare(bars) {
  let on = 0, intra = 0;
  for (let i = 1; i < bars.length; i++) { on += Math.abs(Math.log(bars[i].o / bars[i - 1].c)); intra += Math.abs(Math.log(bars[i].c / bars[i].o)); }
  return on / (on + intra);
}

// ------------------------------------------------------------------ context stages
export function marketRegime(spy, cfg = CONFIG) {
  const c = spy.map(b => b.c), ma = rollingMean(c, cfg.regimeMa), i = c.length - 1;
  const above = c[i] > ma[i], slope = ma[i] / ma[i - cfg.regimeSlopeBars] - 1;
  const yz = yangZhang(spy, cfg.volWindow).filter(Number.isFinite), cur = yz.at(-1);
  const volPct = yz.filter(x => x <= cur).length / yz.length;
  let state = 'transitional';
  if (above && slope > 0) state = volPct < cfg.regimeVolPctMax ? 'risk-on' : 'risk-on but unstable';
  else if (!above && slope < 0) state = 'risk-off';
  return { state, above, slope, volPct, asOf: spy.at(-1).t, allowsLongs: state.startsWith('risk-on'), riskScale: state === 'risk-on' ? 1 : 0.5 };
}
export function relativeStrength(bars, spy, cfg = CONFIG) {
  const sp = new Map(spy.map(b => [b.t.slice(0, 10), b.c]));
  const pairs = bars.filter(b => sp.has(b.t.slice(0, 10))).map(b => [b.c, sp.get(b.t.slice(0, 10))]);
  if (pairs.length < cfg.rsLookback + 2) return null;
  const n = pairs.length - 1, L = cfg.rsLookback;
  const excess = pairs[n][0] / pairs[n - L][0] - pairs[n][1] / pairs[n - L][1];
  const ratio = pairs.map(([a, b]) => a / b), rma = rollingMean(ratio, 50);
  const w = pairs.slice(-cfg.betaWindow - 1), rs = w.slice(1).map((x, i) => Math.log(x[0] / w[i][0])), rb = w.slice(1).map((x, i) => Math.log(x[1] / w[i][1]));
  const ms = mean(rs), mb = mean(rb); let cov = 0, vb = 0, vs = 0;
  for (let i = 0; i < rs.length; i++) { cov += (rs[i] - ms) * (rb[i] - mb); vb += (rb[i] - mb) ** 2; vs += (rs[i] - ms) ** 2; }
  const corr = cov / Math.sqrt(vb * vs);
  return { excess, ratioAbove: ratio[n] > rma[n], beta: cov / vb, corr, r2: corr * corr };
}

// ------------------------------------------------------------------ setups (pre-registered)
// Three rules, fixed before any validation run. Adding rules, or tuning these numbers after
// seeing validation results, turns validation into curve-fitting — don't.
export function prepare(bars, cfg = CONFIG) {
  const c = bars.map(b => b.c);
  const high20 = bars.map((_, i) => i < 20 ? NaN : Math.max(...bars.slice(i - 20, i).map(x => x.h)));
  return { bars, c, sma5: rollingMean(c, 5), sma20: rollingMean(c, 20), sma50: rollingMean(c, 50), sma200: rollingMean(c, 200),
    rsi: rsiSeries(c, 14), rsi2: rsiSeries(c, 2), atr: atrSeries(bars, cfg.atrPeriod), dv: bars.map(b => b.c * b.v), high20 };
}
const cents = v => Math.round((v + Number.EPSILON) * 100) / 100;
function basePlan(s, i, cfg) {
  const b = s.bars[i], atr = s.atr[i];
  if (i < 200 || !(atr > 0) || !(b.c >= cfg.minPrice)) return null;
  if (median(s.dv.slice(i - 19, i + 1)) < cfg.minDollarAdv) return null;
  return { asOf: b.t.slice(0, 10), close: b.c, atr, limit: cents(b.c + cfg.limitAtr * atr) };
}
function finish(p, stop, targetR, maxSessions, cfg, extra = {}) {
  stop = cents(stop);
  const risk = p.limit - stop, riskPct = risk / p.limit;
  if (stop <= 0 || riskPct < cfg.minRiskPct || riskPct > cfg.maxRiskPct) return null;
  return { ...p, stop, riskPerShare: cents(risk), riskPct, target: targetR ? cents(p.limit + targetR * risk) : null, maxSessions, ...extra };
}
export const SETUPS = {
  // The bot's original rule, moved to completed bars.
  pullback: {
    family: 'trend', label: 'Trend pullback (1–5 sessions)',
    at(s, i, cfg = CONFIG) {
      const p = basePlan(s, i, cfg); if (!p) return null;
      const c = p.close, atr = p.atr;
      if (!(c > s.sma20[i] && s.sma20[i] > s.sma50[i])) return null;
      if (!(s.rsi[i] >= 45 && s.rsi[i] <= 70) || c - s.sma20[i] > 2 * atr) return null;
      const swingLow = Math.min(...s.bars.slice(i - 4, i + 1).map(x => x.l));
      const plan = finish(p, Math.min(swingLow - 0.1 * atr, p.limit - 1.5 * atr), 2, 5, cfg);
      if (!plan) return null;
      // Original rule rejected any 60-bar high below 2R; in an uptrend that is nearly always true,
      // so the rule could almost never fire (calibrate.js: 100% rejected). [A] Now only overhead
      // supply inside the first 1R blocks the trade. Changed BEFORE any real-data validation.
      const resistance = Math.max(...s.bars.slice(i - 59, i + 1).map(x => x.h));
      return resistance > plan.limit && resistance < plan.limit + plan.riskPerShare ? null : plan;
    },
  },
  // Classic 20-day breakout inside a long-term uptrend.
  breakout: {
    family: 'trend', label: '20-day breakout (≤10 sessions)',
    at(s, i, cfg = CONFIG) {
      const p = basePlan(s, i, cfg); if (!p) return null;
      if (!(p.close > s.high20[i] && p.close > s.sma50[i] && s.sma50[i] > s.sma200[i] && s.rsi[i] < 80)) return null;
      return finish(p, p.limit - 2 * p.atr, 3, 10, cfg);
    },
  },
  // Short-term oversold dip inside a long-term uptrend; exits on the first close above SMA5.
  dip: {
    family: 'reversion', label: 'RSI(2) dip in uptrend (≤5 sessions)',
    at(s, i, cfg = CONFIG) {
      const p = basePlan(s, i, cfg); if (!p) return null;
      if (!(p.close > s.sma200[i] && s.rsi2[i] < 10)) return null;
      return finish({ ...p, limit: cents(p.close) }, p.close - 2.5 * p.atr, null, 5, cfg, { exitAboveSma: 5, prevCloses: s.c.slice(i - 3, i + 1) });
    },
  },
};
export function characterFits(family, ch, cfg = CONFIG) {
  if (ch.label === 'insufficient') return false;
  return family === 'trend' ? ch.label !== 'mean-reverting' : ch.label !== 'trending';
}

// after = bars strictly AFTER the signal bar. Conservative: stop wins a same-bar tie.
export function simulateTrade(plan, after, cfg = CONFIG) {
  const d0 = after[0];
  if (!d0) return { status: 'pending' };
  let entry;
  if (d0.o <= plan.limit) entry = d0.o; else if (d0.l <= plan.limit) entry = plan.limit; else return { status: 'nofill', date: d0.t.slice(0, 10) };
  if (entry <= plan.stop) return { status: 'nofill', date: d0.t.slice(0, 10), reason: 'opened at/below stop' };
  const risk = entry - plan.stop;
  const out = (bar, price, reason, k) => ({ status: 'closed', entryDate: d0.t.slice(0, 10), entry, exitDate: bar.t.slice(0, 10), exit: price, reason, sessions: k + 1, r: (price - entry - cfg.costPct * (entry + price)) / risk });
  const closes = [...(plan.prevCloses || [])];
  for (let k = 0; k < Math.min(after.length, plan.maxSessions); k++) {
    const b = after[k], T = plan.target;
    if (k > 0 && b.o <= plan.stop) return out(b, b.o, 'stop (gap)', k);
    if (k > 0 && T && b.o >= T) return out(b, b.o, 'target (gap)', k);
    if (b.l <= plan.stop) return out(b, plan.stop, 'stop', k);
    if (T && b.h >= T && (k > 0 || d0.o <= plan.limit)) return out(b, T, 'target', k);
    closes.push(b.c);
    if (plan.exitAboveSma && closes.length >= plan.exitAboveSma && b.c > mean(closes.slice(-plan.exitAboveSma))) return out(b, b.c, `close > SMA${plan.exitAboveSma}`, k);
    if (k === plan.maxSessions - 1) return out(b, b.c, 'time', k);
  }
  const last = after.at(-1);
  return { status: 'open', entryDate: d0.t.slice(0, 10), entry, mark: last.c, markR: (last.c - entry) / risk, sessions: after.length };
}
export function tradeStats(rs) {
  if (!rs.length) return { n: 0, avgR: NaN, winRate: NaN, pf: NaN, t: NaN };
  const pos = rs.filter(r => r > 0).reduce((s, r) => s + r, 0), neg = -rs.filter(r => r < 0).reduce((s, r) => s + r, 0);
  const s = sd(rs), avg = mean(rs);
  return { n: rs.length, avgR: avg, winRate: rs.filter(r => r > 0).length / rs.length, pf: neg ? pos / neg : Infinity, t: s > 0 ? avg / (s / Math.sqrt(rs.length)) : NaN };
}
// Walk one stock bar by bar, one position per setup at a time, no look-ahead.
export function backtest(bars, setupKey, cfg = CONFIG, { from = 200, to = bars.length - 1, prepared, onSignal } = {}) {
  const s = prepared || prepare(bars, cfg), setup = SETUPS[setupKey], trades = [];
  for (let i = Math.max(from, 200); i < to; i++) {
    const plan = setup.at(s, i, cfg); if (!plan) continue;
    if (onSignal && onSignal(i, plan) === false) continue;
    const res = simulateTrade(plan, bars.slice(i + 1, Math.min(to + 1, i + 1 + plan.maxSessions)), cfg);
    if (res.status === 'closed') { trades.push({ i, date: plan.asOf, ...res }); i += res.sessions; }
  }
  return trades;
}
// Is this (setup, character) cell validated? `validation` is data/validation.json.
export function cellStatus(validation, setupKey, label, now = new Date(), cfg = CONFIG) {
  if (!validation) return { enabled: false, why: 'no validation run yet' };
  const age = (now - Date.parse(validation.generatedAt)) / 86400000;
  if (!(age <= cfg.validationMaxAgeDays)) return { enabled: false, why: `validation is ${Math.round(age)} days old` };
  const cell = validation.cells?.[setupKey]?.[label];
  if (!cell) return { enabled: false, why: 'cell not measured' };
  return { enabled: !!cell.pass, why: cell.pass ? 'validated' : cell.fails.join('; '), cell };
}
export function judgeCell(folds, cfg = CONFIG) {
  const fails = [];
  folds.forEach((f, k) => {
    if (f.n < cfg.cellMinTrades) fails.push(`fold ${k + 1}: ${f.n} trades < ${cfg.cellMinTrades}`);
    else if (!(f.avgR >= cfg.cellMinAvgR)) fails.push(`fold ${k + 1}: ${fmtR(f.avgR)} < ${fmtR(cfg.cellMinAvgR)}`);
  });
  const all = tradeStats(folds.flatMap(f => f.rs || []));
  if (!(all.pf >= cfg.cellMinPF)) fails.push(`profit factor ${Number.isFinite(all.pf) ? all.pf.toFixed(2) : 'n/a'} < ${cfg.cellMinPF}`);
  return { pass: !fails.length, fails, pooled: all };
}
export const fmtR = v => Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}R` : 'n/a';

// Sessions from the signal session to an event date, counted on the exchange calendar.
export function sessionsUntil(dateStr, futureSessions) {
  const idx = futureSessions.findIndex(d => d >= dateStr);
  return idx === -1 ? Infinity : idx + 1;
}

// ------------------------------------------------------------------ full readout for one name
// Cheap stages only (no network). Earnings + AI veto are applied by the caller to survivors.
export function readSymbol({ symbol, bars, spy, regime, validation, cfg = CONFIG, equity, riskPct, now = new Date() }) {
  const r = { symbol, blockers: [], notes: [], candidates: [] };
  const last = bars.at(-1), dv = median(bars.slice(-20).map(b => b.c * b.v));
  r.dollarAdv = dv;
  if (bars.length < 220 || last.c < cfg.minPrice || dv < cfg.minDollarAdv) { r.stage = 'liquidity'; r.blockers.push('00 liquidity/history'); return r; }
  if (!regime.allowsLongs) { r.stage = 'regime'; r.blockers.push(`01 regime ${regime.state}`); return r; }
  const s = prepare(bars, cfg), i = bars.length - 1;
  const fired = Object.entries(SETUPS).map(([k, st]) => [k, st, st.at(s, i, cfg)]).filter(x => x[2]);
  if (!fired.length) { r.stage = 'setup'; r.blockers.push('no setup today'); return r; }
  r.character = seriesCharacter(bars.slice(-756).map(b => b.c), cfg);
  for (const [key, st, plan] of fired) {
    if (!characterFits(st.family, r.character, cfg)) { r.blockers.push(`${key}: 04 series ${r.character.label}`); continue; }
    const cell = cellStatus(validation, key, r.character.label, now, cfg);
    if (!cell.enabled) { r.blockers.push(`${key}: edge not validated (${cell.why})`); r.shadow = { key, plan, cell }; continue; }
    r.candidates.push({ key, label: st.label, plan, cell: cell.cell });
  }
  r.stage = r.candidates.length ? 'passed-quant' : (r.blockers.some(b => b.includes('04 series')) && !r.shadow ? 'character' : 'edge');
  if (!r.candidates.length) return r;
  r.candidates.sort((a, b) => b.cell.pooled.t - a.cell.pooled.t);
  const best = r.candidates[0], plan = best.plan;
  r.rs = relativeStrength(bars, spy, cfg);
  if (r.rs && r.rs.r2 > cfg.highR2) r.notes.push(`R² ${r.rs.r2.toFixed(2)} vs SPY — mostly index exposure`);
  if (r.rs && r.rs.excess > 0 && !r.rs.ratioAbove) r.notes.push('beat SPY over 6 months but losing ground now');
  r.overnight = overnightShare(bars.slice(-252));
  if (r.overnight > cfg.overnightShareMax) r.notes.push(`${Math.round(r.overnight * 100)}% of movement is overnight gaps — stop can fill well below trigger`);
  if (regime.riskScale < 1) r.notes.push(`regime ${regime.state}: risk halved`);
  const hist = backtest(bars, best.key, cfg, { prepared: s });
  r.stockHistory = tradeStats(hist.map(t => t.r));
  const riskDollars = equity * riskPct * regime.riskScale;
  let shares = Math.floor(riskDollars / plan.riskPerShare);
  const cap = Math.floor(cfg.maxOrderPctAdv * dv / plan.limit);
  if (shares > cap) { shares = cap; r.notes.push('size capped at 1% of dollar volume'); }
  r.sizing = { riskPct: riskPct * regime.riskScale, riskDollars, shares, notional: shares * plan.limit };
  r.rank = best.cell.pooled.t;
  return r;
}
