-- Migration: Remove peak_gain_timestamp from scanned_tokens table
-- Reason: Error-prone to calculate, not critical for functionality
-- peak_gain value is what matters for analytics and ML training

-- Drop the index first
DROP INDEX IF EXISTS idx_scanned_tokens_peak_gain_timestamp;

-- Drop the column
ALTER TABLE scanned_tokens
DROP COLUMN IF EXISTS peak_gain_timestamp;

