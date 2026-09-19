-- Add price action features to scanned_tokens table
-- Migration: Add OHLC-based price action features for ML training

-- Add 1m timeframe features (short-term microstructure)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_ret_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_ret_10m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_ret_15m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_vol_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_vol_10m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_rvol_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_rvol_10m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_vol_slope_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_ret_slope_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_body_avg_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_range_avg_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_upper_wick_ratio_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_lower_wick_ratio_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_last_bar_green BOOLEAN;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_last_bar_long_upper_wick BOOLEAN;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_last_bar_doji BOOLEAN;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_consecutive_green INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_consecutive_red INTEGER;

-- Add 5m timeframe features (context/build-up)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m5_ret_60m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m5_ret_last_3 DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m5_vol_60m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m5_rvol_15m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m5_price_slope_60m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m5_volume_slope_60m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m5_consecutive_green INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m5_pullback_depth DOUBLE PRECISION;

-- Add cross-timeframe features
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS pa_momo_alignment INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS pa_vol_ratio_m1_m5 DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS pa_rvol_ratio_m1_m5 DOUBLE PRECISION;

-- Add metadata columns for debugging
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m1_candles_available INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS m5_candles_available INTEGER;

-- Add indexes for performance (optional but recommended)
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_pa_returns ON scanned_tokens(m1_ret_5m, m5_ret_60m) WHERE m1_ret_5m IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_pa_alignment ON scanned_tokens(pa_momo_alignment) WHERE pa_momo_alignment IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_candles_available ON scanned_tokens(m1_candles_available, m5_candles_available);

-- Add comments for documentation
COMMENT ON COLUMN scanned_tokens.m1_ret_5m IS 'Return over last 5 minutes (1m bars)';
COMMENT ON COLUMN scanned_tokens.m5_ret_60m IS 'Return over last 60 minutes (5m bars)';
COMMENT ON COLUMN scanned_tokens.pa_momo_alignment IS 'Cross-timeframe momentum alignment: +1 (aligned), -1 (divergent), 0 (neutral)';
COMMENT ON COLUMN scanned_tokens.m1_candles_available IS 'Number of 1m candles available before scan (max 15)';
COMMENT ON COLUMN scanned_tokens.m5_candles_available IS 'Number of 5m candles available before scan (max 12)';

