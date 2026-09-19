-- Add Jupiter BUY quote data to scanned_tokens for entry liquidity checks
-- This captures whether a token can be BOUGHT at scan time (entry liquidity)
-- Combined with sell quote, this gives a complete liquidity picture

-- Can we get a buy quote at scan time?
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS jupiter_buy_quote_success BOOLEAN;

-- Price impact for buying (higher = worse liquidity)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS jupiter_buy_quote_price_impact DOUBLE PRECISION;

-- Expected output amount (tokens received for ~$100 SOL)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS jupiter_buy_quote_out_amount TEXT;

-- Number of routes available (0 = no routes = cannot buy)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS jupiter_buy_quote_routes_count INTEGER;

-- Error message if quote failed
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS jupiter_buy_quote_error TEXT;

-- Create index for filtering by quote success
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_jupiter_buy_quote 
ON scanned_tokens(jupiter_buy_quote_success) 
WHERE jupiter_buy_quote_success IS NOT NULL;

COMMENT ON COLUMN scanned_tokens.jupiter_buy_quote_success IS 'Whether Jupiter returned a valid buy quote for 1 SOL at scan time';
COMMENT ON COLUMN scanned_tokens.jupiter_buy_quote_price_impact IS 'Price impact % for buying 1 SOL worth of tokens at scan time';
COMMENT ON COLUMN scanned_tokens.jupiter_buy_quote_out_amount IS 'Expected token output for buying with 1 SOL';
COMMENT ON COLUMN scanned_tokens.jupiter_buy_quote_routes_count IS 'Number of routes available for buying';
COMMENT ON COLUMN scanned_tokens.jupiter_buy_quote_error IS 'Error message if buy quote failed';
