# Trading Alert Bot — daily signals (cloud)

Runs on **GitHub Actions**, so your Mac can be off. After each US session closes it reads every liquid US stock, and it sends a Telegram signal only when that signal clears every gate below. Signals are built from completed daily bars for the **next session's open**: a buy limit (day order), a stop, a target and a share size. No orders are placed.

## What stops a bad signal

| # | Gate | Blocks when |
|---|------|-------------|
| 00 | Liquidity | Price < $5 or median consolidated dollar volume < $20M (orders are capped at 1% of it) |
| 01 | Market regime | SPY is not in a rising uptrend with normal volatility. Risk-off or transitional means no new longs. Unstable volatility halves the size |
| — | Setup | None of the 6 pre-registered setups fires today: trend pullback (your original rule), 20-day breakout, RSI(2) dip, volume gap that holds, fresh 52-week high, momentum-leader pullback (last three added Sept 25, 2026, before their first test) |
| 04 | Series character | The stock's variance ratio (Lo–MacKinlay z*, 3 years) contradicts the setup, e.g. a trend setup on a statistically mean-reverting stock |
| ✔ | **Validated edge** | That setup × character cell did not earn at least +0.05R per trade after costs in **each** of the last two years, out-of-sample, with 150+ trades per year and a pooled PF of at least 1.15, across ~1,200 liquid stocks (`scripts/validate.js`, monthly). With no validation, or one older than 45 days, **nothing is sent as a trade** |
| 09 | Earnings | A report falls within 5 sessions, **or the date can't be verified** (fail-closed; Finnhub + Nasdaq calendars) |
| AI | Veto only | Jev finds a disqualifying fact in the last 72h of news (a deal, an offering, an investigation…). The AI can withhold a signal. It can't create one or change a level. If it errors, the signal is withheld |
| ⛔ | Live kill switch | Your last 20 closed signals average below 0R (checked once 15 have closed). The bot then pauses itself and labels new signals "do not trade" until forward results recover above +0.05R |

Every signal (live, paused or shadow) is written to `data/ledger.json`, and its outcome is scored with the **same** trade simulator the validation uses. The daily message reports your live record.

**No system can promise zero losing trades.** This one sends only signals whose rule has *measured* out-of-sample edge, and it switches itself off when forward results stop matching that measurement. Expect quiet days and weeks: a "NO TRADE" message means the gates are doing their job.

## Files

- `lib/protocol.js`: all gates, the three setups, the trade simulator, and every threshold (`CONFIG`, assumptions marked `[A]`)
- `lib/validate.js`, `scripts/validate.js`: universe walk-forward validation, stored in `data/validation.json`
- `lib/daily.js`, `scripts/daily.js`: the daily run
- `lib/ledger.js`: signal record + kill switch
- `lib/market.js`: Alpaca (SIP bars, calendar, news), earnings calendars, Telegram
- `scripts/calibrate.js`: offline proof that the gates stay shut on pure noise (`pnpm calibrate`)
- `.github/workflows/`: `daily-signals.yml` (runs each night) and `validate.yml` (first Saturday of each month)
- Legacy, not scheduled: `scripts/morning.js`, `lib/morning-*.js`, `api/`, `lib/scan.js`

## Commands

```sh
pnpm install --frozen-lockfile
pnpm test                 # 34 offline tests
pnpm calibrate            # synthetic-market calibration
pnpm signals:preview      # needs .env.local and a network that reaches Alpaca
```

Cloud setup steps are in `SETUP-STATUS.md`.
