-- Update comments to reflect that Jupiter SELL quote uses realistic position size (~$100)
-- Now we check SELL direction (Token → SOL) with proper position sizing for exit liquidity

COMMENT ON COLUMN scanned_tokens.jupiter_sell_quote_success IS 'Whether Jupiter returned a valid SELL quote for 1 SOL position at scan time';
COMMENT ON COLUMN scanned_tokens.jupiter_sell_quote_price_impact IS 'Price impact % for SELLING 1 SOL worth of tokens at scan time';
COMMENT ON COLUMN scanned_tokens.jupiter_sell_quote_out_amount IS 'Expected SOL output (lamports) for selling 1 SOL worth of tokens';
COMMENT ON COLUMN scanned_tokens.jupiter_sell_quote_routes_count IS 'Number of routes available for selling tokens';
COMMENT ON COLUMN scanned_tokens.jupiter_sell_quote_error IS 'Error message if sell quote failed';
