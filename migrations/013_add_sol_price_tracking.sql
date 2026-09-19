-- Migration 013: Add SOL Price Tracking for Beta/Alpha Calculations
-- Track SOL price at trade entry and exit to calculate performance vs market benchmark

ALTER TABLE trades ADD COLUMN IF NOT EXISTS sol_price_entry DOUBLE PRECISION;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS sol_price_exit DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS idx_trades_sol_prices ON trades(sol_price_entry, sol_price_exit) WHERE sol_price_entry IS NOT NULL;

COMMENT ON COLUMN trades.sol_price_entry IS 'SOL price in USD when trade was opened (for beta calculation)';
COMMENT ON COLUMN trades.sol_price_exit IS 'SOL price in USD when trade was closed (for alpha calculation)';

-- Example query to calculate alpha (performance vs SOL)
-- SELECT 
--   symbol,
--   pnl_percent as token_return,
--   ((sol_price_exit - sol_price_entry) / sol_price_entry * 100) as sol_return,
--   (pnl_percent - ((sol_price_exit - sol_price_entry) / sol_price_entry * 100)) as alpha
-- FROM trades
-- WHERE exit_timestamp IS NOT NULL AND sol_price_entry IS NOT NULL;

