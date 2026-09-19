-- Migration 029: Add Extended DexScreener Fields
-- Add price changes, pair metadata, liquidity details, and FDV

-- Price changes (multiple timeframes)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS price_change_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS price_change_1h DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS price_change_6h DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS price_change_24h_dex DOUBLE PRECISION; -- DexScreener 24h (separate from Codex)

-- Pair metadata
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS pair_address TEXT;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS dex_id TEXT;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS quote_token TEXT;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS pair_created_at BIGINT; -- timestamp in milliseconds

-- Liquidity details (base and quote amounts)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS liquidity_base DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS liquidity_quote DOUBLE PRECISION;

-- Market metrics
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS fdv DOUBLE PRECISION; -- Fully Diluted Valuation

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_price_change_5m ON scanned_tokens(price_change_5m) WHERE price_change_5m IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_price_change_1h ON scanned_tokens(price_change_1h) WHERE price_change_1h IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_dex_id ON scanned_tokens(dex_id) WHERE dex_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_pair_created_at ON scanned_tokens(pair_created_at) WHERE pair_created_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_fdv ON scanned_tokens(fdv) WHERE fdv IS NOT NULL;

-- Add comments
COMMENT ON COLUMN scanned_tokens.price_change_5m IS 'Price change % in last 5 minutes from DexScreener';
COMMENT ON COLUMN scanned_tokens.price_change_1h IS 'Price change % in last 1 hour from DexScreener';
COMMENT ON COLUMN scanned_tokens.price_change_6h IS 'Price change % in last 6 hours from DexScreener';
COMMENT ON COLUMN scanned_tokens.price_change_24h_dex IS 'Price change % in last 24 hours from DexScreener (separate from Codex price_change_24h)';
COMMENT ON COLUMN scanned_tokens.pair_address IS 'DEX pair address from DexScreener';
COMMENT ON COLUMN scanned_tokens.dex_id IS 'DEX identifier (e.g., raydium, pancakeswap, pumpfun)';
COMMENT ON COLUMN scanned_tokens.quote_token IS 'Quote token symbol (e.g., SOL, USDC, BNB)';
COMMENT ON COLUMN scanned_tokens.pair_created_at IS 'Pair creation timestamp in milliseconds from DexScreener';
COMMENT ON COLUMN scanned_tokens.liquidity_base IS 'Base token liquidity amount from DexScreener';
COMMENT ON COLUMN scanned_tokens.liquidity_quote IS 'Quote token liquidity amount from DexScreener';
COMMENT ON COLUMN scanned_tokens.fdv IS 'Fully Diluted Valuation from DexScreener';

