-- Migration 026: Add Commit Column to Strategies Table
-- Tracks which git commit deployed each strategy version

-- Add commit column
ALTER TABLE strategies 
ADD COLUMN IF NOT EXISTS commit_hash TEXT;

-- Create index for querying by commit
CREATE INDEX IF NOT EXISTS idx_strategies_commit ON strategies(commit_hash);

-- Update current active strategy with latest commit
UPDATE strategies 
SET commit_hash = 'ba4f68866566a71c8d883a9c2d738bbf8db48bfd'
WHERE type = 'point-based' AND version = 'v2.1-strategy-c';

-- Comment
COMMENT ON COLUMN strategies.commit_hash IS 'Git commit hash that deployed this strategy version';

-- Show updated strategies
SELECT 
  id, 
  type, 
  version, 
  commit_hash,
  is_active,
  deployed_at
FROM strategies 
ORDER BY deployed_at DESC;

