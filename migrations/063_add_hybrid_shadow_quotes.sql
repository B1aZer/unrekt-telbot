-- Migration 063: Add hybrid shadow quotes table
-- Purpose:
--  - Store Jupiter quote metadata for each hybrid shadow decision
--  - Track slippage attempts and which quote was actually used for swap
--  - Link quotes to both decisions and scanned tokens for analysis

CREATE TABLE IF NOT EXISTS hybrid_shadow_quotes (
  id SERIAL PRIMARY KEY,

  -- Links
  decision_id INTEGER REFERENCES hybrid_shadow_decisions(id),
  scanned_token_id INTEGER REFERENCES scanned_tokens(id),

  -- Token info
  token_address TEXT NOT NULL,
  symbol TEXT,

  -- Attempt metadata (per slippage level)
  attempt_index INTEGER NOT NULL,           -- 0-based index of slippage attempt
  slippage_bps INTEGER NOT NULL,           -- Slippage used for this quote (in bps)
  used_for_swap BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE if this quote was actually executed

  -- Jupiter quote data
  input_mint TEXT,
  output_mint TEXT,
  in_amount NUMERIC,                       -- Quote input amount (smallest unit: lamports or token decimals)
  out_amount NUMERIC,                      -- Quote output amount (smallest unit: token decimals)
  price_impact_pct NUMERIC,                -- Jupiter-reported price impact (%)

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_quotes_decision_id
  ON hybrid_shadow_quotes(decision_id);

CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_quotes_scanned_token_id
  ON hybrid_shadow_quotes(scanned_token_id);

CREATE INDEX IF NOT EXISTS idx_hybrid_shadow_quotes_token
  ON hybrid_shadow_quotes(token_address);

COMMENT ON TABLE hybrid_shadow_quotes IS 'Stored Jupiter quote metadata for hybrid shadow decisions and slippage attempts';

