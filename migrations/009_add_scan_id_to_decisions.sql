-- Migration 009: Add scan_id to decisions table
-- Links decisions to their originating scan for analytics

-- Add scan_id column
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS scan_id TEXT;

-- Index for joining scans to decisions
CREATE INDEX IF NOT EXISTS idx_decisions_scan_id ON decisions(scan_id);

-- Add comment explaining the column
COMMENT ON COLUMN decisions.scan_id IS 'Links decision to the scan that discovered it (references scans.id)';

