-- Migration 069: Add token decimals to jupiter_quotes for accurate price calculation
-- Purpose:
--  - Store actual token decimals from on-chain data
--  - Enable accurate quote price calculation without guessing
--  - Fix circular reasoning in hybrid-analytics.html price calculations

ALTER TABLE jupiter_quotes
ADD COLUMN IF NOT EXISTS input_decimals INTEGER,   -- Decimals for input token (SOL=9, tokens vary)
ADD COLUMN IF NOT EXISTS output_decimals INTEGER;  -- Decimals for output token

-- Default SOL decimals for existing rows where input/output is SOL
UPDATE jupiter_quotes
SET input_decimals = 9
WHERE input_mint = 'So11111111111111111111111111111111111111112'
  AND input_decimals IS NULL;

UPDATE jupiter_quotes
SET output_decimals = 9
WHERE output_mint = 'So11111111111111111111111111111111111111112'
  AND output_decimals IS NULL;

COMMENT ON COLUMN jupiter_quotes.input_decimals IS 'Decimals for input token (queried from on-chain mint account)';
COMMENT ON COLUMN jupiter_quotes.output_decimals IS 'Decimals for output token (queried from on-chain mint account)';

-- Note: For existing rows where tokens are not SOL, decimals should be backfilled by querying on-chain data
-- This requires a separate script to fetch and update decimals for each unique token_address
