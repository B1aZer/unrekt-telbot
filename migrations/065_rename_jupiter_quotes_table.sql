-- Migration 065: Rename hybrid_shadow_jupiter_quotes to jupiter_quotes
-- Purpose: Shorten table name and remove hybrid_shadow prefix

ALTER TABLE hybrid_shadow_jupiter_quotes
RENAME TO jupiter_quotes;

COMMENT ON TABLE jupiter_quotes IS 'Stored Jupiter quote metadata for hybrid decisions and slippage attempts';

