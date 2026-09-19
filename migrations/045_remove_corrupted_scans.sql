-- Migration 045: Remove corrupted scans from database issue period
-- 
-- These scans (scan_1764520104309 to scan_1764521292696) were created during a database
-- issue where regime data couldn't be written. They have no dependent records:
-- - 0 scanned_tokens records
-- - 0 decisions records
-- - 0 trades records
-- - 0 watchlist records
--
-- Safe to delete as they have no data dependencies.

DELETE FROM scans
WHERE id >= 'scan_1764520104309' 
  AND id <= 'scan_1764521292696'
  AND regime_trend_score IS NULL
  AND regime_liquidity_score IS NULL
  AND regime_risk_score IS NULL
  AND regime_micro_score IS NULL;

-- Verify deletion
-- Expected: 4 rows deleted
-- SELECT COUNT(*) FROM scans WHERE id >= 'scan_1764520104309' AND id <= 'scan_1764521292696';

