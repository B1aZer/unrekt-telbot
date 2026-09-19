-- Migration 018: Add scanned_tokens table for missed opportunity tracking
-- 
-- Comprehensive snapshot of ALL tokens from each scan
-- Stores all data we gather during scan/monitor phase
-- Join with decisions/watchlist/trades to see where token stopped in funnel

CREATE TABLE IF NOT EXISTS scanned_tokens (
  id SERIAL PRIMARY KEY,
  
  -- Link to scan
  scan_id TEXT NOT NULL REFERENCES scans(id),
  
  -- Token identification
  token_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  
  -- Bot discovery
  discovered_by_bots TEXT[],
  
  -- Market data (from Codex)
  price_usd DOUBLE PRECISION,
  market_cap DOUBLE PRECISION,
  liquidity DOUBLE PRECISION,          -- Match decisions.liquidity
  volume_24h DOUBLE PRECISION,
  price_change_24h DOUBLE PRECISION,
  holders INTEGER,
  
  -- Trading activity (from scanner - bot trades)
  scanner_data JSONB,                  -- Match decisions.scanner_data (raw bot trade data)
  bot_buys INTEGER,
  bot_sells INTEGER,
  net_buys INTEGER,
  unique_users INTEGER,
  total_activity INTEGER,
  bot_activity_json JSONB,             -- Match decisions.bot_activity_json (per-bot breakdown)
  total_bots_count INTEGER,            -- Match decisions.total_bots_count
  multi_bot_signal BOOLEAN,            -- Match decisions.multi_bot_signal
  
  -- Trading activity (from DexScreener - all DEX trades)
  volume_5m DOUBLE PRECISION,
  txn_buys_5m INTEGER,                 -- Match decisions.txn_buys_5m
  txn_sells_5m INTEGER,                -- Match decisions.txn_sells_5m
  buy_sell_ratio DOUBLE PRECISION,     -- Match decisions.buy_sell_ratio
  
  -- Security analysis (from GoPlus/RugCheck)
  is_safe BOOLEAN,
  risk_score INTEGER,                  -- Match decisions.risk_score (0-100)
  honeypot_detected BOOLEAN,
  ownership_risk BOOLEAN,
  blacklist_detected BOOLEAN,
  hidden_functions BOOLEAN,
  buy_tax DOUBLE PRECISION,
  sell_tax DOUBLE PRECISION,
  can_take_back_ownership BOOLEAN,
  owner_percent DOUBLE PRECISION,
  top10_holder_percent DOUBLE PRECISION,
  holder_count INTEGER,
  age_hours DOUBLE PRECISION,          -- Match decisions.age_hours
  
  -- Metadata
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_scan_id ON scanned_tokens(scan_id);
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_token ON scanned_tokens(token_address, chain);
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_discovered_by_bots ON scanned_tokens USING gin(discovered_by_bots);
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_is_safe ON scanned_tokens(is_safe);
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_risk_score ON scanned_tokens(risk_score);
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_market_cap ON scanned_tokens(market_cap);
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_liquidity ON scanned_tokens(liquidity);

COMMENT ON TABLE scanned_tokens IS 'Comprehensive snapshot of all tokens from each scan. Join with decisions/watchlist/trades to analyze funnel progression and missed opportunities.';
COMMENT ON COLUMN scanned_tokens.bot_buys IS 'Buy transactions tracked by trading bots (Maestro, BonkBot, etc.)';
COMMENT ON COLUMN scanned_tokens.volume_5m IS 'Total volume in last 5 minutes (from DexScreener - all DEXs)';
COMMENT ON COLUMN scanned_tokens.risk_score IS 'Security risk score: 0 = safe, 100 = definitely scam';

