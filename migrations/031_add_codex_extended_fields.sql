-- Migration 031: Add Extended Codex Fields
-- Add volumes, transaction counts, unique wallets, wallet age metrics, and scam flag from Codex API

-- Volumes (multiple timeframes from Codex)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_5m_codex DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_1h_codex DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_4h_codex DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_6h_codex DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_24h_codex DOUBLE PRECISION; -- Rename existing volume_24h to volume_24h_codex? Or keep both?

-- Transaction counts from Codex (buy/sell counts)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS buy_count_5m_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS sell_count_5m_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS buy_count_1h_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS sell_count_1h_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS buy_count_4h_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS sell_count_4h_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS buy_count_24h_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS sell_count_24h_codex INTEGER;

-- Unique buys/sells from Codex
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS unique_buys_5m_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS unique_sells_5m_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS unique_buys_1h_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS unique_sells_1h_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS unique_buys_24h_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS unique_sells_24h_codex INTEGER;

-- Unique transaction wallets from Codex
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS unique_transactions_5m_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS unique_transactions_1h_codex INTEGER;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS unique_transactions_24h_codex INTEGER;

-- Wallet age metrics from Codex
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS swap_pct_1d_old_wallet DOUBLE PRECISION; -- % of swaps from wallets <1 day old
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS swap_pct_7d_old_wallet DOUBLE PRECISION; -- % of swaps from wallets <7 days old
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS wallet_age_avg DOUBLE PRECISION; -- Average age of wallets that traded (24h)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS wallet_age_std DOUBLE PRECISION; -- Standard deviation of wallet ages

-- Scam flag from Codex
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS is_scam_codex BOOLEAN;

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_volume_5m_codex ON scanned_tokens(volume_5m_codex) WHERE volume_5m_codex IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_volume_1h_codex ON scanned_tokens(volume_1h_codex) WHERE volume_1h_codex IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_is_scam_codex ON scanned_tokens(is_scam_codex) WHERE is_scam_codex = true;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_swap_pct_1d_old ON scanned_tokens(swap_pct_1d_old_wallet) WHERE swap_pct_1d_old_wallet IS NOT NULL;

-- Add comments
COMMENT ON COLUMN scanned_tokens.volume_5m_codex IS '5-minute volume from Codex API';
COMMENT ON COLUMN scanned_tokens.volume_1h_codex IS '1-hour volume from Codex API';
COMMENT ON COLUMN scanned_tokens.volume_4h_codex IS '4-hour volume from Codex API';
COMMENT ON COLUMN scanned_tokens.volume_6h_codex IS '6-hour volume from Codex API';
COMMENT ON COLUMN scanned_tokens.volume_24h_codex IS '24-hour volume from Codex API (separate from DexScreener volume_24h)';
COMMENT ON COLUMN scanned_tokens.buy_count_5m_codex IS 'Number of buy transactions in last 5 minutes from Codex';
COMMENT ON COLUMN scanned_tokens.sell_count_5m_codex IS 'Number of sell transactions in last 5 minutes from Codex';
COMMENT ON COLUMN scanned_tokens.unique_buys_5m_codex IS 'Number of unique wallets that bought in last 5 minutes from Codex';
COMMENT ON COLUMN scanned_tokens.unique_sells_5m_codex IS 'Number of unique wallets that sold in last 5 minutes from Codex';
COMMENT ON COLUMN scanned_tokens.unique_transactions_5m_codex IS 'Number of unique wallets that transacted in last 5 minutes from Codex';
COMMENT ON COLUMN scanned_tokens.swap_pct_1d_old_wallet IS 'Percentage of swaps from wallets less than 1 day old (from Codex)';
COMMENT ON COLUMN scanned_tokens.swap_pct_7d_old_wallet IS 'Percentage of swaps from wallets less than 7 days old (from Codex)';
COMMENT ON COLUMN scanned_tokens.wallet_age_avg IS 'Average age of wallets that traded in last 24h (from Codex)';
COMMENT ON COLUMN scanned_tokens.wallet_age_std IS 'Standard deviation of wallet ages that traded in last 24h (from Codex)';
COMMENT ON COLUMN scanned_tokens.is_scam_codex IS 'Scam flag from Codex API';

