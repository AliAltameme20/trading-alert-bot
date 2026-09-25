import { experimental_evaluate as evaluate, generateText } from 'ai';
import { isFreshDailyBar, summarizeBars } from './indicators.js';

const MARKET_DATA = 'https://data.alpaca.markets';
const SEC_DATA = 'https://data.sec.gov';
const SEC_SITE = 'https://www.sec.gov';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${new URL(url).host} returned ${response.status}`);
  return response.json();
}

function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID': required('APCA_API_KEY_ID'),
    'APCA-API-SECRET-KEY': required('APCA_API_SECRET_KEY'),
  };
}

async function getBars(symbol) {
  const start = new Date(Date.now() - 150 * 86400000).toISOString();
  const url = new URL(`${MARKET_DATA}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
  url.searchParams.set('timeframe', '1Day');
  url.searchParams.set('feed', 'iex');
  url.searchParams.set('adjustment', 'split');
  url.searchParams.set('start', start);
  url.searchParams.set('sort', 'asc');
  url.searchParams.set('limit', '1000');
  const data = await json(url, { headers: alpacaHeaders() });
  if (data.next_page_token) throw new Error('Price history was incomplete');
  return data.bars || [];
}

async function getNews(symbol) {
  const url = new URL(`${MARKET_DATA}/v1beta1/news`);
  url.searchParams.set('symbols', symbol);
  url.searchParams.set('start', new Date(Date.now() - 7 * 86400000).toISOString());
  url.searchParams.set('limit', '10');
  const data = await json(url, { headers: alpacaHeaders() });
  return (data.news || []).map(item => ({
    headline: item.headline,
    time: item.created_at,
    url: item.url,
    source: item.source,
  })).filter(item => item.headline && item.url && item.time && Date.parse(item.time) <= Date.now());
}

async function getSecTickerMap() {
  const data = await json(`${SEC_SITE}/files/company_tickers.json`, {
    headers: { 'User-Agent': required('SEC_USER_AGENT'), Accept: 'application/json' },
  });
  return new Map(Object.values(data).map(company => [company.ticker, company.cik_str]));
}

async function getForm4(symbol, tickerMap) {
  const cik = tickerMap.get(symbol);
  if (!cik) return [];
  const padded = String(cik).padStart(10, '0');
  const data = await json(`${SEC_DATA}/submissions/CIK${padded}.json`, {
    headers: { 'User-Agent': required('SEC_USER_AGENT'), Accept: 'application/json' },
  });
  const recent = data.filings?.recent;
  if (!recent) return [];
  const since = Date.now() - 30 * 86400000;
  return recent.form.flatMap((form, index) => {
    if (form !== '4' && form !== '4/A') return [];
    const filedAt = recent.filingDate[index];
    if (Date.parse(filedAt) < since) return [];
    const accession = recent.accessionNumber[index].replaceAll('-', '');
    const document = recent.primaryDocument[index];
    return [{
      form,
      filedAt,
      url: `${SEC_SITE}/Archives/edgar/data/${cik}/${accession}/${document}`,
    }];
  }).slice(0, 5);
}

function booleanProbability(answer) {
  if (typeof answer === 'number') return answer;
  if (typeof answer?.probability === 'number') return answer.probability;
  if (typeof answer?.value === 'number') return answer.value;
  if (typeof answer?.answer === 'number') return answer.answer;
  return null;
}

function formatAlert({ symbol, chart, news, filings, decision, explanation }) {
  const headline = news[0];
  const verdict = decision === 'review' ? 'REVIEW CANDIDATE' : 'NO TRADE';
  const lines = [
    `${verdict} — ${symbol} (multi-day research)`,
    `Checked: ${new Date().toISOString()}`,
    `IEX daily close: $${chart.close.toFixed(2)} as of ${chart.barTime}`,
    `SMA20: ${chart.sma20.toFixed(2)} | SMA50: ${chart.sma50.toFixed(2)} | RSI14: ${chart.rsi14.toFixed(1)}`,
    `News: ${headline?.headline || 'None'}${headline?.url ? `\n${headline.url}` : ''}`,
    `Recent public Form 4 filings: ${filings.length}${filings[0] ? `\n${filings[0].url}` : ''}`,
    `Assessment: ${explanation.trim().slice(0, 900)}`,
    'Check current price and tradability in Robinhood before any order. Research alert only; no order was placed.',
  ];
  return lines.join('\n\n').slice(0, 3900);
}

async function evaluateCandidate(symbol, chart, news, filings) {
  const evidence = { symbol, chart, news, filings };
  const result = await evaluate({
    model: 'typesafe-ai/jev',
    state: evidence,
    questions: {
      relevantNews: { type: 'boolean', instructions: 'Does the provided, dated news contain a specific company catalyst relevant to the next few trading days?' },
      chartSupport: { type: 'boolean', instructions: 'Do the provided daily indicators support a constructive multi-day long setup without being clearly overextended?' },
      materialConflict: { type: 'boolean', instructions: 'Is there a material conflict, missing evidence, or stale information that should prevent a trade candidate alert?' },
    },
  });
  const a = result.answers || {};
  const probabilities = {
    relevantNews: booleanProbability(a.relevantNews),
    chartSupport: booleanProbability(a.chartSupport),
    materialConflict: booleanProbability(a.materialConflict),
  };
  // Deliberately conservative pilot thresholds. These are not calibrated win probabilities.
  const passes = chart.trendUp && news.length > 0 &&
    probabilities.relevantNews !== null && probabilities.relevantNews >= 0.8 &&
    probabilities.chartSupport !== null && probabilities.chartSupport >= 0.8 &&
    probabilities.materialConflict !== null && probabilities.materialConflict <= 0.2;
  return { passes, probabilities };
}

async function explainCandidate(symbol, chart, news, filings, assessment) {
  const response = await generateText({
    model: 'openai/gpt-6-astra',
    maxOutputTokens: 240,
    prompt: `Write a concise professional trading research note (maximum 90 words) from only this JSON. State the catalyst, chart support, and strongest contrary factor. If evidence is weak, say so. Do not predict returns, invent facts, or claim an insider bought stock based only on a Form 4 link.\n${JSON.stringify({ symbol, chart, news, filings, assessment })}`,
  });
  return response.text || 'No explanation was returned.';
}

async function sendTelegram(message) {
  const token = required('TELEGRAM_BOT_TOKEN');
  const chatId = required('TELEGRAM_CHAT_ID');
  await json(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
  });
}

export async function runScan() {
  required('APCA_API_KEY_ID');
  required('APCA_API_SECRET_KEY');
  required('AI_GATEWAY_API_KEY');
  required('SEC_USER_AGENT');
  const symbols = (process.env.WATCHLIST || '').split(',').map(value => value.trim().toUpperCase())
    .filter(value => /^[A-Z][A-Z0-9.]{0,7}$/.test(value)).slice(0, 20);
  if (symbols.length === 0) throw new Error('WATCHLIST must contain at least one stock symbol');
  const tickerMap = await getSecTickerMap();
  const results = [];
  for (const symbol of symbols) {
    try {
      const [bars, news, filings] = await Promise.all([
        getBars(symbol), getNews(symbol), getForm4(symbol, tickerMap),
      ]);
      const chart = summarizeBars(bars);
      if (!chart || !isFreshDailyBar(chart.barTime)) {
        results.push({ symbol, status: 'skipped', reason: 'Missing or stale daily prices' });
        continue;
      }
      if (news.length === 0) {
        results.push({ symbol, status: 'skipped', reason: 'No sourced news in the last seven days' });
        continue;
      }
      const assessment = await evaluateCandidate(symbol, chart, news, filings);
      const status = assessment.passes ? 'review' : 'no-trade';
      if (status === 'review') {
        const explanation = await explainCandidate(symbol, chart, news, filings, assessment);
        const message = formatAlert({ symbol, chart, news, filings, decision: status, explanation });
        if (process.env.ALERTS_ENABLED === 'true') await sendTelegram(message);
      }
      results.push({ symbol, status, probabilities: assessment.probabilities });
    } catch (error) {
      results.push({ symbol, status: 'skipped', reason: error.message });
    }
  }
  return { checkedAt: new Date().toISOString(), sent: process.env.ALERTS_ENABLED === 'true', results };
}
