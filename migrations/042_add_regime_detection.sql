-- Migration: Add regime detection columns to scans table
-- Stores calculated regime data for each scan

ALTER TABLE scans 
ADD COLUMN IF NOT EXISTS regime_trend_score DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS regime_liquidity_score DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS regime_risk_score DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS regime_micro_score DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS regime_trend TEXT,
ADD COLUMN IF NOT EXISTS regime_liquidity TEXT,
ADD COLUMN IF NOT EXISTS regime_risk TEXT,
ADD COLUMN IF NOT EXISTS regime_micro TEXT,
ADD COLUMN IF NOT EXISTS regime_global TEXT,
ADD COLUMN IF NOT EXISTS market_winrate_1h DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS market_ev_1h DOUBLE PRECISION;

-- Create indexes for regime queries
CREATE INDEX IF NOT EXISTS idx_scans_regime_global ON scans(regime_global);
CREATE INDEX IF NOT EXISTS idx_scans_regime_trend ON scans(regime_trend);
CREATE INDEX IF NOT EXISTS idx_scans_market_winrate ON scans(market_winrate_1h);

COMMENT ON COLUMN scans.regime_trend_score IS 'Z-score for trend regime (-2 to +2, positive = bullish)';
COMMENT ON COLUMN scans.regime_liquidity_score IS 'Z-score for liquidity/activity regime';
COMMENT ON COLUMN scans.regime_risk_score IS 'Market win rate (0-1)';
COMMENT ON COLUMN scans.regime_micro_score IS 'Microstructure score (positive = breakout regime)';
COMMENT ON COLUMN scans.regime_global IS 'Overall market regime classification';
COMMENT ON COLUMN scans.market_winrate_1h IS 'Percentage of tokens that pumped +10% in last 1h';
COMMENT ON COLUMN scans.market_ev_1h IS 'Expected value: avg_peak_gain - avg_drawdown in last 1h';

