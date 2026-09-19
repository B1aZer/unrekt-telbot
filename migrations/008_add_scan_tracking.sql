-- Migration 008: Add scan tracking (scanner metrics only)
-- Tracks ONLY what the scanner does (not AI/trader metrics)

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,                     -- scan_id from TradingAnalyzer
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  chain TEXT NOT NULL,
  
  -- Scanner metrics only
  tokens_found INTEGER NOT NULL,           -- Total tokens discovered by bots
  tokens_filtered_security INTEGER DEFAULT 0,  -- Filtered by security hard stops
  tokens_filtered_activity INTEGER DEFAULT 0,  -- Filtered by activity thresholds
  tokens_filtered_liquidity INTEGER DEFAULT 0, -- Filtered by liquidity/volume
  tokens_analyzed INTEGER DEFAULT 0,        -- Sent to AI
  tokens_buy INTEGER DEFAULT 0,            -- AI said BUY
  tokens_skip INTEGER DEFAULT 0,           -- AI said SKIP
  bot_breakdown JSONB,                     -- {"Maestro": 12, "BonkBot": 8}
  
  -- Performance
  duration_ms INTEGER                      -- Scan duration
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp);
CREATE INDEX IF NOT EXISTS idx_scans_chain ON scans(chain);

COMMENT ON TABLE scans IS 'Scanner performance only. AI/trader metrics calculated from decisions/trades tables.';

