-- Migration 044: Remove regime classification TEXT columns
-- 
-- These columns (regime_trend, regime_liquidity, regime_risk, regime_micro) are no longer used.
-- Classifications are now calculated on-the-fly from scores in analytics-api.ts using
-- classifyTrendRegime(), classifyLiquidityRegime(), classifyRiskRegime(), classifyMicroRegime()
-- 
-- This ensures consistency and avoids storing redundant data.
-- The scores (regime_trend_score, etc.) remain in the database.

-- Drop the index first
DROP INDEX IF EXISTS idx_scans_regime_trend;

-- Drop the classification columns
ALTER TABLE scans DROP COLUMN IF EXISTS regime_trend;
ALTER TABLE scans DROP COLUMN IF EXISTS regime_liquidity;
ALTER TABLE scans DROP COLUMN IF EXISTS regime_risk;
ALTER TABLE scans DROP COLUMN IF EXISTS regime_micro;

COMMENT ON TABLE scans IS 'Regime classifications are calculated on-the-fly from scores using classify*Regime() functions in regime-detector.ts';

