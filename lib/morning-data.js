import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { marketDate, stockEligible } from './morning-strategy.js';
const DATA='https://data.alpaca.markets', PAPER='https://paper-api.alpaca.markets';
let lastRequest=0;
export const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function required(name) { const value=process.env[name]?.trim(); if(!value)throw new Error(`Missing ${name}`); return value; }
export async function request(url, {sec=false,raw=false}={}) {
  await pause(Math.max(0,360-(Date.now()-lastRequest))); lastRequest=Date.now();
  const headers=sec?{'User-Agent':required('SEC_USER_AGENT'),Accept:raw?'application/xml':'application/json'}:{'APCA-API-KEY-ID':required('APCA_API_KEY_ID'),'APCA-API-SECRET-KEY':required('APCA_API_SECRET_KEY')};
  for(let attempt=0;attempt<3;attempt++) {
    const r=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
    if((r.status===429||r.status>=500)&&attempt<2){await pause(2000*(attempt+1));continue;}
    if(!r.ok)throw new Error(`${new URL(url).host} HTTP ${r.status}`);
    return raw?r.text():r.json();
  }
}
function endpoint(base,path,params={}) { const u=new URL(path,base);for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);return u; }
export async function sessions(now) {
  const date=marketDate(now), start=new Date(now-14*86400000).toISOString().slice(0,10);
  const days=await request(endpoint(PAPER,'/v2/calendar',{start,end:date}));
  return {today:days.find(d=>d.date===date),previous:days.filter(d=>d.date<date).at(-1)?.date};
}
export async function universe() {
  const all=await request(endpoint(PAPER,'/v2/assets',{status:'active',asset_class:'us_equity'}));
  if(!Array.isArray(all)||all.length<1000)throw new Error('Incomplete asset universe');
  return {total:all.length,assets:all.filter(stockEligible).sort((a,b)=>a.symbol.localeCompare(b.symbol)),excluded:all.filter(a=>!stockEligible(a)).map(a=>({symbol:a.symbol,reason:'Not an active tradable exchange-listed stock under the documented name filters'}))};
}
export async function snapshots(symbols,onProgress=()=>{}) {
  const result={};
  for(let i=0;i<symbols.length;i+=150) {
    Object.assign(result,await request(endpoint(DATA,'/v2/stocks/snapshots',{symbols:symbols.slice(i,i+150).join(','),feed:'iex'})));
    if(i%1500===0)onProgress(`Snapshots requested for ${Math.min(i+150,symbols.length)}/${symbols.length} eligible symbols`);
  }
  return result;
}
export async function news(now) {
  const items=new Map(), seen=new Set();let token;
  for(let page=0;page<100;page++) {
    const p={start:new Date(now-72*3600000).toISOString(),end:now.toISOString(),limit:'50',sort:'desc',include_content:'false',exclude_contentless:'false'};
    if(token)p.page_token=token;
    const data=await request(endpoint(DATA,'/v1beta1/news',p));
    for(const item of data.news||[]) if(item.headline&&item.url&&Date.parse(item.created_at)<=now)items.set(item.id,{id:item.id,headline:item.headline.slice(0,350),summary:(item.summary||'').replace(/<[^>]*>/g,' ').slice(0,500),time:item.created_at,url:item.url,source:item.source,symbols:item.symbols||[]});
    if(!data.next_page_token)return [...items.values()];
    token=data.next_page_token;if(seen.has(token))throw new Error('News pagination repeated');seen.add(token);
  }
  throw new Error('News exceeded 5000 articles; coverage incomplete');
}
export async function history(symbols,now) {
  if(!symbols.length)return {};
  const result={},seen=new Set();let token;
  for(let page=0;page<100;page++) {
    const p={symbols:symbols.join(','),timeframe:'1Day',feed:'iex',adjustment:'split',start:new Date(now-220*86400000).toISOString(),end:marketDate(now)+'T00:00:00Z',sort:'asc',limit:'10000'};
    if(token)p.page_token=token;
    const data=await request(endpoint(DATA,'/v2/stocks/bars',p));
    for(const [symbol,bars] of Object.entries(data.bars||{})) (result[symbol]??=[]).push(...bars);
    if(!data.next_page_token)return result;
    token=data.next_page_token;if(seen.has(token))throw new Error('Bars pagination repeated');seen.add(token);
  }
  throw new Error('Daily bars incomplete');
}
export async function tickerMap() {
  const d=await request('https://www.sec.gov/files/company_tickers.json',{sec:true});
  return new Map(Object.values(d).map(x=>[x.ticker,x.cik_str]));
}
const arr=x=>x==null?[]:Array.isArray(x)?x:[x];
export function parseForm4(xml) {
  if(xml.length>2000000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml)!==true)throw new Error('Invalid Form 4 XML');
  const doc=new XMLParser({ignoreAttributes:false,processEntities:false}).parse(xml).ownershipDocument;
  if(!doc)throw new Error('Missing ownership document');
  return arr(doc.nonDerivativeTable?.nonDerivativeTransaction).map(t=>({date:t.transactionDate?.value,code:t.transactionCoding?.transactionCode,shares:Number(t.transactionAmounts?.transactionShares?.value),price:Number(t.transactionAmounts?.transactionPricePerShare?.value),direction:t.transactionAmounts?.transactionAcquiredDisposedCode?.value})).filter(t=>['P','S'].includes(t.code)&&Number.isFinite(t.shares)&&Number.isFinite(t.price));
}
export async function insiderFilings(symbol,map,now) {
  const cik=map.get(symbol);if(!cik)return {status:'issuer-not-mapped',filings:[],transactions:[]};
  const d=await request(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10,'0')}.json`,{sec:true});
  const r=d.filings?.recent;if(!r)throw new Error('Missing SEC filing metadata');
  const filings=[],transactions=[];
  for(let i=0;i<r.form.length;i++) {
    if(!['4','4/A'].includes(r.form[i])||Date.parse(r.filingDate[i])<now-30*86400000||Date.parse(r.acceptanceDateTime[i])>now)continue;
    const base=`https://www.sec.gov/Archives/edgar/data/${cik}/${r.accessionNumber[i].replaceAll('-','')}/`;
    const path=r.primaryDocument[i]; if(!path||path.includes('..'))continue;
    const url=base+path, rawUrl=base+path.split('/').at(-1);
    const parsed=parseForm4(await request(rawUrl,{sec:true,raw:true}));
    filings.push({form:r.form[i],filedAt:r.filingDate[i],acceptedAt:r.acceptanceDateTime[i],url});
    transactions.push(...parsed.map(t=>({...t,filing:url,amended:r.form[i]==='4/A'})));
    if(filings.length>=3)break;
  }
  return {status:'checked',scope:'Latest 3 public Forms 4/4-A within 30 days; non-derivative P/S codes only. Amendments may repeat prior transactions. No totals or netting. These filings can be delayed; not private insider information.',filings,transactions};
}
