-- Migration 017: Add bot tokens breakdown and total transactions, rename bot_breakdown
-- 
-- Changes:
-- 1. Rename bot_breakdown to bot_tx_breakdown (transaction counts per bot)
-- 2. Add bot_tokens_breakdown (unique tokens per bot)
-- 3. Add total_transactions (total transaction count)

-- Rename existing column
ALTER TABLE scans RENAME COLUMN bot_breakdown TO bot_tx_breakdown;

-- Add new columns
ALTER TABLE scans ADD COLUMN IF NOT EXISTS bot_tokens_breakdown JSONB;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS total_transactions INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_scans_bot_tokens_breakdown ON scans USING gin(bot_tokens_breakdown);

COMMENT ON COLUMN scans.bot_tx_breakdown IS 'Transaction counts per bot (total transactions, not unique tokens)';
COMMENT ON COLUMN scans.bot_tokens_breakdown IS 'Unique tokens discovered per bot';
COMMENT ON COLUMN scans.total_transactions IS 'Total number of bot transactions found in scan';

