# Setup status — September 25, 2026

## Done (offline, verified)
- The Stock Readout Protocol is ported to `lib/protocol.js`, alongside a universe-level validation, a live ledger, a kill switch, and GitHub Actions workflows.
- 34/34 tests pass, including the original 15. The new tests cover no look-ahead, stop-wins-ties, gap fills, costs, fail-closed earnings, veto-only AI, risk-off blocking, stale-signal refusal and DST.
- Calibration on synthetic markets (`pnpm calibrate`): pure random walks switched **0** cells on. Genuine momentum series switched breakout cells on in 3 of 4 universes.
- Found and fixed before any real-data run: the original pullback rule could **almost never fire**. Its "no 60-day high below 2R" check rejects nearly every uptrend, which is why the Sept 17 preview had zero technical qualifiers. Only resistance within the first 1R now blocks.

## Not yet done — needs you (≈15 minutes)
1. **Create a private GitHub repo** (github.com/new), e.g. `trading-alert-bot`.
2. **Push this folder.** In Terminal on your Mac:
   ```sh
   cd ~/Desktop/"Trading Alert Bot"
   git init && git add . && git commit -m "Cloud signals"
   git branch -M main && git remote add origin https://github.com/<you>/trading-alert-bot.git && git push -u origin main
   ```
   `.env.local`, `reports/` and `node_modules/` are git-ignored and will not upload.
3. **Add secrets.** In the repo, go to Settings → Secrets and variables → Actions → *New repository secret*: `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `AI_GATEWAY_API_KEY`, `FINNHUB_API_KEY` (free at finnhub.io; strongly recommended for earnings), `SEC_USER_AGENT`. Copy the values from `.env.local`. Never paste them into a chat.
   Under *Variables*, add `ACCOUNT_EQUITY` (e.g. 10000) and `RISK_PCT` (e.g. 0.005 = 0.5% per trade).
4. **Actions tab → Monthly validation → Run workflow.** This takes 10–30 minutes. Telegram receives the result, showing which setups are live and which are off.
5. **Actions tab → Daily signals → Run workflow → mode `test`.** You receive a message labelled TEST.
6. **Turn off the old Codex desktop morning task.** Otherwise you'll get two messages.

After that the bot runs every trading evening with your Mac off.

## Known limits
- The validation universe is today's liquid stocks, which is survivorship-biased and flatters long rules slightly. Historical earnings are not excluded in validation (live signals do exclude them).
- GitHub's free scheduler drops some cron triggers. The workflow makes about 14 attempts per night plus a pre-market fallback, and delivery happens once. Usage is roughly 400–500 of the 2,000 free private-repo minutes per month.
- Alpaca SIP daily bars are used when the free plan allows it. The run falls back to IEX-only and says so in the message.
- The stop is a planning level. Place it as a GTC order with your broker, because a gap can fill below it.
