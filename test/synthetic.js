// Synthetic market generator shared by tests and the offline calibration script.
export function rng(seed = 1) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function normal(u) { return () => { let a = 0; while (!a) a = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u()); }; }
// returns: array of daily log returns; builds OHLCV bars with an overnight/intraday split.
export function barsFromReturns(returns, { seed = 7, start = 100, vol = 0.015, volume = 1e6 } = {}) {
  const n = normal(rng(seed)); const bars = []; let prev = start; const d0 = Date.UTC(2023, 0, 2, 5);
  returns.forEach((r, i) => {
    const on = r * 0.3, o = prev * Math.exp(on), c = o * Math.exp(r - on);
    const h = Math.max(o, c) * Math.exp(Math.abs(n()) * vol * 0.4), l = Math.min(o, c) * Math.exp(-Math.abs(n()) * vol * 0.4);
    bars.push({ t: new Date(d0 + i * 86400000).toISOString(), o, h, l, c, v: volume * (0.7 + 0.6 * rng(seed + i)()) });
    prev = c;
  });
  return bars;
}
export function randomWalk(T, seed, { vol = 0.015, drift = 0 } = {}) { const n = normal(rng(seed)); return Array.from({ length: T }, () => drift + vol * n()); }
export function ar1(T, seed, phi, { vol = 0.015, drift = 0 } = {}) { const n = normal(rng(seed)); const r = [0]; for (let i = 1; i < T; i++) r.push(drift + phi * (r[i - 1] - drift) + vol * n()); return r; }
