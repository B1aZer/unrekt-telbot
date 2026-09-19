-- Migration 007: Add bot discovery tracking to decisions table
-- Tracks which bots discovered/traded each token

-- Add bot discovery columns
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS discovered_by_bots TEXT[];
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS bot_activity_json JSONB;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS multi_bot_signal BOOLEAN DEFAULT FALSE;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS total_bots_count INTEGER DEFAULT 0;

-- Indexes for bot analysis queries
CREATE INDEX IF NOT EXISTS idx_decisions_discovered_by_bots 
  ON decisions USING gin(discovered_by_bots);

CREATE INDEX IF NOT EXISTS idx_decisions_multi_bot 
  ON decisions(multi_bot_signal);

CREATE INDEX IF NOT EXISTS idx_decisions_bot_activity 
  ON decisions USING gin(bot_activity_json);

-- Add comment explaining the columns
COMMENT ON COLUMN decisions.discovered_by_bots IS 'Array of bot names that traded this token (e.g. ["BananaGun", "Maestro"])';
COMMENT ON COLUMN decisions.bot_activity_json IS 'Detailed bot activity: {"BananaGun": {"buys": 5, "sells": 1}, "Maestro": {"buys": 3, "sells": 0}}';
COMMENT ON COLUMN decisions.multi_bot_signal IS 'TRUE if token was discovered by 2+ bots (stronger signal)';
COMMENT ON COLUMN decisions.total_bots_count IS 'Total number of different bots that traded this token';

