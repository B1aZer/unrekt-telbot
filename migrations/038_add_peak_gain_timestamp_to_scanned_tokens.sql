-- Migration: Add peak_gain_timestamp to scanned_tokens table
-- Tracks when peak_gain occurred during the tracking period
-- Useful for analyzing timing patterns: when do scanned tokens typically peak?

-- Add column to scanned_tokens table
ALTER TABLE scanned_tokens 
ADD COLUMN IF NOT EXISTS peak_gain_timestamp TIMESTAMP;

-- Add comment
COMMENT ON COLUMN scanned_tokens.peak_gain_timestamp IS 'Timestamp when peak_gain occurred during tracking period - useful for analyzing peak timing patterns';

-- Create index for queries analyzing peak timing
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_peak_gain_timestamp 
ON scanned_tokens(peak_gain_timestamp) 
WHERE peak_gain_timestamp IS NOT NULL;

