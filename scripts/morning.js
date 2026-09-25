import { mkdir, readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { research, formatReport, sendTelegram, safeError } from '../lib/morning-report.js';
import { marketDate, marketMinutes, buildPlan } from '../lib/morning-strategy.js';
import { snapshots, pause } from '../lib/morning-data.js';
const root=fileURLToPath(new URL('../',import.meta.url));
process.chdir(root);
const args=new Set(process.argv.slice(2));
const scheduled=args.has('--scheduled'), send=args.has('--send'), test=args.has('--test');
if(send&&!scheduled&&!test)throw new Error('Manual delivery must be labeled --test');
if(scheduled&&test)throw new Error('Scheduled reports cannot be labeled as manual tests');
if(scheduled&&marketMinutes()<590)throw new Error('Scheduled run started before 9:50 a.m. Eastern; check scheduler timezone. No report sent.');
const date=marketDate(), dir=root+'reports';await mkdir(dir,{recursive:true,mode:0o700});
const ledgerPath=`${dir}/${date}.delivery.json`,lockPath=`${dir}/morning.lock`;
async function atomic(path,data){const tmp=path+'.tmp';await writeFile(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600});await rename(tmp,path);}
let lock;
try{lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,started:new Date().toISOString()}));}
catch(e){if(e.code==='EEXIST'){console.log('A run is already active, or its lock needs inspection. No duplicate run started.');process.exit(2);}throw e;}
try {
  let existing;
  try{existing=JSON.parse(await readFile(ledgerPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(scheduled&&existing){console.log(`Daily delivery already ${existing.status}; no automatic retry or duplicate.`);process.exitCode=existing.status==='sent'?0:2;}
  else {
    let report;
    try{report=await research({scheduled,onProgress:console.log});}
    catch(e){report={version:2,date,status:'error',reason:safeError(e),coverage:{},candidate:null};}
    if(scheduled) {
      // Prepare before 10 a.m.; never release an actionable morning setup early.
      while(marketMinutes()<600&&marketDate()===date)await pause(15000);
      if(marketDate()!==date||marketMinutes()>610)report={...report,status:'missed-window',candidate:null};
      if(report.candidate) {
        try {
          const top=report.candidate, s=(await snapshots([top.symbol]))[top.symbol], plan=buildPlan(top.chart,s,new Date());
          if(!plan||Math.abs(plan.entry-top.plan.entry)>0.25*top.chart.atr14)report={...report,status:'no-candidate',candidate:null,reason:'The final 10 a.m. quote failed freshness or price-drift checks.'};
          else report.candidate={...top,plan};
        }catch(e){report={...report,status:'error',candidate:null,reason:safeError(e)};}
      }
    }
    report.completedAt=new Date().toISOString();
    const message=formatReport(report,{test});
    const output=`${dir}/${date}${test?'-test':''}`;
    await atomic(output+'.json',report);await writeFile(output+'.txt',message+'\n',{mode:0o600});
    console.log(JSON.stringify({date,status:report.status,coverage:report.coverage,candidate:report.candidate?.symbol||null,reportFile:output+'.txt'}));
    if(send) {
      if(scheduled&&process.env.DAILY_REPORTS_ENABLED!=='true')throw new Error('Daily reports are disabled');
      // A pending record blocks retries after an ambiguous network outcome.
      if(scheduled)await atomic(ledgerPath,{status:'pending',createdAt:new Date().toISOString(),report:output+'.json'});
      const messageId=await sendTelegram(message);
      if(scheduled)await atomic(ledgerPath,{status:'sent',sentAt:new Date().toISOString(),messageId,report:output+'.json'});
      console.log(JSON.stringify({telegram:'accepted',messageId,test}));
    }
    if(report.status==='error')process.exitCode=1;
  }
} catch(e){console.error(safeError(e));process.exitCode=1;}
finally{await lock.close();await unlink(lockPath);}
