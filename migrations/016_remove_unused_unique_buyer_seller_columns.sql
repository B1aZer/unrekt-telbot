-- Migration 016: Remove unused unique_buyers_5m and unique_sellers_5m columns
-- DexScreener API doesn't provide unique buyer/seller counts, only transaction counts
-- These columns are never populated and not used anywhere

ALTER TABLE decisions DROP COLUMN IF EXISTS unique_buyers_5m;
ALTER TABLE decisions DROP COLUMN IF EXISTS unique_sellers_5m;

