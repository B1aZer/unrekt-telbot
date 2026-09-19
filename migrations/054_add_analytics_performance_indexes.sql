-- Migration 054: Add indexes for analytics API performance
-- These indexes optimize the /api/token-flow endpoint which joins multiple tables
-- 
-- Performance improvements:
-- - Strategy filter: 11s -> 15ms (COUNT), 4.7s -> 380ms (data query)
-- - Default 24h query: 10s -> 1.2s
-- - flowStage=trade: now ~38ms
--
-- Created: 2025-12-20

-- Index for efficient JOIN between decisions and scanned_tokens
-- Used when starting query from decisions table (strategy filter optimization)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_decisions_token_scan 
  ON decisions(token_address, scan_id);

-- Reverse index for efficient JOIN from scanned_tokens to decisions
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scanned_tokens_token_scan 
  ON scanned_tokens(token_address, scan_id);

-- Composite index for strategy + timestamp filtering and sorting
-- Critical for strategy filter performance (filters by strategy_id, sorts by timestamp DESC)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_decisions_strategy_timestamp 
  ON decisions(strategy_id, timestamp DESC);

