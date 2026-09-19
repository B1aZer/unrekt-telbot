-- Migration 006: Add scanner_data to decisions table
-- Stores raw scanner metrics when decision was made

ALTER TABLE decisions ADD COLUMN IF NOT EXISTS scanner_data JSONB;

-- Index for querying by scanner metrics
CREATE INDEX IF NOT EXISTS idx_decisions_scanner_data 
  ON decisions USING gin(scanner_data);

