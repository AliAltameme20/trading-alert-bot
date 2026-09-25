import test from 'node:test';
import assert from 'node:assert/strict';
import { marketDate,marketMinutes,wilder,dailyIndicators,buildPlan,validQuote,stockEligible,jevPass } from '../lib/morning-strategy.js';
import { parseForm4 } from '../lib/morning-data.js';
import { formatReport,research } from '../lib/morning-report.js';
const now=new Date('2026-09-17T14:00:00Z');
const snapshot={latestQuote:{ap:100,bp:99.9,t:now.toISOString()},latestTrade:{p:100,t:now.toISOString()},dailyBar:{t:'2026-09-17T04:00:00Z',vw:99}};
const chart={close:99,sma20:97,sma50:95,rsi14:60,atr14:2,swingLow:97,resistance:99,averageIexDollarVolume:5000000,asOf:'2026-09-16'};
test('Eastern time follows daylight saving without a fixed UTC offset',()=>{
  assert.equal(marketMinutes(new Date('2026-09-17T14:00:00Z')),600);
  assert.equal(marketMinutes(new Date('2026-12-17T15:00:00Z')),600);
  assert.equal(marketDate(new Date('2026-09-17T02:00:00Z')),'2026-09-16');
});
test('Wilder recurrence uses the prior smoothed value',()=>assert.equal(wilder([1,2,3,6],3),10/3));
test('risk levels use five-session support, ATR and exact 2R/3R distances',()=>{
  const p=buildPlan(chart,snapshot,now);
  assert.equal(p.entry,100);assert.equal(p.stop,96.8);assert.equal(p.stopLimit,96.6);
  assert.equal(p.riskPerShare,3.2);assert.equal(p.target1,106.4);assert.equal(p.target2,109.6);
  assert.equal(p.validUntil,'2026-09-17T14:10:00.000Z');
});
test('wide risk, nearby resistance, overbought RSI and price jumps are rejected',()=>{
  for(const override of [{swingLow:85},{resistance:102},{rsi14:80},{close:80}])assert.equal(buildPlan({...chart,...override},snapshot,now),null);
});
test('stale, future and crossed quotes never produce levels',()=>{
  for(const override of [{t:'2026-09-17T13:50:00Z'},{t:'2026-09-17T14:01:00Z'},{bp:101}]) {
    const s={...snapshot,latestQuote:{...snapshot.latestQuote,...override}};
    assert.equal(validQuote(s,now),false);assert.equal(buildPlan(chart,s,now),null);
  }
});
test('today partial bar excluded and missing previous session rejected',()=>{
  const bars=Array.from({length:65},(_,i)=>({t:new Date(Date.UTC(2026,6,14+i,4)).toISOString(),o:100,h:102,l:98,c:100,v:100000}));
  bars.push({t:'2026-09-17T04:00:00Z',o:900,h:999,l:900,c:999,v:100000});
  const c=dailyIndicators(bars,'2026-09-16');
  assert.equal(c.close,100);assert.equal(c.atr14,4);assert.equal(c.rsi14,50);
  assert.equal(dailyIndicators(bars.filter(b=>!b.t.startsWith('2026-09-16')),'2026-09-16'),null);
});
test('funds and untradable OTC instruments are excluded with explicit rules',()=>{
  const a={status:'active',tradable:true,class:'us_equity',exchange:'NASDAQ',symbol:'AAPL',name:'Apple Inc Common Stock'};
  assert.equal(stockEligible(a),true);assert.equal(stockEligible({...a,name:'Index ETF'}),false);assert.equal(stockEligible({...a,exchange:'OTC'}),false);
});
test('malformed or overconfident model values fail closed',()=>{
  const a={catalyst:{probability:0.9},supportive:{probability:0.85},conflict:{probability:0.1}};
  assert.equal(jevPass(a),true);for(const p of [NaN,1.1,'0.95',undefined])assert.equal(jevPass({...a,catalyst:{probability:p}}),false);
});
test('Form 4 transactions use codes rather than a filing link to infer activity',()=>{
  const xml='<ownershipDocument><nonDerivativeTable><nonDerivativeTransaction><transactionDate><value>2026-09-15</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>12.50</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>';
  assert.deepEqual(parseForm4(xml),[{date:'2026-09-15',code:'P',shares:100,price:12.5,direction:'A'}]);
  assert.throws(()=>parseForm4('<!DOCTYPE a><ownershipDocument/>'));
});
test('holiday requires neither model calls nor fabricated candidates',async()=>{
  const r=await research({now,services:{sessions:async()=>({today:null,previous:'2026-09-16'})}});
  assert.equal(r.status,'market-closed');assert.match(formatReport(r),/MARKET CLOSED/);
});
test('late scheduled run returns missed window before scanning stocks',async()=>{
  const r=await research({now:new Date('2026-09-17T18:00:00Z'),scheduled:true,services:{sessions:async()=>({today:{date:'2026-09-17'},previous:'2026-09-16'})}});
  assert.equal(r.status,'missed-window');
});
test('candidate report retains levels, sources, data limitation and stop-limit nonfill warning',()=>{
  const report={date:'2026-09-17',status:'candidate',coverage:{eligibleStocks:5000},candidate:{symbol:'TEST',name:'Synthetic example',chart,plan:buildPlan(chart,snapshot,now),review:{catalyst:'Synthetic fixture only.',countercase:'No validated edge.'},news:[{url:'https://example.com/news'}],insiders:{filings:[]}}};
  const msg=formatReport(report,{test:true});assert.match(msg,/TEST PREVIEW/);assert.match(msg,/\$106.40/);assert.match(msg,/UNFILLED/);assert.match(msg,/IEX only/);assert.ok(msg.length<4000);
});
