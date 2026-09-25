// Universe-level walk-forward validation. Nothing is fitted: the three setups are fixed in
// protocol.js, so every trade inside a test fold is out-of-sample. Each signal is taken only
// if the point-in-time market regime allowed longs and the point-in-time series character
// (trailing 756 sessions) fits the setup — exactly what the live bot does on that day.
import { CONFIG, SETUPS, prepare, simulateTrade, seriesCharacter, characterFits, judgeCell, tradeStats, rollingMean, yangZhang } from './protocol.js';

export function regimeSeries(spy, cfg = CONFIG) {
  const c = spy.map(b => b.c), ma = rollingMean(c, cfg.regimeMa), yz = yangZhang(spy, cfg.volWindow), out = new Map();
  for (let i = cfg.regimeMa + cfg.regimeSlopeBars; i < spy.length; i++) {
    const hist = yz.slice(Math.max(0, i - 755), i + 1).filter(Number.isFinite);
    const volPct = hist.filter(x => x <= yz[i]).length / hist.length;
    const above = c[i] > ma[i], slope = ma[i] / ma[i - cfg.regimeSlopeBars] - 1;
    const state = above && slope > 0 ? (volPct < cfg.regimeVolPctMax ? 'risk-on' : 'risk-on but unstable') : (!above && slope < 0 ? 'risk-off' : 'transitional');
    out.set(spy[i].t.slice(0, 10), state);
  }
  return out;
}

// folds: [{name, from:'YYYY-MM-DD', to:'YYYY-MM-DD'}], signal dates inclusive.
export function validateUniverse(barsBySymbol, spy, folds, cfg = CONFIG, { onProgress = () => {} } = {}) {
  const regime = regimeSeries(spy, cfg), cells = {}, counts = { symbols: 0, signals: 0 };
  const syms = Object.keys(barsBySymbol);
  syms.forEach((sym, n) => {
    const bars = barsBySymbol[sym]; if (bars.length < 760) return;
    counts.symbols++;
    const s = prepare(bars, cfg), chCache = new Map();
    const character = i => { const k = Math.floor(i / 21); if (!chCache.has(k)) chCache.set(k, seriesCharacter(s.c.slice(Math.max(0, i - 755), i + 1), cfg)); return chCache.get(k); };
    for (const [key, st] of Object.entries(SETUPS)) {
      let busy = -1;
      for (let i = 756; i < bars.length - 1; i++) {
        if (i <= busy) continue;
        const d = bars[i].t.slice(0, 10), f = folds.findIndex(x => d >= x.from && d <= x.to);
        if (f === -1) continue;
        const reg = regime.get(d); if (!reg || !reg.startsWith('risk-on')) continue;
        const plan = st.at(s, i, cfg); if (!plan) continue;
        const ch = character(i); if (!characterFits(st.family, ch, cfg)) continue;
        const res = simulateTrade(plan, bars.slice(i + 1, i + 1 + plan.maxSessions), cfg);
        if (res.status !== 'closed') continue;
        busy = i + res.sessions; counts.signals++;
        (((cells[key] ??= {})[ch.label] ??= folds.map(() => [])))[f].push(res.r);
      }
    }
    if (n % 100 === 99) onProgress(`validated ${n + 1}/${syms.length} symbols`);
  });
  const result = {};
  for (const [key, labels] of Object.entries(cells)) for (const [label, fr] of Object.entries(labels)) {
    const foldStats = fr.map(rs => ({ ...tradeStats(rs), rs }));
    const j = judgeCell(foldStats, cfg);
    (result[key] ??= {})[label] = { pass: j.pass, fails: j.fails, pooled: j.pooled, folds: foldStats.map(({ rs, ...x }) => x) };
  }
  return { cells: result, counts };
}
