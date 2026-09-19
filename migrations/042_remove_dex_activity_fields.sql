-- Migration: Remove DEX activity fields from scans table
-- These fields (from DexScreener) are not in sync with actual SOL activity
-- We'll rely on Codex charts for SOL metrics instead

-- Drop DEX activity columns
ALTER TABLE scans DROP COLUMN IF EXISTS dex_volume_5m;
ALTER TABLE scans DROP COLUMN IF EXISTS dex_volume_1h;
ALTER TABLE scans DROP COLUMN IF EXISTS dex_volume_ratio_5m_1h;
ALTER TABLE scans DROP COLUMN IF EXISTS dex_txn_buys_5m;
ALTER TABLE scans DROP COLUMN IF EXISTS dex_txn_sells_5m;
ALTER TABLE scans DROP COLUMN IF EXISTS dex_buy_pressure;

-- Note: SOL metrics (sol_price, sol_ret_*, sol_volatility_*, sol_trend_strength) remain
-- These are calculated from Codex candles and are accurate

