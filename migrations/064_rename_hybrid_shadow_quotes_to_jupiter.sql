-- Migration 064: Rename hybrid shadow quotes table to hybrid_shadow_jupiter_quotes
-- Purpose:
--  - Use clearer naming for Jupiter quote metadata table

ALTER TABLE hybrid_shadow_quotes
RENAME TO hybrid_shadow_jupiter_quotes;

COMMENT ON TABLE hybrid_shadow_jupiter_quotes IS 'Stored Jupiter quote metadata for hybrid shadow decisions and slippage attempts';

