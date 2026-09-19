-- Migration 028: Drop holder_count column from scanned_tokens
-- 
-- holder_count was redundant with holders column (from Codex API)
-- holder_count came from security scanners (GoPlus/RugCheck) and was often empty/unreliable
-- We use holders from Codex API instead, which is more complete and reliable

-- Drop the holder_count column
ALTER TABLE scanned_tokens DROP COLUMN IF EXISTS holder_count;

-- Display confirmation
SELECT 
  'Migration 028 completed: Dropped holder_count column from scanned_tokens' as status,
  COUNT(*) as total_scanned_tokens
FROM scanned_tokens;

