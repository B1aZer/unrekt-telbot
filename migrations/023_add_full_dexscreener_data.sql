-- Migration 023: Add Full DexScreener Data Storage
-- Store all DexScreener volume and transaction data for comprehensive analysis

-- Add missing columns to scanned_tokens table
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_1h DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_6h DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS txn_buys_1h INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS txn_sells_1h INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS txn_buys_6h INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS txn_sells_6h INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS txn_buys_24h INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS txn_sells_24h INTEGER;

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_volume_1h ON scanned_tokens(volume_1h) WHERE volume_1h IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_txn_buys_1h ON scanned_tokens(txn_buys_1h) WHERE txn_buys_1h IS NOT NULL;

-- Add comments
COMMENT ON COLUMN scanned_tokens.volume_1h IS '1-hour volume from DexScreener (USD)';
COMMENT ON COLUMN scanned_tokens.volume_6h IS '6-hour volume from DexScreener (USD)';
COMMENT ON COLUMN scanned_tokens.txn_buys_1h IS 'Buy transaction count in last 1 hour from DexScreener';
COMMENT ON COLUMN scanned_tokens.txn_sells_1h IS 'Sell transaction count in last 1 hour from DexScreener';
COMMENT ON COLUMN scanned_tokens.txn_buys_6h IS 'Buy transaction count in last 6 hours from DexScreener';
COMMENT ON COLUMN scanned_tokens.txn_sells_6h IS 'Sell transaction count in last 6 hours from DexScreener';
COMMENT ON COLUMN scanned_tokens.txn_buys_24h IS 'Buy transaction count in last 24 hours from DexScreener';
COMMENT ON COLUMN scanned_tokens.txn_sells_24h IS 'Sell transaction count in last 24 hours from DexScreener';

-- Note: decisions table doesn't need these columns as it's primarily for decision metadata
-- All detailed DexScreener data is stored in scanned_tokens and can be joined via token_address

