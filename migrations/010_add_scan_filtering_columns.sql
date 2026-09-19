-- Migration 010: Add filtering metrics to scans table
-- Tracks how many tokens were filtered at each stage

-- Add filtering metric columns
ALTER TABLE scans ADD COLUMN IF NOT EXISTS tokens_filtered_security INTEGER DEFAULT 0;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS tokens_filtered_activity INTEGER DEFAULT 0;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS tokens_filtered_liquidity INTEGER DEFAULT 0;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS tokens_analyzed INTEGER DEFAULT 0;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS tokens_buy INTEGER DEFAULT 0;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS tokens_skip INTEGER DEFAULT 0;

-- Add comments explaining the columns
COMMENT ON COLUMN scans.tokens_filtered_security IS 'Tokens filtered out by security hard stops (honeypot, blacklist, etc.)';
COMMENT ON COLUMN scans.tokens_filtered_activity IS 'Tokens filtered out by activity thresholds (min users, min trades)';
COMMENT ON COLUMN scans.tokens_filtered_liquidity IS 'Tokens filtered out by liquidity/volume checks';
COMMENT ON COLUMN scans.tokens_analyzed IS 'Tokens sent to AI for analysis';
COMMENT ON COLUMN scans.tokens_buy IS 'Tokens where AI recommended BUY';
COMMENT ON COLUMN scans.tokens_skip IS 'Tokens where AI recommended SKIP';

