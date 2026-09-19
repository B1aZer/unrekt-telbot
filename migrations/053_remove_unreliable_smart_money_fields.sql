-- Migration 053: Remove unreliable smart money fields
-- These fields require data we don't have access to in the scanner:
-- - smart_money_first_buyer: Requires accurate timestamp ordering
-- - smart_money_entry_time_avg: Requires pairCreatedAt which may not be available
-- - smart_money_buy_velocity_5m: Requires accurate timestamps
-- - smart_money_volume_5m: We don't have reliable volume/amount data

ALTER TABLE scanned_tokens DROP COLUMN IF EXISTS smart_money_first_buyer;
ALTER TABLE scanned_tokens DROP COLUMN IF EXISTS smart_money_entry_time_avg;
ALTER TABLE scanned_tokens DROP COLUMN IF EXISTS smart_money_buy_velocity_5m;
ALTER TABLE scanned_tokens DROP COLUMN IF EXISTS smart_money_volume_5m;

-- Drop indexes that reference these columns
DROP INDEX IF EXISTS idx_scanned_tokens_smart_money_first_buyer;
DROP INDEX IF EXISTS idx_scanned_tokens_smart_money_composite;

-- Recreate composite index without first_buyer
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_smart_money_composite 
  ON scanned_tokens(
    smart_money_wallet_count, 
    smart_money_conviction_score
  ) WHERE smart_money_wallet_count > 0;

