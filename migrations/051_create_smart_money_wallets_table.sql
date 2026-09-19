-- Migration 051: Create Smart Money Wallets Table
-- Store high-profile Solana trader wallets in database for easy management

CREATE TABLE IF NOT EXISTS smart_money_wallets (
  id SERIAL PRIMARY KEY,
  address VARCHAR(44) NOT NULL UNIQUE,  -- Solana addresses are 32-44 chars
  name VARCHAR(255),                     -- Optional label for tracking
  tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),  -- 1 = usual/good, 2 = consistent, 3 = legendary
  notes TEXT,                            -- Optional performance notes
  is_active BOOLEAN DEFAULT TRUE,        -- Can disable wallets without deleting
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- Performance tracking (optional, can be updated later)
  total_trades INTEGER DEFAULT 0,
  win_rate DOUBLE PRECISION,
  avg_pnl_percent DOUBLE PRECISION,
  last_seen_at TIMESTAMP
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_smart_money_wallets_address ON smart_money_wallets(address);
CREATE INDEX IF NOT EXISTS idx_smart_money_wallets_tier ON smart_money_wallets(tier);
CREATE INDEX IF NOT EXISTS idx_smart_money_wallets_active ON smart_money_wallets(is_active) WHERE is_active = TRUE;

-- Comments
COMMENT ON TABLE smart_money_wallets IS 'High-profile Solana traders with proven track records';
COMMENT ON COLUMN smart_money_wallets.tier IS '1 = Usual/Good (1x weight), 2 = Consistent (2x weight), 3 = Legendary (3x weight)';
COMMENT ON COLUMN smart_money_wallets.is_active IS 'FALSE to temporarily disable a wallet without deleting';

