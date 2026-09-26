// Offline calibration on synthetic markets where the right answer is known in advance.
// Question: does the universe-level validation (the same judgeCell used live) switch a cell ON
// for pure noise? It must not. And does it switch ON when real structure exists?
// Usage: node scripts/calibrate.js [stocks per universe] [universes]
import { CONFIG, SETUPS, prepare, attachMomentumRanks, simulateTrade, seriesCharacter, characterFits, judgeCell, tradeStats } from '../lib/protocol.js';
import { barsFromReturns, randomWalk, ar1 } from '../test/synthetic.js';

const N = +process.argv[2] || 120, U = +process.argv[3] || 5;
function universe(gen, seed0) {
  // two OOS folds of 250 sessions each after 760 sessions of history
  const cells = {};
  const all = {};
  for (let s = 0; s < N; s++) { const seed = seed0 + s; all[seed] = prepare(barsFromReturns(gen(1260, seed), { seed, vol: 0.02, volume: 3e6 })); }
  attachMomentumRanks(all);
  for (let s = 0; s < N; s++) {
    const seed = seed0 + s, sp = all[seed], bars = sp.bars;
    for (const [key, st] of Object.entries(SETUPS)) {
      for (let i = 760, busy = -1; i < 1255; i++) {
        if (i <= busy) continue;
        const plan = st.at(sp, i); if (!plan) continue;
        const ch = seriesCharacter(bars.slice(i - 755, i + 1).map(b => b.c));
        if (!characterFits(st.family, ch)) continue;
        const r = simulateTrade(plan, bars.slice(i + 1, i + 1 + plan.maxSessions));
        if (r.status !== 'closed') continue;
        busy = i + r.sessions;
        const fold = i < 1010 ? 0 : 1;
        ((cells[key] ??= {})[ch.label] ??= [{ rs: [] }, { rs: [] }])[fold].rs.push(r.r);
      }
    }
  }
  const out = {};
  for (const [k, labels] of Object.entries(cells)) for (const [l, folds] of Object.entries(labels)) {
    const f = folds.map(x => ({ ...tradeStats(x.rs), rs: x.rs }));
    out[`${k}/${l}`] = judgeCell(f);
  }
  return out;
}
const scenarios = [
  ['random walk, no drift', (T, s) => randomWalk(T, s, { vol: 0.02 })],
  ['random walk, +10%/yr', (T, s) => randomWalk(T, s, { vol: 0.02, drift: 0.0004 })],
  ['momentum AR(+0.15)', (T, s) => ar1(T, s, 0.15, { vol: 0.02, drift: 0.0004 })],
  ['reversion AR(−0.15)', (T, s) => ar1(T, s, -0.15, { vol: 0.02, drift: 0.0004 })],
];
for (const [name, gen] of scenarios) {
  const enabled = {};
  let pooled = {};
  for (let u = 0; u < U; u++) {
    const res = universe(gen, 1 + u * 100000);
    for (const [cell, j] of Object.entries(res)) { if (j.pass) enabled[cell] = (enabled[cell] || 0) + 1; (pooled[cell] ??= []).push(j.pooled.avgR); }
  }
  console.log(`\n${name}: cells switched ON across ${U} universes of ${N} stocks`);
  for (const cell of Object.keys(pooled).sort()) console.log(`  ${cell.padEnd(28)} on ${enabled[cell] || 0}/${U}   mean OOS avgR ${(pooled[cell].reduce((a, b) => a + b, 0) / pooled[cell].length).toFixed(3)}`);
}
