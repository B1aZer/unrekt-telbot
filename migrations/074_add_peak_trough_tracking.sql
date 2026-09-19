-- Migration 074: Add peak/trough price tracking during hold period
-- Purpose: Track max and min prices during the 15-min hold window
-- This data enables analysis of optimal SL/TP/trailing stop parameters

ALTER TABLE hybrid_shadow_trades
  ADD COLUMN IF NOT EXISTS max_price_during_hold NUMERIC,
  ADD COLUMN IF NOT EXISTS min_price_during_hold NUMERIC,
  ADD COLUMN IF NOT EXISTS max_pnl_pct_during_hold NUMERIC,
  ADD COLUMN IF NOT EXISTS min_pnl_pct_during_hold NUMERIC;

COMMENT ON COLUMN hybrid_shadow_trades.max_price_during_hold IS 'Highest price observed during hold period (USD/token)';
COMMENT ON COLUMN hybrid_shadow_trades.min_price_during_hold IS 'Lowest price observed during hold period (USD/token)';
COMMENT ON COLUMN hybrid_shadow_trades.max_pnl_pct_during_hold IS 'Peak unrealized P&L % during hold (before costs)';
COMMENT ON COLUMN hybrid_shadow_trades.min_pnl_pct_during_hold IS 'Trough unrealized P&L % during hold (before costs)';
