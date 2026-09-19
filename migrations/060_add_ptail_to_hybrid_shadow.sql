-- Migration 060: Add p_tail support for adaptive thresholds
-- Purpose: Track p_tail predictions and effective thresholds for p_tail-based adaptive filtering
-- This enables logging of p_tail adaptive behavior in shadow mode

-- Add p_tail to hybrid_shadow_decisions table
ALTER TABLE hybrid_shadow_decisions 
  ADD COLUMN IF NOT EXISTS p_tail NUMERIC;

-- Add effective threshold columns (these may differ from base thresholds when p_tail adaptive is active)
ALTER TABLE hybrid_shadow_decisions 
  ADD COLUMN IF NOT EXISTS effective_entry_threshold NUMERIC,
  ADD COLUMN IF NOT EXISTS effective_rr_threshold NUMERIC;

-- Add tail model version
ALTER TABLE hybrid_shadow_decisions 
  ADD COLUMN IF NOT EXISTS tail_model_version TEXT;

-- Add p_tail to hybrid_shadow_trades table
ALTER TABLE hybrid_shadow_trades 
  ADD COLUMN IF NOT EXISTS p_tail NUMERIC;

-- Add comment
COMMENT ON COLUMN hybrid_shadow_decisions.p_tail IS 'Tail probability (0-1) for adaptive threshold adjustments';
COMMENT ON COLUMN hybrid_shadow_decisions.effective_entry_threshold IS 'Actual entry threshold used (may be relaxed when p_tail >= 0.10)';
COMMENT ON COLUMN hybrid_shadow_decisions.effective_rr_threshold IS 'Actual RR threshold used (may be relaxed when p_tail >= 0.15)';
COMMENT ON COLUMN hybrid_shadow_decisions.tail_model_version IS 'Version of tail model used for p_tail prediction';
COMMENT ON COLUMN hybrid_shadow_trades.p_tail IS 'Tail probability at entry (for logging/debugging)';
