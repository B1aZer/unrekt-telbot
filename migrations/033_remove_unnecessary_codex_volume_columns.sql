-- Migration 033: Remove Unnecessary Codex Volume Columns
-- Remove volume_6h_codex and volume_12h_codex if they exist (Codex doesn't provide these timeframes)

-- Drop columns if they exist (safe to run even if columns don't exist)
ALTER TABLE scanned_tokens DROP COLUMN IF EXISTS volume_6h_codex;
ALTER TABLE scanned_tokens DROP COLUMN IF EXISTS volume_12h_codex;

-- Note: volume_6h from DexScreener (added in migration 023) is kept as it's from a different source

