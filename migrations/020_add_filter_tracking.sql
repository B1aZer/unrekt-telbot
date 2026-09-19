-- Migration 020: Add filter tracking to scanned_tokens
-- 
-- Tracks where and why tokens were filtered in the funnel
-- Enables analysis of missed opportunities

ALTER TABLE scanned_tokens 
ADD COLUMN IF NOT EXISTS filter_stage TEXT,
ADD COLUMN IF NOT EXISTS filter_reason TEXT;

COMMENT ON COLUMN scanned_tokens.filter_stage IS 
  'Where token was filtered: ai_ready (reached AI or passed all filters), security_hardstop, activity_filter, liquidity_filter, volume_filter';

COMMENT ON COLUMN scanned_tokens.filter_reason IS 
  'Why filtered: unverified_contract, honeypot, hidden_functions, blacklist, airdrop_scam, can_reclaim_ownership, extreme_centralization, owner_concentration, no_security_data, low_users, low_trades, low_liquidity, low_volume, null=reached AI or passed all filters';

-- Create index for filtering analysis
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_filter_stage ON scanned_tokens(filter_stage);
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_filter_reason ON scanned_tokens(filter_reason);

