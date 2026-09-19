-- Price History Table
-- Stores all token price fetches for historical analysis

CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  token_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  price_usd DOUBLE PRECISION NOT NULL,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_price_history_lookup 
  ON price_history(token_address, chain, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_price_history_timestamp 
  ON price_history(timestamp DESC);

-- Index for cleanup (old data)
CREATE INDEX IF NOT EXISTS idx_price_history_chain_timestamp 
  ON price_history(chain, timestamp DESC);

COMMENT ON TABLE price_history IS 'Historical token prices for analytics and opportunity cost tracking';
COMMENT ON COLUMN price_history.token_address IS 'Token contract address';
COMMENT ON COLUMN price_history.chain IS 'Chain: SOLANA or BNB';
COMMENT ON COLUMN price_history.price_usd IS 'Price in USD at timestamp';
COMMENT ON COLUMN price_history.timestamp IS 'When price was fetched';

