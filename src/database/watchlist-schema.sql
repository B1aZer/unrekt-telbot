-- ============================================================================
-- Watchlist Table Schema (Dual-AI Entry Strategy)
-- ============================================================================
-- This table stores tokens that AI has signaled to BUY, but are under observation
-- before final entry decision. This implements a 2-minute watchlist system where:
-- 1. Sonnet AI signals BUY → Add to watchlist
-- 2. Observe price for 2 minutes
-- 3. Apply filter (skip obvious losers)
-- 4. Haiku AI re-checks → Execute or Skip
-- ============================================================================

CREATE TABLE IF NOT EXISTS watchlist_entries (
  id SERIAL PRIMARY KEY,
  
  -- Token identification
  token_address VARCHAR(100) NOT NULL,
  chain VARCHAR(20) NOT NULL,
  symbol VARCHAR(50),
  
  -- AI decision context (from Sonnet)
  decision_id INTEGER REFERENCES decisions(id),
  sonnet_analysis TEXT NOT NULL,         -- Full reasoning from Sonnet
  sonnet_confidence INTEGER NOT NULL,     -- 0-100
  sonnet_opportunities TEXT,              -- JSON array of opportunities
  sonnet_risks TEXT,                      -- JSON array of risks
  sonnet_warnings TEXT,                   -- JSON array of warnings
  signal_price DOUBLE PRECISION NOT NULL,  -- Price when Sonnet signaled BUY
  
  -- Monitoring data (updated every 30s)
  signal_timestamp TIMESTAMP NOT NULL,    -- When added to watchlist
  max_price_reached DOUBLE PRECISION,      -- Highest price during observation
  max_gain_percent DOUBLE PRECISION,        -- Max gain % from signal price
  min_price_reached DOUBLE PRECISION,      -- Lowest price during observation
  max_dump_percent DOUBLE PRECISION,        -- Max dump % from signal price
  
  -- Status tracking
  status VARCHAR(20) NOT NULL DEFAULT 'monitoring', -- 'monitoring', 'executed', 'skipped'
  skip_reason VARCHAR(100),               -- e.g., 'dump_no_recovery', 'no_momentum', 'haiku_rejected'
  executed_at TIMESTAMP,
  executed_price DOUBLE PRECISION,
  
  -- Haiku decision (if called)
  haiku_checked BOOLEAN DEFAULT false,
  haiku_analysis TEXT,                    -- Reasoning from Haiku (one sentence)
  haiku_decision VARCHAR(10),             -- 'BUY', 'SKIP'
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- Ensure only one monitoring entry per token per chain
  UNIQUE(token_address, chain) WHERE status = 'monitoring'
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_watchlist_status ON watchlist_entries(status);
CREATE INDEX IF NOT EXISTS idx_watchlist_signal_time ON watchlist_entries(signal_timestamp);
CREATE INDEX IF NOT EXISTS idx_watchlist_token_chain ON watchlist_entries(token_address, chain);

-- Comments for clarity
COMMENT ON TABLE watchlist_entries IS 'Tokens under observation before trade execution (Dual-AI strategy)';
COMMENT ON COLUMN watchlist_entries.sonnet_analysis IS 'Full AI analysis from initial Sonnet signal';
COMMENT ON COLUMN watchlist_entries.haiku_analysis IS 'Re-check analysis from Haiku after 2-minute observation';
COMMENT ON COLUMN watchlist_entries.skip_reason IS 'Why trade was skipped: dump_no_recovery, no_momentum, haiku_rejected';

