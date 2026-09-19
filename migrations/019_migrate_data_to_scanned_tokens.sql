-- Migration 019: Migrate data from decisions to scanned_tokens and clean up
-- 
-- Step 1: Drop foreign key constraint temporarily
-- Step 2: Copy existing decision data to scanned_tokens
-- Step 3: Re-add foreign key constraint with ON DELETE CASCADE
-- Step 4: Drop redundant columns from decisions table

-- ============================================================================
-- STEP 1: Drop foreign key constraint temporarily
-- ============================================================================

-- Drop the foreign key constraint so we can insert historical data
ALTER TABLE scanned_tokens DROP CONSTRAINT IF EXISTS scanned_tokens_scan_id_fkey;

-- ============================================================================
-- STEP 2: Copy data from decisions to scanned_tokens
-- ============================================================================

-- For each decision, create a scanned_tokens entry with all the market/security data
-- Note: Old decisions may not have corresponding scans table entries, but that's OK
-- The scan_id is still useful for grouping and we'll enforce FK going forward
INSERT INTO scanned_tokens (
  scan_id,
  token_address,
  chain,
  symbol,
  name,
  discovered_by_bots,
  
  -- Market data
  market_cap,
  liquidity,
  volume_24h,
  
  -- Trading activity (scanner)
  scanner_data,
  bot_activity_json,
  total_bots_count,
  multi_bot_signal,
  
  -- Trading activity (DexScreener)
  txn_buys_5m,
  txn_sells_5m,
  buy_sell_ratio,
  
  -- Security
  risk_score,
  age_hours,
  
  created_at
)
SELECT 
  d.scan_id,
  d.token_address,
  d.chain,
  d.symbol,
  d.name,
  d.discovered_by_bots,
  
  -- Market data
  d.market_cap,
  d.liquidity,
  d.volume_24h,
  
  -- Trading activity (scanner)
  d.scanner_data,
  d.bot_activity_json,
  d.total_bots_count,
  d.multi_bot_signal,
  
  -- Trading activity (DexScreener)
  d.txn_buys_5m,
  d.txn_sells_5m,
  d.buy_sell_ratio,
  
  -- Security
  d.risk_score,
  d.age_hours,
  
  d.timestamp
FROM decisions d
WHERE d.scan_id IS NOT NULL  -- Only migrate decisions that have scan_id
ON CONFLICT DO NOTHING;  -- Skip if token already exists for this scan_id

-- Log migration stats
DO $$
DECLARE
  decisions_count INTEGER;
  scanned_tokens_count INTEGER;
  migrated_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO decisions_count FROM decisions WHERE scan_id IS NOT NULL;
  SELECT COUNT(*) INTO scanned_tokens_count FROM scanned_tokens;
  
  -- Count how many decisions now have matching scanned_tokens
  SELECT COUNT(*) INTO migrated_count
  FROM decisions d
  INNER JOIN scanned_tokens st ON st.token_address = d.token_address AND st.scan_id = d.scan_id
  WHERE d.scan_id IS NOT NULL;
  
  RAISE NOTICE '✅ Migration Stats:';
  RAISE NOTICE '   Decisions with scan_id: %', decisions_count;
  RAISE NOTICE '   Scanned tokens total: %', scanned_tokens_count;
  RAISE NOTICE '   Decisions with matching scanned_tokens: %', migrated_count;
END $$;

-- ============================================================================
-- STEP 3: Re-add foreign key constraint (only for NEW data going forward)
-- ============================================================================

-- Add FK back but don't enforce it on existing data
-- This allows historical data to remain, but enforces integrity going forward
ALTER TABLE scanned_tokens 
  ADD CONSTRAINT scanned_tokens_scan_id_fkey 
  FOREIGN KEY (scan_id) 
  REFERENCES scans(id) 
  ON DELETE CASCADE
  NOT VALID;  -- Don't validate existing rows

-- Note: Future inserts will require valid scan_id, but historical data is preserved
DO $$
BEGIN
  RAISE NOTICE '✅ Foreign key constraint re-added (NOT VALID for historical data)';
END $$;

-- ============================================================================
-- STEP 4: Drop redundant columns from decisions table
-- ============================================================================

ALTER TABLE decisions DROP COLUMN IF EXISTS market_cap;
ALTER TABLE decisions DROP COLUMN IF EXISTS liquidity;
ALTER TABLE decisions DROP COLUMN IF EXISTS volume_24h;
ALTER TABLE decisions DROP COLUMN IF EXISTS risk_score;
ALTER TABLE decisions DROP COLUMN IF EXISTS txn_buys_5m;
ALTER TABLE decisions DROP COLUMN IF EXISTS txn_sells_5m;
ALTER TABLE decisions DROP COLUMN IF EXISTS buy_sell_ratio;
ALTER TABLE decisions DROP COLUMN IF EXISTS age_hours;
ALTER TABLE decisions DROP COLUMN IF EXISTS discovered_by_bots;
ALTER TABLE decisions DROP COLUMN IF EXISTS bot_activity_json;
ALTER TABLE decisions DROP COLUMN IF EXISTS total_bots_count;
ALTER TABLE decisions DROP COLUMN IF EXISTS multi_bot_signal;
ALTER TABLE decisions DROP COLUMN IF EXISTS scanner_data;

-- Drop associated indexes
DROP INDEX IF EXISTS idx_decisions_scanner_data;
DROP INDEX IF EXISTS idx_decisions_discovered_by_bots;
DROP INDEX IF EXISTS idx_decisions_multi_bot;
DROP INDEX IF EXISTS idx_decisions_bot_activity;

-- Add comment
COMMENT ON TABLE decisions IS 'AI trading decisions. Join with scanned_tokens via (token_address, scan_id) for market/security data.';

-- Final summary
DO $$
BEGIN
  RAISE NOTICE '✅ Migration complete! Redundant columns dropped from decisions table.';
  RAISE NOTICE '   Use JOIN with scanned_tokens to access market/security data.';
END $$;

