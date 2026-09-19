-- Migration 035: Remove type column from strategies table
-- Simplifies strategy tracking by removing the type field
-- Version is now the unique identifier for strategies

-- Drop the unique constraint on (type, version)
ALTER TABLE strategies DROP CONSTRAINT IF EXISTS strategies_type_version_key;

-- Drop the index on (type, version)
DROP INDEX IF EXISTS idx_strategies_type_version;

-- Create unique constraint on version only
ALTER TABLE strategies ADD CONSTRAINT strategies_version_key UNIQUE (version);

-- Create index on version for lookups
CREATE INDEX IF NOT EXISTS idx_strategies_version ON strategies(version);

-- Drop the type column
ALTER TABLE strategies DROP COLUMN IF EXISTS type;

-- Update comments
COMMENT ON TABLE strategies IS 'Lookup table for all scoring strategies and versions used by the bot';
COMMENT ON COLUMN strategies.version IS 'Version identifier in format vX.Y-description (unique)';
COMMENT ON COLUMN strategies.config_json IS 'Full configuration: weights, thresholds, special logic, correlation data';
COMMENT ON COLUMN strategies.is_active IS 'Is this strategy currently deployed?';
COMMENT ON COLUMN decisions.strategy_id IS 'Foreign key to strategies table - which strategy made this decision';
COMMENT ON COLUMN trades.strategy_id IS 'Foreign key to strategies table - which strategy generated this trade';

