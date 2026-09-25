export const TIME_ZONE = 'America/New_York';
export function marketDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function marketMinutes(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value);
}
export const average = a => a.reduce((s, x) => s + x, 0) / a.length;
export function wilder(values, period = 14) {
  if (values.length < period || values.some(x => !Number.isFinite(x))) return null;
  let value = average(values.slice(0, period));
  for (const next of values.slice(period)) value = (value * (period - 1) + next) / period;
  return value;
}
export function dailyIndicators(bars, previousSession) {
  const sorted = [...bars].filter(b => marketDate(new Date(b.t)) <= previousSession).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (sorted.length < 60 || marketDate(new Date(sorted.at(-1).t)) !== previousSession) return null;
  if (new Set(sorted.map(b => b.t)).size !== sorted.length) return null;
  if (sorted.some(b => ![b.o,b.h,b.l,b.c,b.v].every(Number.isFinite) || b.l <= 0 || b.v < 0 || b.h < Math.max(b.o,b.c,b.l) || b.l > Math.min(b.o,b.c))) return null;
  const close = sorted.map(b => b.c);
  const changes = close.slice(1).map((c,i) => c - close[i]);
  const gain = wilder(changes.map(x => Math.max(0,x)));
  const loss = wilder(changes.map(x => Math.max(0,-x)));
  const atr = wilder(sorted.slice(1).map((b,i) => Math.max(b.h-b.l, Math.abs(b.h-close[i]), Math.abs(b.l-close[i]))));
  return {asOf:previousSession,close:close.at(-1),sma20:average(close.slice(-20)),sma50:average(close.slice(-50)),rsi14:loss===0?(gain===0?50:100):100-100/(1+gain/loss),atr14:atr,swingLow:Math.min(...sorted.slice(-5).map(b=>b.l)),resistance:Math.max(...sorted.slice(-60).map(b=>b.h)),averageIexDollarVolume:average(sorted.slice(-20).map(b=>b.c*b.v))};
}
export function stockEligible(asset) {
  return asset.status==='active' && asset.tradable && asset.class==='us_equity' && ['NYSE','NASDAQ','AMEX','ARCA','BATS','NYSEAMERICAN'].includes(asset.exchange) && /^[A-Z][A-Z0-9.]{0,9}$/.test(asset.symbol) && !/\b(ETF|ETN|fund|trust|warrant|rights|preferred|depositary shares|units|leveraged)\b/i.test(asset.name);
}
export function validQuote(snapshot, now = new Date()) {
  const q=snapshot?.latestQuote, t=snapshot?.latestTrade;
  if (!q || !t || ![q.ap,q.bp,t.p].every(x=>Number.isFinite(x)&&x>0) || q.ap<q.bp) return false;
  return [q.t,t.t].every(x=>{const age=now-Date.parse(x);return age>=0&&age<=120000;}) && (q.ap-q.bp)/q.ap<=0.003;
}
export function initialScreen(snapshot, previousSession, now = new Date()) {
  const p=snapshot?.prevDailyBar;
  return validQuote(snapshot,now) && p && marketDate(new Date(p.t))===previousSession && p.c>=5 && p.c*p.v>=2000000;
}
const cents = value => Math.round((value+Number.EPSILON)*100)/100;
export function buildPlan(chart, snapshot, now = new Date()) {
  if (!chart || !validQuote(snapshot,now)) return null;
  const entry=cents(snapshot.latestQuote.ap), atr=chart.atr14, day=snapshot.dailyBar;
  if (!day || marketDate(new Date(day.t))!==marketDate(now) || !Number.isFinite(day.vw) || entry<day.vw) return null;
  if (!(atr>0 && chart.close>chart.sma20 && chart.sma20>chart.sma50 && chart.rsi14>=45 && chart.rsi14<=70 && chart.averageIexDollarVolume>=2000000)) return null;
  if (Math.abs(entry-chart.close)>1.5*atr || entry<chart.sma20) return null;
  const stop=cents(Math.min(chart.swingLow-0.1*atr, entry-1.5*atr));
  const risk=cents(entry-stop), riskPct=risk/entry;
  if (stop<=0 || riskPct<0.005 || riskPct>0.08) return null;
  const target1=cents(entry+2*risk), target2=cents(entry+3*risk);
  if (chart.resistance>entry && chart.resistance<target1) return null;
  const stopLimit=cents(stop-Math.max(0.01,0.1*atr));
  if (stopLimit<=0 || stopLimit>=stop) return null;
  return {entry,stop,stopLimit,target1,target2,riskPerShare:risk,riskPercent:cents(riskPct*100),quoteTime:snapshot.latestQuote.t,validUntil:new Date(now.getTime()+10*60000).toISOString(),method:'Long-only 1–5 session research setup. Stop below the five-session low and at least 1.5 ATR below entry; targets 2R and 3R. These are planning levels, not price forecasts.'};
}
export function probability(answer) {
  const p=answer?.probability;
  return typeof p==='number'&&Number.isFinite(p)&&p>=0&&p<=1?p:null;
}
export function jevPass(answers) {
  const catalyst=probability(answers?.catalyst), supportive=probability(answers?.supportive), conflict=probability(answers?.conflict);
  return catalyst!==null&&supportive!==null&&conflict!==null&&catalyst>=0.8&&supportive>=0.8&&conflict<=0.2;
}
