-- Migration 043: Remove regime_global column
-- 
-- regime_global is now calculated on-the-fly from the 4 individual regimes
-- No need to store it in the database - it's deterministic and can be computed when needed
-- This saves storage and ensures consistency

-- Drop the index first
DROP INDEX IF EXISTS idx_scans_regime_global;

-- Drop the column
ALTER TABLE scans DROP COLUMN IF EXISTS regime_global;

COMMENT ON TABLE scans IS 'regime_global is now calculated on-the-fly using classifyGlobalRegime() function';

