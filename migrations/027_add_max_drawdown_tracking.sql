-- Migration 027: Add Max Drawdown Tracking to Trades Table
-- This enables analysis of how far prices drop before recovery, critical for SL/TP optimization

-- Add max_drawdown_percent column (how far down from entry price, negative value)
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS max_drawdown_percent DOUBLE PRECISION;

-- Add max_drawdown_timestamp column (when the maximum drawdown occurred)
ALTER TABLE trades
ADD COLUMN IF NOT EXISTS max_drawdown_timestamp TIMESTAMP;

-- Add comments for documentation
COMMENT ON COLUMN trades.max_drawdown_percent IS 'Maximum drawdown percentage from entry price (negative value, e.g., -25.5 means 25.5% down from entry)';
COMMENT ON COLUMN trades.max_drawdown_timestamp IS 'Timestamp when the maximum drawdown occurred during the trade';

-- Create index for querying trades by drawdown (useful for analysis)
CREATE INDEX IF NOT EXISTS idx_trades_max_drawdown ON trades(max_drawdown_percent) WHERE max_drawdown_percent IS NOT NULL;

-- Display confirmation
SELECT 
  'Migration 027 completed: Added max_drawdown_percent and max_drawdown_timestamp columns' as status,
  COUNT(*) as total_trades,
  COUNT(CASE WHEN max_drawdown_percent IS NOT NULL THEN 1 END) as trades_with_drawdown_data
FROM trades;

