-- Decision Tracking Database Schema
-- SQLite database for logging AI decisions and paper trading

-- ============================================================================
-- Decisions Table: All AI decisions (BUY and SKIP)
-- ============================================================================
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  -- Token Info
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT,
  
  -- AI Decision
  should_buy BOOLEAN NOT NULL,
  confidence INTEGER NOT NULL,  -- 0-100
  reasoning TEXT,
  
  -- Token Metrics at Decision Time
  age_hours REAL,
  freshness_score INTEGER,
  market_cap REAL,
  liquidity REAL,
  volume_5m REAL,
  volume_acceleration REAL,
  unique_users INTEGER,
  total_trades INTEGER,
  risk_score INTEGER,
  
  -- Price Action
  price_usd REAL,
  price_change_1m REAL,
  price_change_5m REAL,
  trend TEXT,
  
  -- Position Details (if should_buy = true)
  position_size_percent REAL,
  position_size_usd REAL,
  stop_loss_percent REAL,
  take_profit_1 REAL,
  take_profit_2 REAL,
  take_profit_3 REAL,
  time_based_exit_seconds INTEGER,
  
  -- Outcome (filled later by paper trader)
  executed BOOLEAN DEFAULT FALSE,
  trade_id INTEGER,  -- links to trades table
  
  -- Metadata
  scan_id TEXT,  -- to group decisions from same scan
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (trade_id) REFERENCES trades(id)
);

-- ============================================================================
-- Trades Table: Paper trades (and eventually real trades)
-- ============================================================================
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL,
  
  -- Token Info
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  
  -- Entry
  entry_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  entry_price REAL NOT NULL,
  entry_amount_usd REAL NOT NULL,
  entry_slippage_percent REAL DEFAULT 0.5,  -- simulated slippage on entry
  entry_fee_percent REAL DEFAULT 0.3,       -- simulated DEX fee
  actual_entry_price REAL,  -- after slippage
  actual_entry_cost REAL,   -- after fees
  
  -- Position
  tokens_bought REAL,  -- amount of tokens
  
  -- Exit (filled when position closed)
  exit_timestamp DATETIME,
  exit_price REAL,
  exit_reason TEXT,  -- 'stop_loss', 'take_profit_1', 'take_profit_2', 'take_profit_3', 'time_based', 'manual'
  exit_slippage_percent REAL DEFAULT 0.5,
  exit_fee_percent REAL DEFAULT 0.3,
  actual_exit_price REAL,   -- after slippage
  actual_exit_amount REAL,  -- after fees
  
  -- Results
  pnl_percent REAL,  -- % gain/loss
  pnl_usd REAL,      -- USD gain/loss
  hold_duration_minutes INTEGER,
  max_price_reached REAL,  -- highest price during hold
  max_gain_percent REAL,   -- max potential gain %
  
  -- Status
  status TEXT DEFAULT 'open',  -- 'open', 'closed', 'failed'
  is_paper_trade BOOLEAN DEFAULT TRUE,
  
  -- Metadata
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
);

-- ============================================================================
-- Daily Performance Stats (aggregated)
-- ============================================================================
CREATE TABLE IF NOT EXISTS daily_stats (
  date DATE PRIMARY KEY,
  
  -- Decision Stats
  total_decisions INTEGER DEFAULT 0,
  buy_decisions INTEGER DEFAULT 0,
  skip_decisions INTEGER DEFAULT 0,
  buy_percentage REAL,
  
  -- Buy Decision Characteristics (averages)
  avg_risk_score REAL,
  avg_market_cap REAL,
  avg_age_hours REAL,
  avg_freshness_score REAL,
  avg_confidence REAL,
  avg_liquidity REAL,
  avg_volume_5m REAL,
  
  -- Trade Execution Stats
  total_trades INTEGER DEFAULT 0,
  executed_trades INTEGER DEFAULT 0,
  
  -- Outcome Stats (completed trades only)
  completed_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  win_rate REAL,
  
  -- PnL Stats
  avg_pnl_percent REAL,
  avg_winning_pnl_percent REAL,
  avg_losing_pnl_percent REAL,
  total_pnl_usd REAL,
  
  -- Best/Worst
  best_trade_pnl_percent REAL,
  worst_trade_pnl_percent REAL,
  best_trade_symbol TEXT,
  worst_trade_symbol TEXT,
  
  -- Timing
  avg_hold_duration_minutes REAL,
  
  -- Exit Reasons
  stop_loss_count INTEGER DEFAULT 0,
  take_profit_count INTEGER DEFAULT 0,
  time_based_exit_count INTEGER DEFAULT 0,
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Indexes for Performance
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
CREATE INDEX IF NOT EXISTS idx_decisions_token ON decisions(token_address);
CREATE INDEX IF NOT EXISTS idx_decisions_should_buy ON decisions(should_buy);
CREATE INDEX IF NOT EXISTS idx_decisions_scan_id ON decisions(scan_id);

CREATE INDEX IF NOT EXISTS idx_trades_decision ON trades(decision_id);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_entry_timestamp ON trades(entry_timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_address);

-- ============================================================================
-- Views for Easy Querying
-- ============================================================================

-- View: Recent BUY decisions with outcomes
CREATE VIEW IF NOT EXISTS v_recent_buy_decisions AS
SELECT 
  d.id,
  d.timestamp,
  d.token_address,
  d.symbol,
  d.confidence,
  d.age_hours,
  d.freshness_score,
  d.risk_score,
  d.market_cap,
  d.executed,
  t.status as trade_status,
  t.pnl_percent,
  t.pnl_usd,
  t.exit_reason
FROM decisions d
LEFT JOIN trades t ON d.trade_id = t.id
WHERE d.should_buy = TRUE
ORDER BY d.timestamp DESC
LIMIT 50;

-- View: Performance by freshness score
CREATE VIEW IF NOT EXISTS v_performance_by_freshness AS
SELECT 
  CASE 
    WHEN d.freshness_score >= 85 THEN 'Ultra Fresh (85-100)'
    WHEN d.freshness_score >= 70 THEN 'Fresh (70-84)'
    WHEN d.freshness_score >= 50 THEN 'Recent (50-69)'
    ELSE 'Established (<50)'
  END as freshness_category,
  COUNT(*) as total_trades,
  SUM(CASE WHEN t.pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN t.pnl_percent < 0 THEN 1 ELSE 0 END) as losses,
  ROUND(AVG(t.pnl_percent), 2) as avg_pnl_percent,
  ROUND(SUM(CASE WHEN t.pnl_percent > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as win_rate
FROM decisions d
JOIN trades t ON d.trade_id = t.id
WHERE d.should_buy = TRUE AND t.status = 'closed'
GROUP BY freshness_category
ORDER BY freshness_score DESC;

-- View: Performance by risk score
CREATE VIEW IF NOT EXISTS v_performance_by_risk AS
SELECT 
  CASE 
    WHEN d.risk_score <= 40 THEN 'Low Risk (0-40)'
    WHEN d.risk_score <= 60 THEN 'Medium Risk (41-60)'
    WHEN d.risk_score <= 75 THEN 'High Risk (61-75)'
    ELSE 'Very High Risk (76+)'
  END as risk_category,
  COUNT(*) as total_trades,
  SUM(CASE WHEN t.pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
  ROUND(AVG(t.pnl_percent), 2) as avg_pnl_percent,
  ROUND(SUM(CASE WHEN t.pnl_percent > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as win_rate
FROM decisions d
JOIN trades t ON d.trade_id = t.id
WHERE d.should_buy = TRUE AND t.status = 'closed'
GROUP BY risk_category;

