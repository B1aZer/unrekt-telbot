-- Migration 012: Add DexScreener Trading Data
-- Store 5-minute trading activity from DexScreener for better analytics

ALTER TABLE decisions ADD COLUMN IF NOT EXISTS txn_buys_5m INTEGER;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS txn_sells_5m INTEGER;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS buy_sell_ratio DOUBLE PRECISION;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS unique_buyers_5m INTEGER;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS unique_sellers_5m INTEGER;

CREATE INDEX IF NOT EXISTS idx_decisions_txn_buys_5m ON decisions(txn_buys_5m);
CREATE INDEX IF NOT EXISTS idx_decisions_buy_sell_ratio ON decisions(buy_sell_ratio);

COMMENT ON COLUMN decisions.txn_buys_5m IS '5-minute buy transaction count from DexScreener';
COMMENT ON COLUMN decisions.txn_sells_5m IS '5-minute sell transaction count from DexScreener';
COMMENT ON COLUMN decisions.buy_sell_ratio IS 'Buy/Sell volume ratio from DexScreener';
COMMENT ON COLUMN decisions.unique_buyers_5m IS 'Unique buyers in last 5 minutes from DexScreener';
COMMENT ON COLUMN decisions.unique_sellers_5m IS 'Unique sellers in last 5 minutes from DexScreener';

