/**
 * Quantitative Calculations Utilities
 * 
 * Centralized validation and calculation functions for quantitative metrics
 * Handles all edge cases (missing data, division by zero, invalid values) in one place
 */

import type { Candle } from '../services/data-gatherers/price-action-analyzer';

/**
 * Validate and sanitize numeric value
 */
export function validateNumber(value: any): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (isNaN(value) || !isFinite(value)) return undefined;
  return value;
}

/**
 * Validate array of numbers
 */
export function validateNumbers(values: any[]): number[] {
  return values
    .map(v => validateNumber(v))
    .filter((v): v is number => v !== undefined);
}

/**
 * Validate candle data
 */
export function validateCandle(candle: any): candle is Candle {
  if (!candle || typeof candle !== 'object') return false;
  const close = validateNumber(candle.close);
  const open = validateNumber(candle.open);
  const high = validateNumber(candle.high);
  const low = validateNumber(candle.low);
  const volume = validateNumber(candle.volume);
  
  return close !== undefined && 
         open !== undefined && 
         high !== undefined && 
         low !== undefined && 
         volume !== undefined &&
         close > 0; // Price must be positive
}

/**
 * Validate candle array
 */
export function validateCandles(candles: any[]): Candle[] {
  if (!Array.isArray(candles)) return [];
  return candles.filter(validateCandle);
}

/**
 * Calculate volatility from price changes (0-1 scale)
 * Returns undefined if insufficient data
 */
export function calculateVolatility(priceChanges: number[]): number | undefined {
  const validChanges = validateNumbers(priceChanges);
  
  if (validChanges.length < 2) return undefined;
  
  // Calculate standard deviation
  const mean = validChanges.reduce((sum, val) => sum + val, 0) / validChanges.length;
  const variance = validChanges.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / validChanges.length;
  
  if (variance <= 0) return 0; // No variance = no volatility
  
  const stdDev = Math.sqrt(variance);
  
  // Normalize to 0-1 scale (assuming max reasonable volatility is 50%)
  const normalized = Math.min(stdDev / 50, 1);
  
  return normalized;
}

/**
 * Calculate volatility from candles (close-to-close changes)
 */
export function calculateVolatilityFromCandles(candles: Candle[]): number | undefined {
  const validCandles = validateCandles(candles);
  
  if (validCandles.length < 2) return undefined;
  
  // Calculate close-to-close changes
  const changes: number[] = [];
  for (let i = 1; i < validCandles.length; i++) {
    const prev = validCandles[i-1];
    const curr = validCandles[i];
    const change = ((curr.close - prev.close) / prev.close) * 100;
    changes.push(change);
  }
  
  return calculateVolatility(changes);
}

/**
 * Calculate 5-minute volatility from 5m candles
 */
export function calculateVolatility5m(candles5m: any[]): number | undefined {
  const validCandles = validateCandles(candles5m);
  return calculateVolatilityFromCandles(validCandles);
}

/**
 * Calculate 1-hour volatility from 5m candles
 * Scales volatility proportionally based on available candle count
 */
export function calculateVolatility1h(candles5m: any[]): number | undefined {
  const validCandles = validateCandles(candles5m);
  
  if (validCandles.length < 2) return undefined;
  
  // Calculate 5m volatility first
  const volatility5m = calculateVolatilityFromCandles(validCandles);
  if (volatility5m === undefined || volatility5m === 0) return volatility5m;
  
  // Scale to 1h timeframe: volatility scales with sqrt(time)
  // If we have fewer than 12 candles, scale proportionally
  const candleCount = validCandles.length;
  const scaleFactor = candleCount >= 12 
    ? Math.sqrt(12) // Full hour: scale by sqrt(12)
    : Math.sqrt(candleCount / 12) * Math.sqrt(12); // Partial: scale proportionally
  
  const volatility1h = volatility5m * scaleFactor;
  
  return Math.min(volatility1h, 1); // Cap at 1.0
}

/**
 * Calculate 24-hour volatility (simplified approximation)
 */
export function calculateVolatility24h(priceChange24h: any): number | undefined {
  const change = validateNumber(priceChange24h);
  if (change === undefined) return undefined;
  
  // Simplified approximation: use absolute 24h price change as proxy for volatility
  // Normalize to 0-1 scale (assuming max reasonable 24h change is 200%)
  return Math.min(Math.abs(change) / 200, 1);
}

/**
 * Calculate momentum score (5m vs 1h)
 * Compares 5m change vs expected from 1h average
 */
export function calculateMomentumScore(change5m: any, change1h: any): number | undefined {
  const change5mValid = validateNumber(change5m);
  const change1hValid = validateNumber(change1h);
  
  if (change5mValid === undefined || change1hValid === undefined) return undefined;
  
  // Expected 5m change from 1h average = change1h / 12
  const expected5m = change1hValid / 12;
  
  // Momentum = actual vs expected, normalized
  const momentum = (change5mValid - expected5m) / 50;
  
  return Math.max(-1, Math.min(1, momentum));
}

/**
 * Calculate volume ratio (5m / 1h)
 */
export function calculateVolumeRatio5m1h(volume5m: any, volume1h: any): number | undefined {
  const vol5m = validateNumber(volume5m);
  const vol1h = validateNumber(volume1h);
  
  if (vol5m === undefined || vol1h === undefined) return undefined;
  if (vol5m <= 0 || vol1h <= 0) return undefined; // Division by zero check
  
  return (vol5m / vol1h) * 12;
}

/**
 * Calculate volume ratio (1h / 24h)
 */
export function calculateVolumeRatio1h24h(volume1h: any, volume24h: any): number | undefined {
  const vol1h = validateNumber(volume1h);
  const vol24h = validateNumber(volume24h);
  
  if (vol1h === undefined || vol24h === undefined) return undefined;
  if (vol1h <= 0 || vol24h <= 0) return undefined; // Division by zero check
  
  return (vol1h / vol24h) * 24;
}

/**
 * Calculate volume velocity (5m vs 1h)
 */
export function calculateVolumeVelocity(volume5m: any, volume1h: any): number | undefined {
  const vol5m = validateNumber(volume5m);
  const vol1h = validateNumber(volume1h);
  
  if (vol5m === undefined || vol1h === undefined) return undefined;
  if (vol5m <= 0 || vol1h <= 0) return undefined; // Division by zero check
  
  return vol5m / (vol1h / 12);
}

/**
 * Calculate volume acceleration (rate of change of velocity)
 */
export function calculateVolumeAcceleration(
  volume5m: any,
  volume10m: any,
  volume1h: any
): number | undefined {
  const velocity5m = calculateVolumeVelocity(volume5m, volume1h);
  const velocity10m = calculateVolumeVelocity(volume10m, volume1h);
  
  if (velocity5m === undefined || velocity10m === undefined) return undefined;
  
  return velocity5m - velocity10m;
}

