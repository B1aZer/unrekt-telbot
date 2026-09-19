-- Migration 021: Add peak_gain tracking to scanned_tokens
-- 
-- Tracks the maximum gain % during the tracking period for ready/filtered tokens
-- Enables analysis of missed opportunities

ALTER TABLE scanned_tokens 
ADD COLUMN IF NOT EXISTS peak_gain DOUBLE PRECISION;

COMMENT ON COLUMN scanned_tokens.peak_gain IS 
  'Maximum gain % from scan price during tracking period. NULL if not tracked or tracking not complete yet.';

-- Create index for analysis
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_peak_gain ON scanned_tokens(peak_gain);

