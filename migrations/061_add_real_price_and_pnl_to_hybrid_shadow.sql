-- Migration 061: Add real execution price & PnL tracking for hybrid shadow trades
-- Purpose:
--  - Keep entry/exit prices and PnL in hybrid_shadow_trades aligned with Codex/price_history
--    so shadow mode matches backtests.
--  - Separately track real execution prices and real PnL for live trading verification.
--
-- This migration is backwards-compatible:
--  - New columns are nullable.
--  - Existing queries using entry_price/exit_price/pnl_pct/pnl_usd continue to work.

ALTER TABLE hybrid_shadow_trades
ADD COLUMN IF NOT EXISTS real_entry_price NUMERIC,   -- Actual execution entry price (USD per token) for real trades
ADD COLUMN IF NOT EXISTS real_exit_price NUMERIC,    -- Actual execution exit price (USD per token) for real trades
ADD COLUMN IF NOT EXISTS real_pnl_pct NUMERIC,       -- Realised PnL % based on execution prices (for real trades)
ADD COLUMN IF NOT EXISTS real_pnl_usd NUMERIC;       -- Realised PnL in USD based on execution prices

COMMENT ON COLUMN hybrid_shadow_trades.real_entry_price IS 'Actual execution entry price in USD per token (real trades only)';
COMMENT ON COLUMN hybrid_shadow_trades.real_exit_price IS 'Actual execution exit price in USD per token (real trades only)';
COMMENT ON COLUMN hybrid_shadow_trades.real_pnl_pct IS 'Realised PnL % based on actual execution prices (real trades only)';
COMMENT ON COLUMN hybrid_shadow_trades.real_pnl_usd IS 'Realised PnL in USD based on actual execution prices (real trades only)';

