-- Add Jupiter sell quote data to scanned_tokens for ML training
-- This captures whether a token can be sold at scan time (pre-trade liquidity check)
-- Critical for detecting tokens that lose liquidity shortly after launch

-- Can we get a sell quote at scan time?
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS jupiter_sell_quote_success BOOLEAN;

-- Price impact for selling (higher = worse liquidity)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS jupiter_sell_quote_price_impact DOUBLE PRECISION;

-- Expected output amount in lamports (for 1 token sell)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS jupiter_sell_quote_out_amount TEXT;

-- Number of routes available (0 = no routes = cannot sell)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS jupiter_sell_quote_routes_count INTEGER;

-- Error message if quote failed
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS jupiter_sell_quote_error TEXT;

-- Create index for filtering by quote success
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_jupiter_sell_quote 
ON scanned_tokens(jupiter_sell_quote_success) 
WHERE jupiter_sell_quote_success IS NOT NULL;

COMMENT ON COLUMN scanned_tokens.jupiter_sell_quote_success IS 'Whether Jupiter returned a valid sell quote at scan time';
COMMENT ON COLUMN scanned_tokens.jupiter_sell_quote_price_impact IS 'Price impact % for selling 1 token at scan time';
COMMENT ON COLUMN scanned_tokens.jupiter_sell_quote_out_amount IS 'Expected SOL output (lamports) for selling 1 token';
COMMENT ON COLUMN scanned_tokens.jupiter_sell_quote_routes_count IS 'Number of routes available for selling';
COMMENT ON COLUMN scanned_tokens.jupiter_sell_quote_error IS 'Error message if sell quote failed';
