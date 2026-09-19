-- Performance indexes based on pg_stat_statements analysis (2026-03-31)
-- Targets: regime-detector (68s avg), price variance checks, analytics dashboard, hybrid shadow trades

CREATE INDEX IF NOT EXISTS idx_scanned_tokens_token_created ON scanned_tokens (token_address, created_at);
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_filter_scan ON scanned_tokens (filter_stage, scan_id);
CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_trades_token_status ON hybrid_shadow_trades (token_address, status);
CREATE INDEX IF NOT EXISTS idx_scans_timestamp_sol ON scans (timestamp DESC) WHERE sol_price IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pf_tokens_graduated_last_seen ON pf_tokens (graduated, last_seen_at) WHERE graduated = true;
CREATE INDEX IF NOT EXISTS idx_trades_status_entry ON trades (status, entry_timestamp);
CREATE INDEX IF NOT EXISTS idx_hsd_scan_should_trade ON hybrid_shadow_decisions (scan_id, should_trade);
