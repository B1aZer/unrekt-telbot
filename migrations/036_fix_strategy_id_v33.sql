-- Migration 036: Fix strategy_id for decisions that should use v3.3-ml-features
-- Updates decisions made after v3.3 deployment (2025-11-24 00:08:39) that incorrectly used v3.2-ml-fixes
-- This fixes the caching issue where the bot cached strategy_id 23 before v3.3 was deployed

-- First, let's see what we're updating
-- SELECT COUNT(*) FROM decisions WHERE strategy_id = 23 AND timestamp >= '2025-11-24 00:08:39';

-- Update decisions to use v3.3-ml-features (strategy_id 24) instead of v3.2-ml-fixes (strategy_id 23)
-- Only update decisions made after v3.3 was deployed
UPDATE decisions
SET strategy_id = 24  -- v3.3-ml-features
WHERE strategy_id = 23  -- v3.2-ml-fixes
  AND timestamp >= '2025-11-24 00:08:39'::timestamp  -- After v3.3 deployment
  AND EXISTS (SELECT 1 FROM strategies WHERE id = 24);  -- Safety check: ensure v3.3 exists

-- Also update trades that reference these decisions
UPDATE trades
SET strategy_id = 24  -- v3.3-ml-features
WHERE strategy_id = 23  -- v3.2-ml-fixes
  AND decision_id IN (
    SELECT id FROM decisions 
    WHERE strategy_id = 24 
    AND timestamp >= '2025-11-24 00:08:39'::timestamp
  );

-- Verify the update
-- SELECT 
--   COUNT(*) FILTER (WHERE strategy_id = 24) as v33_count,
--   COUNT(*) FILTER (WHERE strategy_id = 23) as v32_count
-- FROM decisions 
-- WHERE timestamp >= '2025-11-24 00:08:39';

