-- Add actual swap amounts to hybrid_shadow_trades for verification
-- These fields store the raw amounts returned by Jupiter swaps

-- Entry amounts (what we actually spent and received)
ALTER TABLE hybrid_shadow_trades 
ADD COLUMN IF NOT EXISTS actual_sol_spent NUMERIC(20, 9),  -- Actual SOL spent on entry (lamports / 1e9)
ADD COLUMN IF NOT EXISTS actual_tokens_received NUMERIC(30, 6);  -- Actual tokens received on entry

-- Exit amounts (what we actually sold and received)
ALTER TABLE hybrid_shadow_trades
ADD COLUMN IF NOT EXISTS actual_tokens_sold NUMERIC(30, 6),  -- Actual tokens sold on exit
ADD COLUMN IF NOT EXISTS actual_sol_received NUMERIC(20, 9);  -- Actual SOL received on exit (lamports / 1e9)

-- Add comments
COMMENT ON COLUMN hybrid_shadow_trades.actual_sol_spent IS 'Actual SOL spent on entry swap (for real trades only)';
COMMENT ON COLUMN hybrid_shadow_trades.actual_tokens_received IS 'Actual tokens received on entry swap (for real trades only)';
COMMENT ON COLUMN hybrid_shadow_trades.actual_tokens_sold IS 'Actual tokens sold on exit swap (for real trades only)';
COMMENT ON COLUMN hybrid_shadow_trades.actual_sol_received IS 'Actual SOL received on exit swap (for real trades only)';

-- Add the same columns to trades table for consistency
ALTER TABLE trades 
ADD COLUMN IF NOT EXISTS actual_sol_spent NUMERIC(20, 9),
ADD COLUMN IF NOT EXISTS actual_tokens_received NUMERIC(30, 6),
ADD COLUMN IF NOT EXISTS actual_tokens_sold NUMERIC(30, 6),
ADD COLUMN IF NOT EXISTS actual_sol_received NUMERIC(20, 9);

COMMENT ON COLUMN trades.actual_sol_spent IS 'Actual SOL spent on entry swap (for real trades only)';
COMMENT ON COLUMN trades.actual_tokens_received IS 'Actual tokens received on entry swap (for real trades only)';
COMMENT ON COLUMN trades.actual_tokens_sold IS 'Actual tokens sold on exit swap (for real trades only)';
COMMENT ON COLUMN trades.actual_sol_received IS 'Actual SOL received on exit swap (for real trades only)';
