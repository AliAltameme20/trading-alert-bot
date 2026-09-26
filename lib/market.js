// Market data for the cloud pipeline: Alpaca (calendar, universe, SIP daily bars, news),
// earnings calendars (Finnhub + Nasdaq), Telegram. Throttled + retried via morning-data.request.
import { request, required, universe as alpacaUniverse } from './morning-data.js';
export { alpacaUniverse as universe };

const DATA = 'https://data.alpaca.markets', PAPER = 'https://paper-api.alpaca.markets';
const url = (base, path, params = {}) => { const u = new URL(path, base); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); return u; };
export const isoDay = d => new Date(d).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000);

// Wall-clock time in New York → UTC instant (DST-safe, no fixed offset).
export function etInstant(date, hhmm) {
  const [h, m] = hhmm.split(':').map(Number), guess = Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const g = k => Number(parts.find(p => p.type === k).value);
  const asIfUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  return new Date(guess - (asIfUtc - guess));
}
export async function calendar(start, end) {
  const days = await request(url(PAPER, '/v2/calendar', { start: isoDay(start), end: isoDay(end) }));
  return days.map(d => ({ date: d.date, open: etInstant(d.date, d.open), close: etInstant(d.date, d.close) }));
}
// Which completed session are we signalling off, and when does the next one open?
export function sessionClock(sessions, now, settleMinutes = 20) {
  const done = sessions.filter(s => s.close.getTime() + settleMinutes * 60000 <= now.getTime());
  const target = done.at(-1), next = sessions.find(s => s.date > (target?.date || ''));
  return { target, next, entryWindowOpen: !!next && now < next.open, future: sessions.filter(s => s.date > (target?.date || '')).map(s => s.date) };
}

// Alpaca's free plan serves consolidated (SIP) history only if the query ends >15 minutes ago.
// A bare date as `end` counts as "up to now" and gets refused, so pass an exact timestamp.
export function endStamp(end, now = Date.now()) {
  return new Date(Math.min(Date.parse(isoDay(end) + 'T23:59:59Z'), now - 16 * 60000)).toISOString();
}
// Daily bars, split+dividend adjusted. SIP (consolidated) first; IEX only if SIP is refused.
export async function dailyBars(symbols, start, end, { feed = 'sip', adjustment = 'all', onProgress = () => {} } = {}) {
  const out = {}; let used = feed;
  for (let i = 0; i < symbols.length; i += 200) {
    const chunk = symbols.slice(i, i + 200); let token, seen = new Set();
    for (let page = 0; page < 500; page++) {
      const p = { symbols: chunk.join(','), timeframe: '1Day', feed: used, adjustment, start: isoDay(start), end: endStamp(end), sort: 'asc', limit: '10000' };
      if (token) p.page_token = token;
      let data;
      try { data = await request(url(DATA, '/v2/stocks/bars', p)); }
      catch (e) { if (used === 'sip' && /HTTP 403/.test(e.message)) { used = 'iex'; page--; token = undefined; continue; } throw e; }
      for (const [s, bars] of Object.entries(data.bars || {})) (out[s] ??= []).push(...bars);
      if (!data.next_page_token) break;
      if (seen.has(data.next_page_token)) throw new Error('Bars pagination repeated'); seen.add(token = data.next_page_token);
    }
    onProgress(`bars: ${Math.min(i + 200, symbols.length)}/${symbols.length} symbols (${used})`);
  }
  for (const s of Object.keys(out)) out[s] = cleanBars(out[s], end);
  return { bars: out, feed: used };
}
// Drop malformed, duplicate or not-yet-completed bars (anything dated after `through`).
export function cleanBars(bars, through) {
  const last = isoDay(through), seen = new Set();
  return bars.filter(b => {
    const d = b.t.slice(0, 10);
    if (d > last || seen.has(d)) return false; seen.add(d);
    return [b.o, b.h, b.l, b.c, b.v].every(Number.isFinite) && b.l > 0 && b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c);
  }).sort((a, b) => a.t.localeCompare(b.t));
}
export async function recentNews(symbol, now, hours = 72) {
  const d = await request(url(DATA, '/v1beta1/news', { symbols: symbol, start: new Date(now - hours * 3600000).toISOString(), end: now.toISOString(), limit: '20', sort: 'desc' }));
  return (d.news || []).filter(n => n.headline && Date.parse(n.created_at) <= now).map(n => ({ headline: n.headline.slice(0, 300), summary: (n.summary || '').replace(/<[^>]*>/g, ' ').slice(0, 400), time: n.created_at, url: n.url, source: n.source }));
}

// Earnings dates for a window of session dates. `verified` = at least one source answered for
// the whole window, so "no date found" genuinely means "not scheduled in the window".
// signalDate (optional) is checked too: a report that day blocks unless a source says it came
// before/during the session (already in the bar) and none says after the close. Unknown timing blocks.
export async function earningsWindow(dates, { fetchImpl = fetch, signalDate } = {}) {
  const bySymbol = new Map(), sameDay = new Map(), sources = [];
  if (signalDate) dates = [signalDate, ...dates.filter(d => d > signalDate)];
  const add = (sym, date, when = '') => {
    sym = String(sym || '').toUpperCase().replace('/', '.'); if (!sym || !date) return;
    if (date === signalDate) { if (!sameDay.has(sym)) sameDay.set(sym, new Set()); sameDay.get(sym).add(when); return; }
    const cur = bySymbol.get(sym); if (!cur || date < cur) bySymbol.set(sym, date);
  };
  const key = process.env.FINNHUB_API_KEY?.trim();
  if (key) {
    try {
      const u = url('https://finnhub.io', '/api/v1/calendar/earnings', { from: dates[0], to: dates.at(-1), token: key });
      const r = await fetchImpl(u, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`Finnhub HTTP ${r.status}`);
      const d = await r.json();
      if (!Array.isArray(d.earningsCalendar)) throw new Error('Finnhub: unexpected payload');
      for (const e of d.earningsCalendar) add(e.symbol, e.date, ['bmo', 'dmh'].includes(e.hour) ? 'inbar' : e.hour === 'amc' ? 'amc' : '');
      sources.push('finnhub');
    } catch (e) { sources.push(`finnhub failed (${e.message.replace(key, '[key]')})`); }
  }
  let nasdaqOk = true;
  for (const date of dates) {
    try {
      const r = await fetchImpl(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, { headers: { 'User-Agent': 'Mozilla/5.0 (research bot)', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const rows = d?.data?.rows;
      if (rows === undefined) throw new Error('unexpected payload');
      for (const row of rows || []) add(row.symbol, date, row.time === 'time-pre-market' ? 'inbar' : row.time === 'time-after-hours' ? 'amc' : '');
    } catch (e) { nasdaqOk = false; sources.push(`nasdaq ${date} failed (${e.message})`); break; }
  }
  if (nasdaqOk) sources.push('nasdaq');
  for (const [sym, when] of sameDay) if (when.has('amc') || !when.has('inbar')) bySymbol.set(sym, signalDate);
  return { bySymbol, verified: sources.includes('finnhub') || nasdaqOk, sources };
}

export async function sendTelegram(text) {
  const parts = [];
  while (text.length > 3900) { const cut = text.lastIndexOf('\n\n', 3900) > 0 ? text.lastIndexOf('\n\n', 3900) : 3900; parts.push(text.slice(0, cut)); text = text.slice(cut).trimStart(); }
  parts.push(text);
  const ids = [];
  for (const part of parts) {
    const r = await fetch(`https://api.telegram.org/bot${required('TELEGRAM_BOT_TOKEN')}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: required('TELEGRAM_CHAT_ID'), text: part, disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(`Telegram HTTP ${r.status}; message not confirmed`);
    ids.push(d.result.message_id);
  }
  return ids;
}
