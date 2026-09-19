-- Add selection_score column to track AI selection quality score
-- This score is calculated before expensive candle fetches to pick best tokens

ALTER TABLE scanned_tokens
ADD COLUMN IF NOT EXISTS selection_score DOUBLE PRECISION DEFAULT NULL;

-- Add index for querying by selection score
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_selection_score ON scanned_tokens(selection_score DESC);

-- Add comment
COMMENT ON COLUMN scanned_tokens.selection_score IS 'Quality score used for AI selection prioritization (higher = better)';

