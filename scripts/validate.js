// Monthly walk-forward validation across the liquid universe → data/validation.json.
// Only (setup, series-character) cells that pass here can ever produce a live signal.
//   node scripts/validate.js [--send]
import { fileURLToPath } from 'node:url';
import * as market from '../lib/market.js';
import { validateUniverse } from '../lib/validate.js';
import { CONFIG, SETUPS, fmtR, median, configForFeed } from '../lib/protocol.js';
import { writeJson, commit } from '../lib/persist.js';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const send = process.argv.includes('--send'), now = new Date();
const N = Number(process.env.VALIDATE_SYMBOLS || 1200);
const sessions = await market.calendar(market.addDays(now, -20), now);
const through = market.sessionClock(sessions, now).target.date;
const iso = d => market.isoDay(d), back = m => { const d = new Date(through + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - m); return iso(d); };
const folds = [{ name: 'year -2', from: back(24), to: back(12) }, { name: 'year -1', from: iso(market.addDays(back(12) + 'T00:00:00Z', 1)), to: through }];

const { assets } = await market.universe();
const { bars: recent, feed: recentFeed } = await market.dailyBars(assets.map(a => a.symbol), market.addDays(through + 'T00:00:00Z', -40), through, { onProgress: console.log });
const cfg = configForFeed(recentFeed);
// [A] universe = today's most liquid names. Survivorship bias: stocks that died in the last
// two years are absent, which flatters every long rule a little.
const ranked = Object.entries(recent).filter(([, b]) => b.length >= 15 && b.at(-1).c >= cfg.minPrice).map(([s, b]) => [s, median(b.slice(-20).map(x => x.c * x.v))]).filter(([, dv]) => dv >= cfg.minDollarAdv).sort((a, b) => b[1] - a[1]).slice(0, N).map(([s]) => s);
const start = market.addDays(folds[0].from + 'T00:00:00Z', -1150);
const { bars, feed } = await market.dailyBars([...ranked, 'SPY'], start, through, { onProgress: console.log });
const spy = bars.SPY; delete bars.SPY;
const { cells, counts } = validateUniverse(bars, spy, folds, configForFeed(feed), { onProgress: console.log });
const validation = { generatedAt: now.toISOString(), dataThrough: through, feed, feedWarning: feed === 'iex' ? 'Alpaca refused consolidated data; IEX-only bars used' : undefined, folds, universe: `${counts.symbols} most liquid US stocks today (survivorship-biased)`, signals: counts.signals, config: CONFIG, cells };
await writeJson('data/validation.json', validation);

const lines = [`🧪 MONTHLY VALIDATION · data through ${through} · ${feed === 'sip' ? 'consolidated data' : '⚠️ IEX-only data'} · ${counts.symbols} stocks · ${counts.signals.toLocaleString()} out-of-sample trades`, `Test years: ${folds.map(f => `${f.from}→${f.to}`).join(' and ')}. Costs included. A cell goes live only if BOTH years clear ${fmtR(CONFIG.cellMinAvgR)} with ≥${CONFIG.cellMinTrades} trades and PF ≥ ${CONFIG.cellMinPF}.`];
for (const [k, labels] of Object.entries(cells)) for (const [l, c] of Object.entries(labels))
  lines.push(`${c.pass ? '✅ LIVE' : '⛔ off'} ${SETUPS[k].label} · ${l}: ${c.folds.map(f => `${fmtR(f.avgR)} (n ${f.n})`).join(' | ')} · PF ${Number.isFinite(c.pooled.pf) ? c.pooled.pf.toFixed(2) : 'n/a'}`);
if (!Object.values(cells).some(l => Object.values(l).some(c => c.pass))) lines.push('Result: no setup has out-of-sample edge right now. The bot will send NO trades and keep logging shadow signals until one does.');
lines.push('Caveats: survivorship-biased universe; historical earnings not excluded (live bot blocks them); regime and series character measured point-in-time.');
const message = lines.join('\n\n');
console.log(message);
commit(`validation through ${through}`);
if (send) await market.sendTelegram(message);
