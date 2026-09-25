# unrekt-telbot

A meme-token scanner, scorer and trading bot for Solana and BNB Chain, with a Telegram front end and an
analytics API. Built from October 2025 and run in production, in paper and real mode side by side.

This is a code-only snapshot. Strategy parameters, trained models, backtests, research notes, wallets
and deployment settings are not included, and every scoring weight defaults to a neutral 1. It shows
how the system is built, not what it trades.

## The story behind it

This bot is the first half of an autonomous trading desk we ran from October 2025 to September 2026.
It started with Claude picking tokens, which returned about nothing, moved to LightGBM models trained on
the bot's own outcomes, and grew into a data lake and a set of strategies that made 100 SOL before we
closed it. The full write-up, with every strategy's real result:
[After 100 SOL in profit and ten months of work, we closed our autonomous trading desk](https://staysup.io/closing-the-desk).

## What it does

1. **Scan.** Finds new tokens that retail trading bots are buying. It watches the fee accounts of BonkBot,
   Maestro, Trojan, Photon, GMGN, Padre and Axiom on Solana, and bot routers on BNB Chain
   (`src/services/solana/scanner.ts`, `src/services/monitor.ts`).
2. **Enrich.** Market, volume, holder and price-action data from DexScreener and Codex, liquidity depth,
   and features for regime detection (`src/services/data-gatherers/`, `src/infra/codex.ts`,
   `src/services/regime-*.ts`).
3. **Screen.** Contract security checks through GoPlus and RugCheck: honeypots, mint and freeze authority,
   holder concentration (`src/services/*security-scanner.ts`).
4. **Decide.** A point-based scorer, an optional Claude analysis step, and a client for an external ML
   prediction service (`src/services/point-based-analyzer*.ts`, `ai-analyzer.ts`,
   `ml-prediction-client.ts`). The ML service itself is not in this repo.
5. **Trade.** A paper trader with modelled slippage and fees, and real execution through Jupiter
   (`paper-trader.ts`, `src/services/solana/swap-service.ts`). A position monitor handles take-profit,
   stop-loss, trailing and timed exits. `hybrid-shadow-tracker.ts` runs a candidate strategy in shadow
   next to the live one so the two can be compared on the same tokens.
6. **Report.** Telegram alerts and commands (grammY), an HTTP API with 25 analytics endpoints
   (funnel, drawdown, Sharpe over time, Kelly, per-bot performance), and two dashboards
   (`analytics.html`, `hybrid-analytics.html`).

Every scan, decision and trade is written to Postgres. The schema grew through the 73 migrations in
`migrations/`.

## Running it

[Bun](https://bun.sh/) and PostgreSQL.

```bash
bun install
cp env.example .env        # every value is blank; fill in what you use
bun run dev:solana         # or dev:bsc
```

`initializeSchema()` creates the base tables on start. For a fresh database, also apply `migrations/`
in order with `psql`.

Real trading is off unless `USE_REAL_SOLANA_TRADING=true`, and then it signs with the key in `SOLANA_PRIVATE_KEY`.
Without that it paper trades.

`deploy:solana` and `deploy:bsc` deploy to Cloud Run. They expect `CLOUDSQL_INSTANCE` in the
environment and an env-vars file in `environment/`, which is gitignored.

## Not financial advice

Memecoin trading loses money for most participants, and a bot that predicts well can still lose on
execution. This code comes with no warranty and no claim that any configuration of it is profitable.

## License

MIT. See [LICENSE](LICENSE).
