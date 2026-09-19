-- Migration 011: Bot Performance Tracking (Minimal)
-- Add bot attribution to watchlist and trades for complete funnel tracking
-- Uses existing tables + small additions instead of creating new tables

-- ============================================================================
-- 1. Add bot_source to watchlist_entries (for tracking watchlist -> execution)
-- ============================================================================
ALTER TABLE watchlist_entries ADD COLUMN IF NOT EXISTS discovered_by_bots TEXT[];
ALTER TABLE watchlist_entries ADD COLUMN IF NOT EXISTS primary_bot TEXT;

CREATE INDEX IF NOT EXISTS idx_watchlist_discovered_by_bots ON watchlist_entries USING gin(discovered_by_bots);
CREATE INDEX IF NOT EXISTS idx_watchlist_primary_bot ON watchlist_entries(primary_bot);

COMMENT ON COLUMN watchlist_entries.discovered_by_bots IS 'Array of bot names that discovered this token';
COMMENT ON COLUMN watchlist_entries.primary_bot IS 'Primary bot credited with discovery (for single attribution)';

-- ============================================================================
-- 2. Add bot_source to trades table (which bot discovered this token)
-- ============================================================================
ALTER TABLE trades ADD COLUMN IF NOT EXISTS discovered_by_bots TEXT[];
ALTER TABLE trades ADD COLUMN IF NOT EXISTS primary_bot TEXT;

CREATE INDEX IF NOT EXISTS idx_trades_discovered_by_bots ON trades USING gin(discovered_by_bots);
CREATE INDEX IF NOT EXISTS idx_trades_primary_bot ON trades(primary_bot);

COMMENT ON COLUMN trades.discovered_by_bots IS 'Array of bot names that discovered this token';
COMMENT ON COLUMN trades.primary_bot IS 'Primary bot credited with discovery (for single attribution)';

-- ============================================================================
-- Bot Performance Tracking Strategy (using existing tables):
-- ============================================================================
-- 
-- 1. Discovery Metrics (tokens found per bot):
--    Query: scans.bot_breakdown (JSONB)
--
-- 2. AI Decisions (tokens sent to AI, buy vs skip):
--    Query: decisions.discovered_by_bots + decisions.should_buy
--
-- 3. Watchlist Conversion (watchlist -> execution):
--    Query: watchlist_entries.discovered_by_bots + watchlist_entries.status
--
-- 4. Trade PnL (which bot's tokens are profitable):
--    Query: trades.discovered_by_bots + trades.pnl_percent
--
-- See docs/BOT_PERFORMANCE_QUERIES.md for complete analytics queries
-- ============================================================================

