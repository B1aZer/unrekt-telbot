-- Migration 045: Add peak_drawdown tracking to scanned_tokens
-- 
-- Tracks the maximum drawdown % during the tracking period for ready/filtered tokens
-- Similar to peak_gain, but tracks the minimum gain (worst case scenario)
-- Enables analysis of risk and worst-case outcomes

ALTER TABLE scanned_tokens 
ADD COLUMN IF NOT EXISTS peak_drawdown DOUBLE PRECISION;

COMMENT ON COLUMN scanned_tokens.peak_drawdown IS 
  'Maximum drawdown % from scan price during tracking period (minimum gain). NULL if not tracked or tracking not complete yet. Negative values indicate drawdown.';

-- Create index for analysis
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_peak_drawdown ON scanned_tokens(peak_drawdown);

