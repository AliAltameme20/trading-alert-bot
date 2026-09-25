> **Legacy (superseded Sept 25, 2026).** The 10 a.m. Mac-dependent morning scanner is replaced by the cloud daily-signals pipeline — see README.md. Kept for reference; not scheduled.

# Daily Telegram stock research

## Schedule

Target delivery: **10:00 a.m. America/New_York every day**, following daylight saving time. The scheduled task starts preparation at 9:55; the script waits until 10:00 before sending. Research or scheduler delays can delay delivery. After 10:10, it sends a missed-window notice instead of an actionable setup.

The task runs through the local Codex desktop app. **Keep the computer awake, online, and the app running. Turning off only the display is fine.** This is not a Vercel-hosted deployment. The Vercel key pays for AI model requests. The former evening Vercel cron has been removed to avoid a second schedule.

The Desktop folder is a saved copy; the schedule uses the workspace copy. Later edits are not automatically synchronized.

Weekends and exchange holidays produce a market-closed message. API/data failures produce a research-unavailable message. When no stock qualifies, the report says so; it never forces a pick. There are no order-placement APIs or automatic trade execution.

## Broad universe and staged screening

The user approved Alpaca's active U.S. equity list as a proxy. It is **not a verified Robinhood catalog**. Every returned asset is classified. Active, tradable, exchange-listed stock symbols advance. OTC/untradable records and names indicating ETFs, ETNs, funds, trusts, preferred shares, warrants, rights, or units are excluded. This name-based classification is imperfect and excludes some REITs. Verify Robinhood availability manually.

Every eligible symbol enters snapshot retrieval. Missing data and exclusions are recorded. News is paginated across 72 hours from the configured Alpaca provider; a candidate must have news within 48 hours. This does not cover all news sources. Pagination overflow or any required API failure produces an unavailable report.

Initial filters require a quote and trade at most two minutes old, spread at most 0.3%, previous-session close at least $5, and previous-session IEX dollar volume at least $2 million. The top 40 survivors by liquidity/news ranking receive daily-history review. At most 10 technical survivors receive SEC and Jev checks. Astra reviews the top Jev-qualified candidate once and may reject it. Call caps control time and cost; not every stock gets deep AI research. Every report gives stage counts; the local JSON records exclusions.

## Data and risk levels

- Current price entitlement: **IEX only**, one exchange. Volume, liquidity and spread are not consolidated market measurements. SIP was rejected during setup. Always confirm current broker prices.
- Daily indicators exclude today's partial bar and require at least 60 bars ending on the previous exchange session. RSI14 and ATR14 use Wilder smoothing.
- Long-only, 1–5 trading-session setup: prior close > SMA20 > SMA50; RSI 45–70; sufficient IEX average liquidity; current price above today's IEX VWAP; no large gap/extension.
- Proposed buy limit is the current IEX ask rounded to cents. Stop is below the five-session low with a 0.1 ATR buffer and at least 1.5 ATR below entry. Planned risk must be 0.5%–8%. Nearby historical resistance that blocks 2R rejects the setup.
- Target 1 is entry + 2R; target 2 is entry + 3R. **These are mechanical planning levels, not forecasts.** R is the price distance from proposed entry to stop trigger.
- The sell stop-limit limit is 0.1 ATR below its trigger, with a minimum one-cent gap. **A stop-limit can remain unfilled after a gap; actual loss can exceed planned risk.** Nothing is placed automatically.
- Entry expires ten minutes after the final quote check. There is no continuous stop monitoring, position tracking, or automatic exit management. Position sizing is omitted because account size/risk tolerance is not configured.

## Public insider filings and AI

Review the latest three public Forms 4/4-A within 30 days per deeply reviewed issuer. Parse non-derivative P/S transaction codes; a filing link, grant, or exercise is not treated as a purchase. P/S can include private transactions and do not prove conviction. Amendments may repeat transactions, so totals are not netted. Filings can lag trades. This is limited public information, never private tips or complete insider coverage.

Jev's probabilities describe answers about evidence, not profitable-trade odds. Pilot thresholds: catalyst and supportive >= 0.8; conflict <= 0.2. Astra independently reviews the top surviving candidate and writes a short assessment. Source text is untrusted input. Numeric entry/exit levels are calculated by code, not by models.

**This strategy is not backtested or forward validated.** Unit tests verify software behavior, not trading performance. News coverage, upcoming earnings/event completeness, corporate actions, survivorship bias and IEX-only data remain limitations.

## Private settings and commands

`.env.local` contains the Alpaca credentials, Gateway key, Telegram token/chat ID, and SEC contact. Never share or commit it. `DAILY_REPORTS_ENABLED=true` enables the new scheduled script. The legacy `ALERTS_ENABLED` stays false; the legacy scan API is not used by the schedule.

At most ten Jev calls and one Astra call per scan, with no model retries. Call limits are not a dollar cap: use Vercel's API-key budget for a billing ceiling. The application never buys credits or changes subscriptions.

Install with `pnpm install --frozen-lockfile` under Node 20+.

```sh
node --test
node --env-file=.env.local scripts/morning.js --test
node --env-file=.env.local scripts/morning.js --test --send
node --env-file=.env.local scripts/morning.js --scheduled --send
```

Preview does not send; test delivery labels its message TEST PREVIEW. Scheduled delivery is once per Eastern date. `reports/` saves evidence, exclusions, model assessments, formatted messages and delivery receipts. A pending receipt after an ambiguous network result blocks automatic retries; inspect Telegram before resolving it manually. A lock blocks concurrent scans. After a crash, inspect its recorded process ID before removing a stale lock.

Sources: [Alpaca data plans](https://docs.alpaca.markets/us/docs/about-market-data-api), [Robinhood investments](https://robinhood.com/us/en/support/articles/investments-you-can-make-on-robinhood/), [SEC data](https://www.sec.gov/search-filings/edgar-application-programming-interfaces).
