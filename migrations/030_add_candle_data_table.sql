-- Migration 030: Add candle_data table for storing OHLCV candlestick data
-- Stores 1m and 5m candles from Codex API for backtesting and analysis

CREATE TABLE IF NOT EXISTS candle_data (
  id SERIAL PRIMARY KEY,
  
  -- Link to token and scan
  token_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  scan_id TEXT,  -- Optional: link to scan for backtesting context
  
  -- Candle metadata
  timeframe TEXT NOT NULL CHECK (timeframe IN ('1m', '5m')),
  timestamp INTEGER NOT NULL,  -- Unix timestamp (seconds)
  
  -- OHLCV data
  open_price DOUBLE PRECISION NOT NULL,
  high_price DOUBLE PRECISION NOT NULL,
  low_price DOUBLE PRECISION NOT NULL,
  close_price DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL,
  
  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  
  -- Constraints
  CONSTRAINT unique_candle UNIQUE (token_address, chain, timeframe, timestamp)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_candle_lookup ON candle_data(token_address, chain, timeframe, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_candle_scan ON candle_data(scan_id) WHERE scan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candle_timeframe ON candle_data(timeframe, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_candle_token_timeframe ON candle_data(token_address, chain, timeframe);

-- Add comments
COMMENT ON TABLE candle_data IS 'OHLCV candlestick data from Codex API for backtesting and analysis';
COMMENT ON COLUMN candle_data.token_address IS 'Token address (mint address for Solana)';
COMMENT ON COLUMN candle_data.chain IS 'Chain identifier (solana, bsc, etc.)';
COMMENT ON COLUMN candle_data.scan_id IS 'Optional link to scan for backtesting context';
COMMENT ON COLUMN candle_data.timeframe IS 'Candle timeframe: 1m (1 minute) or 5m (5 minutes)';
COMMENT ON COLUMN candle_data.timestamp IS 'Unix timestamp in seconds for candle start time';
COMMENT ON COLUMN candle_data.open_price IS 'Opening price in USD';
COMMENT ON COLUMN candle_data.high_price IS 'Highest price in USD during candle period';
COMMENT ON COLUMN candle_data.low_price IS 'Lowest price in USD during candle period';
COMMENT ON COLUMN candle_data.close_price IS 'Closing price in USD';
COMMENT ON COLUMN candle_data.volume IS 'Trading volume in USD during candle period';

