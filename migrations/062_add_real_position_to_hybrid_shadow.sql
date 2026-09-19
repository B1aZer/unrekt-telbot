-- Migration 062: Add real position size tracking for hybrid shadow trades
-- Purpose:
--  - Store real position size in USD when executing real trades
--  - Avoid deriving real position from tokens/price in analytics for consistency

ALTER TABLE hybrid_shadow_trades
ADD COLUMN IF NOT EXISTS real_position_usd NUMERIC;

COMMENT ON COLUMN hybrid_shadow_trades.real_position_usd IS 'Real position size in USD based on actual execution (real trades only)';

