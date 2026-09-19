-- Migration 050: Add Smart Money Wallet Tracking Metrics
-- Track high-profile Solana traders (smart money wallets) as positive signals
-- These metrics help identify tokens that skilled traders are buying

-- Core metrics
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS smart_money_wallet_count INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS smart_money_wallet_addresses TEXT[]; 
-- Array of unique wallet addresses that bought this token during the scan window
-- Note: Scanner filters by MONITOR_INTERVAL_MINUTES to avoid overlap between scans
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS smart_money_buy_count INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS smart_money_buy_percentage DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS smart_money_conviction_score DOUBLE PRECISION;

-- Advanced metrics
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS smart_money_first_buyer BOOLEAN;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS smart_money_entry_time_avg DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS smart_money_avg_buy_size DOUBLE PRECISION;

-- Velocity metrics (5-minute window)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS smart_money_buy_velocity_5m INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS smart_money_volume_5m DOUBLE PRECISION;

-- Held percentage (may require additional data source)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS smart_money_held_percentage DOUBLE PRECISION;

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_smart_money_count 
  ON scanned_tokens(smart_money_wallet_count) 
  WHERE smart_money_wallet_count > 0;

CREATE INDEX IF NOT EXISTS idx_scanned_tokens_smart_money_conviction 
  ON scanned_tokens(smart_money_conviction_score) 
  WHERE smart_money_conviction_score > 0;

CREATE INDEX IF NOT EXISTS idx_scanned_tokens_smart_money_first_buyer 
  ON scanned_tokens(smart_money_first_buyer) 
  WHERE smart_money_first_buyer = TRUE;

-- Composite index for filtering high-conviction smart money signals
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_smart_money_composite 
  ON scanned_tokens(
    smart_money_wallet_count, 
    smart_money_conviction_score, 
    smart_money_first_buyer
  ) WHERE smart_money_wallet_count > 0;

-- Add comments
COMMENT ON COLUMN scanned_tokens.smart_money_wallet_count IS 'Number of smart money wallets (high-profile traders) that bought this token';
COMMENT ON COLUMN scanned_tokens.smart_money_wallet_addresses IS 'Array of unique wallet addresses that bought this token during the scan window (filtered by MONITOR_INTERVAL_MINUTES to avoid overlap)';
COMMENT ON COLUMN scanned_tokens.smart_money_buy_count IS 'Total number of buys from smart money wallets';
COMMENT ON COLUMN scanned_tokens.smart_money_buy_percentage IS 'Percentage of total buys from smart money wallets (0-100)';
COMMENT ON COLUMN scanned_tokens.smart_money_conviction_score IS 'Weighted score based on wallet tier: Tier 1 = 1x, Tier 2 = 2x, Tier 3 = 3x';
COMMENT ON COLUMN scanned_tokens.smart_money_first_buyer IS 'TRUE if first buyer was a smart money wallet (very strong early signal)';
COMMENT ON COLUMN scanned_tokens.smart_money_entry_time_avg IS 'Average time (seconds) since token launch when smart money entered';
COMMENT ON COLUMN scanned_tokens.smart_money_avg_buy_size IS 'Average buy size (USD) from smart money wallets';
COMMENT ON COLUMN scanned_tokens.smart_money_buy_velocity_5m IS 'Number of smart money buys in last 5 minutes';
COMMENT ON COLUMN scanned_tokens.smart_money_volume_5m IS 'Total USD volume from smart money in last 5 minutes';
COMMENT ON COLUMN scanned_tokens.smart_money_held_percentage IS 'Percentage of supply held by smart money wallets (if available)';

