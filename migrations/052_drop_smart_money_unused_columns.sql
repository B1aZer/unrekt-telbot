-- Migration 052: Drop unused smart money columns
-- smart_money_held_percentage and smart_money_avg_buy_size are not needed for ML

ALTER TABLE scanned_tokens DROP COLUMN IF EXISTS smart_money_held_percentage;
ALTER TABLE scanned_tokens DROP COLUMN IF EXISTS smart_money_avg_buy_size;

