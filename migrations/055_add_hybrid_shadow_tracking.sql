-- Migration 055: Add Hybrid Shadow Trading Tables
-- Purpose: Track hybrid strategy decisions and simulated trades without affecting live trading
-- This enables shadow mode testing and comparison

-- ============================================================================
-- HYBRID SHADOW DECISIONS TABLE
-- Tracks every decision made by hybrid strategy (parallel to live decisions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hybrid_shadow_decisions (
  id SERIAL PRIMARY KEY,
  
  -- Link to scan
  scan_id TEXT REFERENCES scans(id),
  scanned_token_id INTEGER REFERENCES scanned_tokens(id),
  
  -- Token info
  token_address TEXT NOT NULL,
  symbol TEXT,
  chain TEXT DEFAULT 'solana',
  
  -- Prices
  scan_price NUMERIC,          -- Price at scan time
  decision_price NUMERIC,      -- Price at decision time (fair entry)
  
  -- ML Predictions (4 models)
  entry_prob NUMERIC,          -- Entry model probability
  crash_pred NUMERIC,          -- Crash model prediction (min_gain %)
  upside_pred NUMERIC,         -- Upside model prediction (max_gain %)
  regime_prob NUMERIC,         -- Regime model probability (0-1)
  
  -- Calculated values
  risk_reward_ratio NUMERIC,   -- upside_pred / abs(crash_pred)
  position_pct NUMERIC,        -- Calculated position size %
  
  -- Filters applied
  passed_entry_filter BOOLEAN DEFAULT FALSE,
  passed_crash_filter BOOLEAN DEFAULT FALSE,
  passed_rr_filter BOOLEAN DEFAULT FALSE,
  should_trade BOOLEAN DEFAULT FALSE,
  
  -- Filter thresholds used
  entry_threshold NUMERIC DEFAULT 0.50,
  crash_threshold NUMERIC DEFAULT -38.0,
  rr_threshold NUMERIC DEFAULT 2.0,
  
  -- Skip reason (if not trading)
  skip_reason TEXT,
  
  -- Timestamps
  decision_timestamp TIMESTAMPTZ DEFAULT NOW(),
  
  -- Model versions
  entry_model_version TEXT,
  crash_model_version TEXT,
  upside_model_version TEXT,
  regime_model_version TEXT
);

-- Indexes for querying
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_decisions_scan_id ON hybrid_shadow_decisions(scan_id);
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_decisions_token ON hybrid_shadow_decisions(token_address);
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_decisions_timestamp ON hybrid_shadow_decisions(decision_timestamp);
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_decisions_should_trade ON hybrid_shadow_decisions(should_trade);

-- ============================================================================
-- HYBRID SHADOW TRADES TABLE
-- Simulated trades for decisions where should_trade = true
-- ============================================================================
CREATE TABLE IF NOT EXISTS hybrid_shadow_trades (
  id SERIAL PRIMARY KEY,
  
  -- Link to decision
  decision_id INTEGER REFERENCES hybrid_shadow_decisions(id),
  
  -- Token info
  token_address TEXT NOT NULL,
  symbol TEXT,
  chain TEXT DEFAULT 'solana',
  
  -- Entry
  entry_price NUMERIC NOT NULL,            -- decision_price (fair entry)
  entry_timestamp TIMESTAMPTZ DEFAULT NOW(),
  position_pct NUMERIC,                    -- Position size %
  position_usd NUMERIC,                    -- Position size in USD (based on $1000 starting)
  
  -- ML predictions at entry
  entry_prob NUMERIC,
  crash_pred NUMERIC,
  upside_pred NUMERIC,
  regime_prob NUMERIC,
  
  -- Exit (filled when trade exits)
  exit_price NUMERIC,
  exit_timestamp TIMESTAMPTZ,
  exit_minutes INTEGER,                    -- 15 for normal, 20-30 for extended
  exit_reason TEXT,                        -- 'timed_15m', 'dynamic_20m', 'dynamic_25m', 'dynamic_30m'
  extended BOOLEAN DEFAULT FALSE,
  extension_reason TEXT,                   -- 'ml_exit', 'rule_max_extension', 'rule_block_deep_loser'
  
  -- P&L
  pnl_pct NUMERIC,                         -- Return %
  pnl_usd NUMERIC,                         -- P&L in USD
  
  -- Status
  status TEXT DEFAULT 'open',              -- 'open', 'closed'
  
  -- Tracking
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for querying
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_trades_decision_id ON hybrid_shadow_trades(decision_id);
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_trades_token ON hybrid_shadow_trades(token_address);
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_trades_status ON hybrid_shadow_trades(status);
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_trades_entry_timestamp ON hybrid_shadow_trades(entry_timestamp);
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_trades_exit_timestamp ON hybrid_shadow_trades(exit_timestamp);

-- ============================================================================
-- HYBRID STRATEGY ENTRY IN STRATEGIES TABLE
-- ============================================================================
INSERT INTO strategies (version, description, config_json, is_active, notes) VALUES
(
  'v5.0-Naomi',
  'ML Hybrid Shadow Mode: Entry + Crash + Upside + Regime (15m timed exit, no SL/TP)',
  '{
    "mode": "shadow",
    "models": {
      "entry": "current_entry_no_market_sol.pkl",
      "crash": "current_crash_no_market_sol.pkl",
      "upside": "current_upside_no_market_sol.pkl",
      "regime": "regime_model_*.pkl"
    },
    "filters": {
      "entry_confidence": 0.50,
      "max_crash_risk": -38.0,
      "min_risk_reward_ratio": 2.0
    },
    "position_sizing": {
      "base_pct": 1.0,
      "max_pct": 2.5,
      "max_trades_per_scan": 12
    },
    "exit": {
      "minutes": 15,
      "stop_loss": null,
      "take_profit": null
    }
  }'::jsonb,
  FALSE,  -- Not active for live trading
  'Shadow mode for hybrid strategy testing. Logs decisions and simulates trades without executing.'
)
ON CONFLICT (version) DO UPDATE SET
  description = EXCLUDED.description,
  config_json = EXCLUDED.config_json,
  notes = EXCLUDED.notes;

-- ============================================================================
-- VIEWS FOR ANALYTICS
-- ============================================================================

-- Daily shadow performance
CREATE OR REPLACE VIEW hybrid_shadow_daily_stats AS
SELECT 
  DATE(t.entry_timestamp) as date,
  COUNT(*) as trades,
  COUNT(*) FILTER (WHERE t.pnl_pct > 0) as wins,
  COUNT(*) FILTER (WHERE t.pnl_pct <= 0) as losses,
  ROUND(100.0 * COUNT(*) FILTER (WHERE t.pnl_pct > 0) / NULLIF(COUNT(*), 0), 1) as win_rate,
  ROUND(SUM(t.pnl_usd)::numeric, 2) as total_pnl_usd,
  ROUND(AVG(t.pnl_pct)::numeric, 2) as avg_return_pct,
  ROUND(SUM(t.pnl_pct)::numeric, 2) as total_return_pct,
  COUNT(*) FILTER (WHERE t.extended) as extended_trades,
  ROUND(100.0 * COUNT(*) FILTER (WHERE t.extended) / NULLIF(COUNT(*), 0), 1) as extension_rate
FROM hybrid_shadow_trades t
WHERE t.status = 'closed'
GROUP BY DATE(t.entry_timestamp)
ORDER BY date DESC;

-- Overall shadow stats
CREATE OR REPLACE VIEW hybrid_shadow_summary AS
SELECT 
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE pnl_pct > 0) as wins,
  COUNT(*) FILTER (WHERE pnl_pct <= 0) as losses,
  ROUND(100.0 * COUNT(*) FILTER (WHERE pnl_pct > 0) / NULLIF(COUNT(*), 0), 1) as win_rate,
  ROUND(SUM(pnl_usd)::numeric, 2) as total_pnl_usd,
  ROUND(AVG(pnl_pct)::numeric, 2) as avg_return_pct,
  ROUND(SUM(pnl_pct)::numeric, 2) as total_return_pct,
  ROUND(SUM(CASE WHEN pnl_pct > 0 THEN pnl_usd ELSE 0 END) / 
        NULLIF(ABS(SUM(CASE WHEN pnl_pct <= 0 THEN pnl_usd ELSE 0 END)), 0)::numeric, 2) as profit_factor,
  COUNT(*) FILTER (WHERE extended) as extended_trades,
  ROUND(100.0 * COUNT(*) FILTER (WHERE extended) / NULLIF(COUNT(*), 0), 1) as extension_rate,
  MIN(entry_timestamp) as first_trade,
  MAX(entry_timestamp) as last_trade,
  COUNT(DISTINCT DATE(entry_timestamp)) as trading_days
FROM hybrid_shadow_trades
WHERE status = 'closed';

-- Decision funnel (how many tokens pass each filter)
CREATE OR REPLACE VIEW hybrid_shadow_decision_funnel AS
SELECT 
  DATE(decision_timestamp) as date,
  COUNT(*) as total_decisions,
  COUNT(*) FILTER (WHERE passed_entry_filter) as passed_entry,
  COUNT(*) FILTER (WHERE passed_crash_filter) as passed_crash,
  COUNT(*) FILTER (WHERE passed_rr_filter) as passed_rr,
  COUNT(*) FILTER (WHERE should_trade) as should_trade,
  ROUND(100.0 * COUNT(*) FILTER (WHERE should_trade) / NULLIF(COUNT(*), 0), 1) as trade_rate_pct
FROM hybrid_shadow_decisions
GROUP BY DATE(decision_timestamp)
ORDER BY date DESC;

COMMENT ON TABLE hybrid_shadow_decisions IS 'Hybrid strategy decisions in shadow mode (not executed)';
COMMENT ON TABLE hybrid_shadow_trades IS 'Simulated trades from hybrid shadow decisions';
COMMENT ON VIEW hybrid_shadow_daily_stats IS 'Daily P&L stats for hybrid shadow trades';
COMMENT ON VIEW hybrid_shadow_summary IS 'Overall summary stats for hybrid shadow trading';
COMMENT ON VIEW hybrid_shadow_decision_funnel IS 'Filter funnel showing how many tokens pass each stage';

