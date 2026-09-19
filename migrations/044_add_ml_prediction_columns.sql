-- ============================================================================
-- Migration 044: Add ML Prediction Columns to Decisions Table
-- ============================================================================
-- Purpose: Store ML predicted_return and expected_value as separate columns
--          instead of parsing from opportunities array
-- Date: 2025-11-29
--
-- Benefits:
--   - Direct SQL queries on EV/predicted return
--   - Compare predicted vs actual returns easily
--   - No string parsing needed in analytics
--   - Better query performance
-- ============================================================================

-- Add ML prediction columns to decisions table
ALTER TABLE decisions
ADD COLUMN IF NOT EXISTS ml_predicted_return DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS ml_expected_value DOUBLE PRECISION;

-- Add comments for documentation
COMMENT ON COLUMN decisions.ml_predicted_return IS 'ML model predicted return (E[R|win]) in % - conditional return if trade wins';
COMMENT ON COLUMN decisions.ml_expected_value IS 'ML model expected value (P(win) × E[R|win]) in % - used for position sizing';

-- Create index for analytics queries
CREATE INDEX IF NOT EXISTS idx_decisions_ml_expected_value ON decisions(ml_expected_value) WHERE ml_expected_value IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_ml_predicted_return ON decisions(ml_predicted_return) WHERE ml_predicted_return IS NOT NULL;

