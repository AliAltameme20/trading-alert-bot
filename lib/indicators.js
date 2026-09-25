export function sma(values, period) {
  if (values.length < period) return null;
  const sample = values.slice(-period);
  return sample.reduce((sum, value) => sum + value, 0) / period;
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const sample = closes.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < sample.length; i++) {
    const change = sample[i] - sample[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  const ratio = gains / losses;
  return 100 - 100 / (1 + ratio);
}

export function summarizeBars(bars) {
  if (!Array.isArray(bars) || bars.length < 50) return null;
  const sorted = [...bars].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const closes = sorted.map(bar => Number(bar.c));
  const last = sorted.at(-1);
  if (closes.some(value => !Number.isFinite(value) || value <= 0)) return null;
  return {
    barTime: last.t,
    close: Number(last.c),
    volume: Number(last.v),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi14: rsi(closes, 14),
    trendUp: closes.at(-1) > sma(closes, 20) && sma(closes, 20) > sma(closes, 50),
  };
}

export function isFreshDailyBar(barTime, now = new Date()) {
  const age = now.getTime() - Date.parse(barTime);
  return Number.isFinite(age) && age >= 0 && age <= 5 * 24 * 60 * 60 * 1000;
}
