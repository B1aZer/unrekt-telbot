-- Migration 067: Add quote_provider to distinguish Jupiter vs Scanner quotes
-- Purpose:
--  - Differentiate between quote sources (Jupiter, Scanner, etc.)
--  - Prepare for future scanner quote tracking

ALTER TABLE jupiter_quotes
ADD COLUMN IF NOT EXISTS quote_provider TEXT DEFAULT 'jupiter' CHECK (quote_provider IN ('jupiter', 'scanner'));

-- Set existing rows to 'jupiter' (they're all Jupiter quotes currently)
UPDATE jupiter_quotes
SET quote_provider = 'jupiter'
WHERE quote_provider IS NULL;

CREATE INDEX IF NOT EXISTS idx_jupiter_quotes_provider
  ON jupiter_quotes(quote_provider);

COMMENT ON COLUMN jupiter_quotes.quote_provider IS 'Quote source/provider: jupiter (Jupiter aggregator) or scanner (scanner service)';
