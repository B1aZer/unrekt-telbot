-- Add microstructure features to scanned_tokens table
-- Migration: Add order-flow imbalance, volume squeeze, pullback strength, and other microstructure features

-- Order-flow imbalance (from Codex transaction data)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS imbalance_5m DOUBLE PRECISION;

-- Volume squeeze (volatility compression indicator)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_squeeze DOUBLE PRECISION;

-- Pullback strength (normalized pullback depth)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS pullback_strength DOUBLE PRECISION;

-- Average trade sizes (from Codex)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS avg_buy_size_5m_codex DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS avg_sell_size_5m_codex DOUBLE PRECISION;

-- Small wallet/trade buy ratios (from Codex)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS small_wallet_buy_ratio_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS small_trade_buy_ratio_5m DOUBLE PRECISION;

-- Small flow ratio (weighted combination)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS small_flow_ratio_5m DOUBLE PRECISION;

-- Price impact coefficient
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS price_impact_5m DOUBLE PRECISION;

-- 5m range average for 30m (needed for volume squeeze calculation)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m5_range_avg_30m DOUBLE PRECISION;

-- Add comments for documentation
COMMENT ON COLUMN scanned_tokens.imbalance_5m IS 'Order-flow imbalance: (txn_buys_5m - txn_sells_5m) / (txn_buys_5m + txn_sells_5m + 1)';
COMMENT ON COLUMN scanned_tokens.volume_squeeze IS 'Volatility squeeze: m1_range_avg_5m / m5_range_avg_30m (low = compression before breakout)';
COMMENT ON COLUMN scanned_tokens.pullback_strength IS 'Pullback strength: m5_pullback_depth / abs(m5_ret_60m)';
COMMENT ON COLUMN scanned_tokens.avg_buy_size_5m_codex IS 'Average buy size in last 5m: volume_5m_codex / buy_count_5m_codex';
COMMENT ON COLUMN scanned_tokens.avg_sell_size_5m_codex IS 'Average sell size in last 5m: volume_5m_codex / sell_count_5m_codex';
COMMENT ON COLUMN scanned_tokens.small_wallet_buy_ratio_5m IS 'Small wallet buy ratio: unique_buys_5m_codex / (unique_buys_5m_codex + unique_sells_5m_codex)';
COMMENT ON COLUMN scanned_tokens.small_trade_buy_ratio_5m IS 'Small trade buy ratio: buy_count_5m_codex / (buy_count_5m_codex + sell_count_5m_codex)';
COMMENT ON COLUMN scanned_tokens.small_flow_ratio_5m IS 'Small flow ratio: 0.7 * small_wallet_buy_ratio + 0.3 * small_trade_buy_ratio';
COMMENT ON COLUMN scanned_tokens.price_impact_5m IS 'Price impact: (price_change_5m / 100) / (volume_5m_codex + eps)';
COMMENT ON COLUMN scanned_tokens.m5_range_avg_30m IS 'Average range of 5m candles over last 30 minutes (6 candles)';

