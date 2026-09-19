-- Migration: Add max_price_timestamp to track when peak price occurred
-- This helps analyze timing patterns: when do tokens typically peak?

-- Add column to trades table
ALTER TABLE trades 
ADD COLUMN IF NOT EXISTS max_price_timestamp TIMESTAMP;

-- Add comment
COMMENT ON COLUMN trades.max_price_timestamp IS 'Timestamp when max_price_reached occurred - useful for analyzing peak timing patterns';

-- Create index for queries analyzing peak timing
CREATE INDEX IF NOT EXISTS idx_trades_max_price_timestamp 
ON trades(max_price_timestamp) 
WHERE max_price_timestamp IS NOT NULL;

