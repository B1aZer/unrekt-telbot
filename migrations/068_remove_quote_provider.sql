-- Migration 068: Remove quote_provider column
-- Purpose: All quotes are Jupiter quotes, no need for provider differentiation

ALTER TABLE jupiter_quotes
DROP COLUMN IF EXISTS quote_provider;

DROP INDEX IF EXISTS idx_jupiter_quotes_provider;
