-- Migration 015: Move opportunities/risks/warnings to decisions, remove redundant columns from watchlist
-- 
-- Changes:
-- 1. Add opportunities, risks, warnings to decisions table (they're part of AI decision)
-- 2. Remove all sonnet columns from watchlist_entries (get via decision_id JOIN)
-- 3. Remove bot columns from watchlist_entries (get via decision_id JOIN)

-- ============================================================================
-- 1. Add opportunities/risks/warnings to decisions table
-- ============================================================================
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS opportunities TEXT[];
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS risks TEXT[];
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS warnings TEXT[];

CREATE INDEX IF NOT EXISTS idx_decisions_opportunities ON decisions USING gin(opportunities);
CREATE INDEX IF NOT EXISTS idx_decisions_risks ON decisions USING gin(risks);
CREATE INDEX IF NOT EXISTS idx_decisions_warnings ON decisions USING gin(warnings);

COMMENT ON COLUMN decisions.opportunities IS 'Array of opportunities identified by AI (for Telegram messages)';
COMMENT ON COLUMN decisions.risks IS 'Array of risks identified by AI (for Telegram messages)';
COMMENT ON COLUMN decisions.warnings IS 'Array of warnings identified by AI (for Telegram messages)';

-- ============================================================================
-- 2. Remove redundant columns from watchlist_entries
-- ============================================================================

-- Drop indexes first
DROP INDEX IF EXISTS idx_watchlist_discovered_by_bots;
DROP INDEX IF EXISTS idx_watchlist_primary_bot;

-- Remove bot columns (get via decision_id JOIN)
ALTER TABLE watchlist_entries DROP COLUMN IF EXISTS discovered_by_bots;
ALTER TABLE watchlist_entries DROP COLUMN IF EXISTS primary_bot;

-- Remove sonnet columns (get via decision_id JOIN)
ALTER TABLE watchlist_entries DROP COLUMN IF EXISTS sonnet_analysis;
ALTER TABLE watchlist_entries DROP COLUMN IF EXISTS sonnet_confidence;
ALTER TABLE watchlist_entries DROP COLUMN IF EXISTS sonnet_opportunities;
ALTER TABLE watchlist_entries DROP COLUMN IF EXISTS sonnet_risks;
ALTER TABLE watchlist_entries DROP COLUMN IF EXISTS sonnet_warnings;

-- ============================================================================
-- Usage Notes:
-- ============================================================================
-- To get all watchlist data including AI analysis:
-- SELECT 
--   w.*,
--   d.reasoning as sonnet_analysis,
--   d.confidence as sonnet_confidence,
--   d.opportunities,
--   d.risks,
--   d.warnings,
--   d.discovered_by_bots,
--   d.bot_activity_json
-- FROM watchlist_entries w
-- JOIN decisions d ON d.id = w.decision_id;

