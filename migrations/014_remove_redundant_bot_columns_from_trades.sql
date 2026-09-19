-- Migration 014: Remove redundant bot tracking columns from trades table
-- Bot info is already available in decisions table via decision_id foreign key
-- This removes data duplication and simplifies the schema

-- Drop indexes first
DROP INDEX IF EXISTS idx_trades_discovered_by_bots;
DROP INDEX IF EXISTS idx_trades_primary_bot;

-- Drop columns
ALTER TABLE trades DROP COLUMN IF EXISTS discovered_by_bots;
ALTER TABLE trades DROP COLUMN IF EXISTS primary_bot;

-- To get bot info, simply JOIN with decisions:
-- SELECT t.*, d.discovered_by_bots, d.primary_bot
-- FROM trades t
-- JOIN decisions d ON d.id = t.decision_id

