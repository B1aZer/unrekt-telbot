-- Backfill selection_score for existing records
-- Uses the same formula as trading-analyzer.ts:
-- score = (bot_count * 20) + (log10(volume_24h + 1) * 5) + (buy/sell_ratio * 10) + ((100 - risk_score) / 5) + (unique_users / 10)

UPDATE scanned_tokens
SET selection_score = 
  (COALESCE(total_bots_count, 0) * 20) +
  (LN(GREATEST(COALESCE(volume_24h, 0) + 1, 1)) / LN(10) * 5) +
  (CASE 
    WHEN COALESCE(bot_sells, 0) > 0 
    THEN (COALESCE(bot_buys, 0)::DOUBLE PRECISION / bot_sells) * 10
    ELSE COALESCE(bot_buys, 0) * 10
  END) +
  ((100 - COALESCE(risk_score, 50))::DOUBLE PRECISION / 5) +
  (COALESCE(unique_users, 0)::DOUBLE PRECISION / 10)
WHERE selection_score IS NULL
  AND filter_stage = 'ai_ready'  -- Only calculate for tokens that reached AI ready stage
  AND (total_bots_count IS NOT NULL OR volume_24h IS NOT NULL OR bot_buys IS NOT NULL OR risk_score IS NOT NULL OR unique_users IS NOT NULL);

-- Log how many records were updated
DO $$
DECLARE
  updated_count INTEGER;
BEGIN
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE 'Backfilled selection_score for % records', updated_count;
END $$;

