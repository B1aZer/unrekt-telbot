-- Migration: Add regime features to scans table
-- Regime features capture macro market conditions (SOL momentum, DEX activity)
-- These are calculated once per scan and shared by all tokens in that scan

-- SOL price and momentum features
ALTER TABLE scans ADD COLUMN IF NOT EXISTS sol_price DOUBLE PRECISION;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS sol_ret_5m DOUBLE PRECISION;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS sol_ret_15m DOUBLE PRECISION;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS sol_ret_1h DOUBLE PRECISION;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS sol_ret_6h DOUBLE PRECISION;

-- SOL volatility features (Phase 2 - will be null until Codex integration)
ALTER TABLE scans ADD COLUMN IF NOT EXISTS sol_volatility_1h DOUBLE PRECISION;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS sol_volatility_24h DOUBLE PRECISION;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS sol_trend_strength DOUBLE PRECISION;

-- DEX-wide activity features (from SOL/USDC pair as proxy for overall market activity)
ALTER TABLE scans ADD COLUMN IF NOT EXISTS dex_volume_5m DOUBLE PRECISION;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS dex_volume_1h DOUBLE PRECISION;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS dex_volume_ratio_5m_1h DOUBLE PRECISION;  -- Volume acceleration indicator
ALTER TABLE scans ADD COLUMN IF NOT EXISTS dex_txn_buys_5m INTEGER;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS dex_txn_sells_5m INTEGER;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS dex_buy_pressure DOUBLE PRECISION;  -- buys / (buys + sells)

-- Add comments for documentation
COMMENT ON COLUMN scans.sol_price IS 'Current SOL price in USD at scan time';
COMMENT ON COLUMN scans.sol_ret_5m IS 'SOL price return over last 5 minutes (%)';
COMMENT ON COLUMN scans.sol_ret_15m IS 'SOL price return over last 15 minutes (%) - interpolated or from candles';
COMMENT ON COLUMN scans.sol_ret_1h IS 'SOL price return over last 1 hour (%)';
COMMENT ON COLUMN scans.sol_ret_6h IS 'SOL price return over last 6 hours (%)';
COMMENT ON COLUMN scans.sol_volatility_1h IS 'SOL price volatility over last 1 hour (std dev of returns) - Phase 2';
COMMENT ON COLUMN scans.sol_volatility_24h IS 'SOL price volatility over last 24 hours (std dev of returns) - Phase 2';
COMMENT ON COLUMN scans.sol_trend_strength IS 'SOL trend strength: abs(ret_1h) * sqrt(abs(ret_1h / volatility_1h)) - Phase 2';
COMMENT ON COLUMN scans.dex_volume_5m IS 'DEX volume (SOL/USDC pair) over last 5 minutes (USD)';
COMMENT ON COLUMN scans.dex_volume_1h IS 'DEX volume (SOL/USDC pair) over last 1 hour (USD)';
COMMENT ON COLUMN scans.dex_volume_ratio_5m_1h IS 'DEX volume acceleration: (vol_5m / vol_1h) * 12. Ratio > 1.5 = high activity';
COMMENT ON COLUMN scans.dex_txn_buys_5m IS 'DEX buy transactions over last 5 minutes (from SOL/USDC pair)';
COMMENT ON COLUMN scans.dex_txn_sells_5m IS 'DEX sell transactions over last 5 minutes (from SOL/USDC pair)';
COMMENT ON COLUMN scans.dex_buy_pressure IS 'DEX buy pressure: txn_buys_5m / (txn_buys_5m + txn_sells_5m). > 0.6 = bullish';

