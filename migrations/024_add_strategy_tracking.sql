-- Migration 024: Add Strategy/Version Tracking
-- Tracks what scoring strategy/version was used for each decision
-- Enables performance comparison across different strategies
-- Uses a lookup table approach for normalization

-- Create strategies lookup table
CREATE TABLE IF NOT EXISTS strategies (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,                    -- 'ai' or 'point-based'
  version TEXT NOT NULL,                 -- e.g., 'v2.1-strategy-c'
  description TEXT,                      -- Human-readable description
  config_json JSONB,                     -- Full configuration details (weights, thresholds, etc)
  deployed_at TIMESTAMP DEFAULT NOW(),
  notes TEXT,                            -- Deployment notes, changes, etc
  is_active BOOLEAN DEFAULT TRUE,        -- Currently in use?
  
  UNIQUE(type, version)
);

-- Create index for lookups
CREATE INDEX IF NOT EXISTS idx_strategies_type_version ON strategies(type, version);
CREATE INDEX IF NOT EXISTS idx_strategies_active ON strategies(is_active);

-- Add strategy_id foreign key to decisions table (single column reference)
ALTER TABLE decisions 
ADD COLUMN IF NOT EXISTS strategy_id INTEGER REFERENCES strategies(id);

-- Add strategy_id to trades table for filtering trades/PnL by strategy
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS strategy_id INTEGER REFERENCES strategies(id);

-- Create index for querying decisions by strategy
CREATE INDEX IF NOT EXISTS idx_decisions_strategy_id ON decisions(strategy_id);
CREATE INDEX IF NOT EXISTS idx_trades_strategy_id ON trades(strategy_id);

-- Insert current strategies (historical + current)
INSERT INTO strategies (type, version, description, config_json, deployed_at, is_active, notes) VALUES
  ('point-based', 'v1.0-unbalanced', 'Original point-based: 90pts fundamentals, 4pts market, 3pts activity, 2pts safety, 1.5pts timing', 
   '{"fundamentals": 90, "market": 4, "activity": 3, "safety": 2, "timing": 1.5, "threshold": 70}'::jsonb,
   '2024-11-01'::timestamp, FALSE, 'Initial implementation - heavily weighted towards age/buy-sell ratio'),
  
  ('point-based', 'v2.0-data-driven', 'Fixed age scoring (reversed to favor <6h), shifted buy/sell sweet spot to 1.5-2.0, added volume decay bonus',
   '{"fundamentals": 90, "market": 4, "activity": 3, "safety": 2, "timing": 1.5, "threshold": 70, "changes": ["reversed_age_scoring", "shifted_buy_sell_sweet_spot", "added_volume_decay_bonus", "penalize_high_24h_volume"]}'::jsonb,
   '2024-11-15'::timestamp, FALSE, 'Data-driven fixes based on correlation analysis'),
  
  ('point-based', 'v2.1-strategy-c', 'Hybrid rebalanced: correlation-driven (30pts timing/volume decay) + range effects (35pts fundamentals). Threshold lowered to 65.',
   '{"fundamentals": 35, "timing": 30, "activity": 15, "safety": 10, "market": 10, "threshold": 65, "best_predictor": "volume_decay_6h_24h", "correlation": 0.2132}'::jsonb,
   NOW(), TRUE, 'Strategy C (Hybrid): Massively increased timing weight (volume decay = BEST predictor +0.2132), rebalanced all categories based on 9,259 token correlation analysis')
ON CONFLICT (type, version) DO UPDATE SET
  description = EXCLUDED.description,
  config_json = EXCLUDED.config_json,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes;

-- Comments
COMMENT ON TABLE strategies IS 'Lookup table for all scoring strategies and versions used by the bot';
COMMENT ON COLUMN strategies.type IS 'Strategy type: ai (Claude-based) or point-based (correlation-driven scoring)';
COMMENT ON COLUMN strategies.version IS 'Version identifier in format vX.Y-description';
COMMENT ON COLUMN strategies.config_json IS 'Full configuration: weights, thresholds, special logic, correlation data';
COMMENT ON COLUMN strategies.is_active IS 'Is this strategy currently deployed?';
COMMENT ON COLUMN decisions.strategy_id IS 'Foreign key to strategies table - which strategy made this decision';
COMMENT ON COLUMN trades.strategy_id IS 'Foreign key to strategies table - which strategy generated this trade';

