-- Migration 066: Add support for exit quotes in jupiter_quotes table
-- Purpose:
--  - Store exit quotes (sell swaps) in addition to entry quotes
--  - Link exit quotes to trades (not just decisions)

ALTER TABLE jupiter_quotes
ADD COLUMN IF NOT EXISTS quote_type TEXT DEFAULT 'entry' CHECK (quote_type IN ('entry', 'exit')),
ADD COLUMN IF NOT EXISTS trade_id INTEGER REFERENCES hybrid_shadow_trades(id);

CREATE INDEX IF NOT EXISTS idx_jupiter_quotes_trade_id
  ON jupiter_quotes(trade_id);

CREATE INDEX IF NOT EXISTS idx_jupiter_quotes_type
  ON jupiter_quotes(quote_type);

COMMENT ON COLUMN jupiter_quotes.quote_type IS 'Type of quote: entry (buy) or exit (sell)';
COMMENT ON COLUMN jupiter_quotes.trade_id IS 'Link to hybrid_shadow_trades for exit quotes (entry quotes use decision_id)';
