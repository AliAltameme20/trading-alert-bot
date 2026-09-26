// Cloud entry point (GitHub Actions). One delivery per completed session, never twice.
//   node scripts/daily.js            preview only (prints, sends nothing, writes nothing)
//   node scripts/daily.js --send     production: persist ledger, send Telegram, commit state
//   node scripts/daily.js --test --send   labelled TEST message, does not touch the ledger
import { fileURLToPath } from 'node:url';
import { runDaily, formatDaily } from '../lib/daily.js';
import * as market from '../lib/market.js';
import { aiVeto } from '../lib/veto.js';
import { emptyLedger } from '../lib/ledger.js';
import { readJson, writeJson, commit } from '../lib/persist.js';
import { safeError } from '../lib/morning-report.js';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const args = new Set(process.argv.slice(2)), send = args.has('--send'), test = args.has('--test');
const now = new Date();
const settings = {
  equity: Number(process.env.ACCOUNT_EQUITY || 10000),
  riskPct: Number(process.env.RISK_PCT || 0.005),
  maxNew: Number(process.env.MAX_NEW_SIGNALS || 1),
  maxOpen: Number(process.env.MAX_OPEN_SIGNALS || 3),
  universeLimit: process.env.UNIVERSE_LIMIT ? Number(process.env.UNIVERSE_LIMIT) : undefined,
};
const services = { ...market, aiVeto };
const production = send && !test;

const deliveries = await readJson('data/deliveries.json', {});
const ledger = await readJson('data/ledger.json', emptyLedger());
const validation = await readJson('data/validation.json', null);

// Cheap dedupe before any heavy work: which session would this run be for?
const sessions = await market.calendar(market.addDays(now, -10), market.addDays(now, 10));
const clock = market.sessionClock(sessions, now);
const key = clock.target?.date;
// A send that failed after state was committed: resend the saved message while it's still valid.
if (production && deliveries[key]?.status === 'send-failed' && deliveries[key].message) {
  if (!clock.entryWindowOpen) {
    deliveries[key] = { ...deliveries[key], status: 'missed', missedAt: now.toISOString() };
    await writeJson('data/deliveries.json', deliveries); commit(`missed ${key} (send never succeeded)`);
    process.exit(0);
  }
  await deliver(deliveries[key].message);
  process.exit(0);
}
if (production && ['sent', 'pending', 'missed'].includes(deliveries[key]?.status)) {
  console.log(`Session ${key} already ${deliveries[key].status} — nothing to do.`);
  process.exit(deliveries[key].status === 'pending' ? 2 : 0);
}

let out, message;
try {
  out = await runDaily({ now, services, ledger: test ? structuredClone(ledger) : ledger, validation, settings, log: console.log });
  if (out.status === 'missed') { console.log(`Entry window for ${out.nextSession} already open — no stale signals sent.`); if (production) { deliveries[key] = { status: 'missed', at: now.toISOString() }; await writeJson('data/deliveries.json', deliveries); commit(`missed ${key}`); } process.exit(0); }
  message = formatDaily(out, { test });
} catch (e) {
  message = `${test ? 'TEST — ' : ''}⚠️ SIGNALS UNAVAILABLE for session ${key}: ${safeError(e)}\nNo trade today. The next scheduled attempt will retry.`;
  console.error(safeError(e));
  let first = true;
  if (production) {   // retry on later attempts, but only message you about the first failure
    const attempts = (deliveries[key]?.attempts || 0) + 1; first = attempts === 1;
    deliveries[key] = { status: 'failed', attempts, lastError: safeError(e), at: now.toISOString() };
    await writeJson('data/deliveries.json', deliveries); commit(`failed ${key} (attempt ${attempts})`);
  }
  if (send && first) await market.sendTelegram(message).catch(err => console.error('Telegram failed:', safeError(err)));
  process.exit(1);
}
console.log('\n' + message + '\n');
console.log(JSON.stringify({ session: out.session, status: out.status, funnel: out.funnel, signals: out.signals.map(s => s.rec.symbol) }));
if (!send) process.exit(0);

if (production) {
  await writeJson('data/ledger.json', ledger);
  deliveries[key] = { status: 'pending', at: now.toISOString(), signals: out.signals.map(s => s.rec.id), message };
  await writeJson('data/deliveries.json', deliveries);
  commit(`signals ${key}: ${out.status}`);   // durable BEFORE sending: a crash can't double-send
}
await deliver(message);

// Telegram refused or unreachable → record it so the next scheduled attempt resends the same
// message (the ledger already holds these signals, so re-running the scan would drop them).
async function deliver(text) {
  let ids;
  try { ids = await market.sendTelegram(text); }
  catch (e) {
    console.error('Telegram failed:', safeError(e));
    if (production) {
      deliveries[key] = { ...deliveries[key], status: 'send-failed', sendAttempts: (deliveries[key].sendAttempts || 0) + 1, lastError: safeError(e) };
      await writeJson('data/deliveries.json', deliveries); commit(`send failed ${key}`);
    }
    process.exit(1);
  }
  if (production) {
    deliveries[key] = { ...deliveries[key], status: 'sent', sentAt: new Date().toISOString(), messageIds: ids };
    await writeJson('data/deliveries.json', deliveries);
    commit(`delivered ${key}`);
  }
  console.log(JSON.stringify({ telegram: 'accepted', ids, test }));
}
