-- Migration 057: Add features logging to hybrid shadow decisions
-- Purpose: Store exact features sent to ML service for comparison with backtest

-- Add JSONB column to store features snapshot
ALTER TABLE hybrid_shadow_decisions
ADD COLUMN IF NOT EXISTS features_json JSONB;

-- Add index for querying by features (useful for finding similar tokens)
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_decisions_features ON hybrid_shadow_decisions USING GIN (features_json);

-- Add index for token matching (token_address + scan_timestamp)
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_decisions_token_scan ON hybrid_shadow_decisions(token_address, scan_id);

COMMENT ON COLUMN hybrid_shadow_decisions.features_json IS 'Snapshot of all features sent to ML service (JSONB for querying and comparison)';

