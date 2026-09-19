-- Migration 056: Add config logging to hybrid shadow decisions
-- Purpose: Store configuration parameters used for each decision to enable backtest comparison

-- Add columns to track configuration and ranking
ALTER TABLE hybrid_shadow_decisions
ADD COLUMN IF NOT EXISTS rank_in_scan INTEGER,
ADD COLUMN IF NOT EXISTS was_traded BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS max_trades_per_scan INTEGER,
ADD COLUMN IF NOT EXISTS exit_minutes INTEGER DEFAULT 15,
ADD COLUMN IF NOT EXISTS base_position_pct NUMERIC DEFAULT 1.0,
ADD COLUMN IF NOT EXISTS max_position_pct NUMERIC DEFAULT 2.5;

-- Update existing rows to have defaults (for backward compatibility)
UPDATE hybrid_shadow_decisions
SET 
  entry_threshold = COALESCE(entry_threshold, 0.50),
  crash_threshold = COALESCE(crash_threshold, -38.0),
  rr_threshold = COALESCE(rr_threshold, 2.0),
  exit_minutes = COALESCE(exit_minutes, 15),
  base_position_pct = COALESCE(base_position_pct, 1.0),
  max_position_pct = COALESCE(max_position_pct, 2.5)
WHERE entry_threshold IS NULL OR crash_threshold IS NULL OR rr_threshold IS NULL;

-- Add index for querying by rank
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_decisions_rank ON hybrid_shadow_decisions(rank_in_scan);
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_decisions_was_traded ON hybrid_shadow_decisions(was_traded);

COMMENT ON COLUMN hybrid_shadow_decisions.rank_in_scan IS 'Position after sorting by entry_prob (1 = best)';
COMMENT ON COLUMN hybrid_shadow_decisions.was_traded IS 'True if this decision resulted in a trade (rank <= max_trades_per_scan)';
COMMENT ON COLUMN hybrid_shadow_decisions.max_trades_per_scan IS 'Maximum trades allowed per scan (from config)';
COMMENT ON COLUMN hybrid_shadow_decisions.exit_minutes IS 'Exit time in minutes (from config)';
COMMENT ON COLUMN hybrid_shadow_decisions.base_position_pct IS 'Base position size % (from config)';
COMMENT ON COLUMN hybrid_shadow_decisions.max_position_pct IS 'Maximum position size % (from config)';

