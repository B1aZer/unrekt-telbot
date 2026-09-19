-- Migration 034: Add Calculated Quantitative Fields
-- Add volatility, momentum, volume ratios, and velocity/acceleration metrics
-- Based on quant analysis: 9 focused fields for 10-minute hold strategy

-- Volatility (3 timeframes: 5m, 1h, 24h)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volatility_5m DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volatility_1h DOUBLE PRECISION;
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volatility_24h DOUBLE PRECISION;

-- Momentum (score + direction)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS momentum_score DOUBLE PRECISION; -- -1 to 1 (normalized)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS momentum_direction TEXT; -- 'ACCELERATING' | 'DECELERATING' | 'STABLE' | 'INSUFFICIENT_DATA'

-- Volume Ratios (2 ratios: adjacent timeframes only)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_ratio_5m_1h DOUBLE PRECISION; -- (vol5m / vol1h) * 12
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_ratio_1h_24h DOUBLE PRECISION; -- (vol1h / vol24h) * 24

-- Volume Velocity & Acceleration
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_velocity DOUBLE PRECISION; -- vol5m / (vol1h / 12)
ALTER TABLE scanned_tokens ADD COLUMN IF NOT EXISTS volume_acceleration DOUBLE PRECISION; -- rate of change of velocity

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_volatility_5m ON scanned_tokens(volatility_5m) WHERE volatility_5m IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_momentum_score ON scanned_tokens(momentum_score) WHERE momentum_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_volume_ratio_5m_1h ON scanned_tokens(volume_ratio_5m_1h) WHERE volume_ratio_5m_1h IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_tokens_volume_velocity ON scanned_tokens(volume_velocity) WHERE volume_velocity IS NOT NULL;

-- Add comments
COMMENT ON COLUMN scanned_tokens.volatility_5m IS 'Price volatility over 5-minute timeframe (std dev of 5m candle changes, normalized 0-1)';
COMMENT ON COLUMN scanned_tokens.volatility_1h IS 'Price volatility over 1-hour timeframe (std dev of hourly price changes, normalized 0-1)';
COMMENT ON COLUMN scanned_tokens.volatility_24h IS 'Price volatility over 24-hour timeframe (std dev of daily price changes, normalized 0-1)';
COMMENT ON COLUMN scanned_tokens.momentum_score IS 'Momentum score (-1 to 1): (priceChange5m - priceChange1h/12) / 50, normalized';
COMMENT ON COLUMN scanned_tokens.momentum_direction IS 'Momentum direction: ACCELERATING (pump starting), DECELERATING (pump ending), STABLE (consolidation)';
COMMENT ON COLUMN scanned_tokens.volume_ratio_5m_1h IS 'Volume ratio: (volume_5m / volume_1h) * 12. Ratio > 2 = volume accelerating, < 0.5 = declining';
COMMENT ON COLUMN scanned_tokens.volume_ratio_1h_24h IS 'Volume ratio: (volume_1h / volume_24h) * 24. Ratio > 1.5 = above-average activity, < 0.5 = below-average';
COMMENT ON COLUMN scanned_tokens.volume_velocity IS 'Volume velocity: volume_5m / (volume_1h / 12). How much faster is 5m vs expected from 1h average';
COMMENT ON COLUMN scanned_tokens.volume_acceleration IS 'Volume acceleration: rate of change of velocity. > 0 = velocity increasing (early pump), < 0 = velocity decreasing (late pump)';

