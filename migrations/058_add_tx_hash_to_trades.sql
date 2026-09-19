-- Migration 058: Add transaction hash columns to trades tables for real trading
-- Purpose: Track blockchain transaction hashes for real Solana swaps

-- Add tx_hash to regular trades table (paper-trader)
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS tx_hash TEXT;

ALTER TABLE trades
ADD COLUMN IF NOT EXISTS exit_tx_hash TEXT;

-- Add indexes for querying
CREATE INDEX IF NOT EXISTS idx_trades_tx_hash ON trades(tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trades_exit_tx_hash ON trades(exit_tx_hash) WHERE exit_tx_hash IS NOT NULL;

-- Add comments
COMMENT ON COLUMN trades.tx_hash IS 'Solana transaction hash for entry swap (buy)';
COMMENT ON COLUMN trades.exit_tx_hash IS 'Solana transaction hash for exit swap (sell)';

-- Add tx_hash to hybrid_shadow_trades table (for consistency)
ALTER TABLE hybrid_shadow_trades
ADD COLUMN IF NOT EXISTS tx_hash TEXT;

ALTER TABLE hybrid_shadow_trades
ADD COLUMN IF NOT EXISTS exit_tx_hash TEXT;

-- Add indexes for querying
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_trades_tx_hash ON hybrid_shadow_trades(tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_trades_exit_tx_hash ON hybrid_shadow_trades(exit_tx_hash) WHERE exit_tx_hash IS NOT NULL;

-- Add comments
COMMENT ON COLUMN hybrid_shadow_trades.tx_hash IS 'Solana transaction hash for entry swap (buy) - only populated for real trading';
COMMENT ON COLUMN hybrid_shadow_trades.exit_tx_hash IS 'Solana transaction hash for exit swap (sell) - only populated for real trading';
