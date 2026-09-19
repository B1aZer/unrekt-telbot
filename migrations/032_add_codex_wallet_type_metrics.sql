-- Migration 032: Add Codex Wallet Type Metrics
-- Add bundler, sniper, insider, and dev wallet metrics from Codex API
-- These are strong risk signals for pump & dump detection

-- Wallet type counts
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS bundler_count INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS sniper_count INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS insider_count INTEGER;

-- Wallet type held percentages
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS bundler_held_percentage DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS sniper_held_percentage DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS insider_held_percentage DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS dev_held_percentage DOUBLE PRECISION;

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_bundler_count ON scanned_tokens(bundler_count) WHERE bundler_count IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_sniper_count ON scanned_tokens(sniper_count) WHERE sniper_count IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_insider_count ON scanned_tokens(insider_count) WHERE insider_count IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_bundler_held ON scanned_tokens(bundler_held_percentage) WHERE bundler_held_percentage IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_sniper_held ON scanned_tokens(sniper_held_percentage) WHERE sniper_held_percentage IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_insider_held ON scanned_tokens(insider_held_percentage) WHERE insider_held_percentage IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_dev_held ON scanned_tokens(dev_held_percentage) WHERE dev_held_percentage IS NOT NULL;

-- Add composite index for risk filtering
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_wallet_risk ON scanned_tokens(
  bundler_held_percentage, 
  sniper_held_percentage, 
  insider_held_percentage
) WHERE bundler_held_percentage IS NOT NULL OR sniper_held_percentage IS NOT NULL OR insider_held_percentage IS NOT NULL;

-- Add comments
COMMENT ON COLUMN scanned_tokens.bundler_count IS 'Number of bundler wallets from Codex (risk signal)';
COMMENT ON COLUMN scanned_tokens.sniper_count IS 'Number of sniper wallets from Codex (risk signal)';
COMMENT ON COLUMN scanned_tokens.insider_count IS 'Number of insider wallets from Codex (risk signal)';
COMMENT ON COLUMN scanned_tokens.bundler_held_percentage IS 'Percentage of supply held by bundlers from Codex (high = pump & dump risk)';
COMMENT ON COLUMN scanned_tokens.sniper_held_percentage IS 'Percentage of supply held by snipers from Codex (high = pump & dump risk)';
COMMENT ON COLUMN scanned_tokens.insider_held_percentage IS 'Percentage of supply held by insiders from Codex (high = rug risk)';
COMMENT ON COLUMN scanned_tokens.dev_held_percentage IS 'Percentage of supply held by devs from Codex (high = rug risk)';

