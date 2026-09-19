import { query } from '../infra/database';
import { logger } from '../utils/logger';
import type { Candle } from './data-gatherers/price-action-analyzer';

export interface PriceActionFeatures {
  // 1m features
  m1_ret_5m: number | null;
  m1_ret_10m: number | null;
  m1_ret_15m: number | null;
  m1_vol_5m: number | null;
  m1_vol_10m: number | null;
  m1_rvol_5m: number | null;
  m1_rvol_10m: number | null;
  m1_vol_slope_5m: number | null;
  m1_ret_slope_5m: number | null;
  m1_body_avg_5m: number | null;
  m1_range_avg_5m: number | null;
  m1_upper_wick_ratio_5m: number | null;
  m1_lower_wick_ratio_5m: number | null;
  m1_last_bar_green: boolean | null;
  m1_last_bar_long_upper_wick: boolean | null;
  m1_last_bar_doji: boolean | null;
  m1_consecutive_green: number | null;
  m1_consecutive_red: number | null;
  
  // 5m features
  m5_ret_60m: number | null;
  m5_ret_last_3: number | null;
  m5_vol_60m: number | null;
  m5_rvol_15m: number | null;
  m5_price_slope_60m: number | null;
  m5_volume_slope_60m: number | null;
  m5_consecutive_green: number | null;
  m5_pullback_depth: number | null;
  m5_range_avg_30m: number | null;  // Average range over last 30 minutes (6 candles)
  
  // Cross-timeframe
  pa_momo_alignment: number | null;
  pa_vol_ratio_m1_m5: number | null;
  pa_rvol_ratio_m1_m5: number | null;
  
  // Microstructure features (calculated from price action features)
  volume_squeeze: number | null;      // m1_range_avg_5m / m5_range_avg_30m
  pullback_strength: number | null;   // m5_pullback_depth / abs(m5_ret_60m)
  
  // Metadata for debugging
  m1_candles_available: number;
  m5_candles_available: number;
}

export class PriceActionFeatureCalculator {
  
  /**
   * Fetch candles before scan timestamp
   * 
   * CRITICAL: Only fetches candles with timestamp < scanTimestamp to prevent data leakage.
   * For the same token in multiple scans, each scan gets isolated candle data.
   * 
   * Example:
   * - Token X in scan_1 (T1): uses candles < T1
   * - Token X in scan_2 (T2): uses candles < T2 (may include candles between T1 and T2)
   * 
   * Returns whatever is available, might be less than requested
   */
  private async fetchCandles(
    tokenAddress: string,
    chain: string,
    scanTimestamp: Date,
    timeframe: '1m' | '5m',
    count: number
  ): Promise<Candle[]> {
    const endTime = Math.floor(scanTimestamp.getTime() / 1000);
    const minutesBack = timeframe === '1m' ? count : count * 5;
    const startTime = endTime - (minutesBack * 60);
    
    // Log the time window for debugging
    logger.debug(
      `[PriceActionFeatures] Fetching ${timeframe} candles for ${tokenAddress.substring(0, 8)}... ` +
      `(scan: ${scanTimestamp.toISOString()}, window: ${new Date(startTime * 1000).toISOString()} to ${new Date(endTime * 1000).toISOString()}, strict: < scan timestamp)`
    );
    
    try {
      // CRITICAL: timestamp < $5 ensures NO candles at or after scan timestamp
      // This prevents data leakage between scans of the same token
      // CRITICAL: ORDER BY timestamp ASC ensures chronological order (oldest first)
      // Feature calculations (slopes, consecutive patterns, returns) depend on this order
      const result = await query(`
        SELECT 
          timestamp,
          open_price,
          high_price,
          low_price,
          close_price,
          volume
        FROM candle_data
        WHERE token_address = $1
          AND chain = $2
          AND timeframe = $3
          AND timestamp >= $4
          AND timestamp < $5
        ORDER BY timestamp ASC
      `, [tokenAddress, chain, timeframe, startTime, endTime]);
      
      const candles = result.rows.map(row => ({
        timestamp: row.timestamp,
        open: parseFloat(row.open_price),
        high: parseFloat(row.high_price),
        low: parseFloat(row.low_price),
        close: parseFloat(row.close_price),
        volume: parseFloat(row.volume)
      }));
      
      // CRITICAL VALIDATION 1: Ensure no candles at or after scan timestamp
      // This is a safety check to prevent data leakage
      const invalidCandles = candles.filter(c => c.timestamp >= endTime);
      if (invalidCandles.length > 0) {
        logger.error(
          `[PriceActionFeatures] ⚠️ DATA LEAKAGE DETECTED! Found ${invalidCandles.length} candles ` +
          `with timestamp >= scan timestamp for ${tokenAddress.substring(0, 8)}... ` +
          `(scan: ${endTime}, invalid timestamps: ${invalidCandles.map(c => c.timestamp).join(', ')})`
        );
        // Filter out invalid candles
        return candles.filter(c => c.timestamp < endTime);
      }
      
      // CRITICAL VALIDATION 2: Ensure candles are in chronological order (oldest first)
      // Feature calculations (slopes, consecutive patterns, etc.) depend on correct order
      // ORDER BY timestamp ASC should guarantee this, but we validate to be safe
      for (let i = 1; i < candles.length; i++) {
        if (candles[i].timestamp < candles[i - 1].timestamp) {
          logger.error(
            `[PriceActionFeatures] ⚠️ OUT-OF-ORDER CANDLES DETECTED! ` +
            `Candle at index ${i} (timestamp: ${candles[i].timestamp}) is before ` +
            `candle at index ${i - 1} (timestamp: ${candles[i - 1].timestamp}) ` +
            `for ${tokenAddress.substring(0, 8)}...`
          );
          // Sort to fix order (shouldn't happen, but safety net)
          candles.sort((a, b) => a.timestamp - b.timestamp);
          logger.warn(`[PriceActionFeatures] Fixed order by sorting candles chronologically`);
          break;
        }
      }
      
      // Verify OHLC data integrity (high >= low, high >= open, high >= close, low <= open, low <= close)
      const invalidOHLC = candles.filter(c => 
        c.high < c.low || 
        c.high < c.open || 
        c.high < c.close || 
        c.low > c.open || 
        c.low > c.close
      );
      if (invalidOHLC.length > 0) {
        logger.warn(
          `[PriceActionFeatures] ⚠️ Invalid OHLC data detected for ${invalidOHLC.length} candles ` +
          `for ${tokenAddress.substring(0, 8)}... (high < low or high/low inconsistent with open/close)`
        );
      }
      
      return candles;
    } catch (error) {
      logger.error(`[PriceActionFeatures] Failed to fetch ${timeframe} candles:`, error);
      return [];
    }
  }
  
  /**
   * Calculate 1m features from available candles
   * Adapts to whatever data is available (minimum 2 candles needed)
   */
  private calculate1mFeatures(candles: Candle[]): Partial<PriceActionFeatures> {
    const features: Partial<PriceActionFeatures> = {};
    
    if (candles.length < 2) {
      logger.debug(`[PriceActionFeatures] Insufficient 1m candles: ${candles.length} (need at least 2)`);
      return features;
    }
    
    // Returns - calculate what we can (need N candles for N-period return)
    if (candles.length >= 5) features.m1_ret_5m = this.calculateReturn(candles, 5);
    if (candles.length >= 10) features.m1_ret_10m = this.calculateReturn(candles, 10);
    if (candles.length >= 15) features.m1_ret_15m = this.calculateReturn(candles, 15);
    
    // Volatility - need N candles for N-period volatility
    if (candles.length >= 5) features.m1_vol_5m = this.calculateVolatility(candles, 5);
    if (candles.length >= 10) features.m1_vol_10m = this.calculateVolatility(candles, 10);
    
    // Relative volume - use whatever we have as baseline
    const avgVol = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
    if (avgVol > 0) {
      if (candles.length >= 5) features.m1_rvol_5m = this.calculateRVol(candles, 5, avgVol);
      if (candles.length >= 10) features.m1_rvol_10m = this.calculateRVol(candles, 10, avgVol);
    }
    
    // Slopes - need at least 3 points for meaningful slope
    if (candles.length >= 5) {
      const last5 = candles.slice(-5);
      features.m1_vol_slope_5m = this.calculateSlope(last5.map(c => c.volume));
      features.m1_ret_slope_5m = this.calculateSlope(last5.map(c => c.close));
    } else if (candles.length >= 3) {
      const last3 = candles.slice(-3);
      features.m1_vol_slope_5m = this.calculateSlope(last3.map(c => c.volume));
      features.m1_ret_slope_5m = this.calculateSlope(last3.map(c => c.close));
    }
    
    // Candle shapes - use last N candles (up to 5)
    const shapeCandlesCount = Math.min(5, candles.length);
    const shapeCandles = candles.slice(-shapeCandlesCount);
    
    if (shapeCandles.length > 0) {
      features.m1_body_avg_5m = this.calculateAvgBody(shapeCandles);
      features.m1_range_avg_5m = this.calculateAvgRange(shapeCandles);
      features.m1_upper_wick_ratio_5m = this.calculateAvgUpperWickRatio(shapeCandles);
      features.m1_lower_wick_ratio_5m = this.calculateAvgLowerWickRatio(shapeCandles);
    }
    
    // Last bar flags - always available if we have at least 1 candle
    const lastCandle = candles[candles.length - 1];
    features.m1_last_bar_green = lastCandle.close > lastCandle.open;
    const upperWickRatio = this.getUpperWickRatio(lastCandle);
    features.m1_last_bar_long_upper_wick = upperWickRatio !== null && upperWickRatio > 0.6;
    features.m1_last_bar_doji = this.isDoji(lastCandle);
    
    // Consecutive patterns - use whatever we have
    features.m1_consecutive_green = this.countConsecutiveGreen(candles);
    features.m1_consecutive_red = this.countConsecutiveRed(candles);
    
    return features;
  }
  
  /**
   * Calculate 5m features from available candles
   * Adapts to whatever data is available (minimum 2 candles needed)
   */
  private calculate5mFeatures(candles: Candle[]): Partial<PriceActionFeatures> {
    const features: Partial<PriceActionFeatures> = {};
    
    if (candles.length < 2) {
      logger.debug(`[PriceActionFeatures] Insufficient 5m candles: ${candles.length} (need at least 2)`);
      return features;
    }
    
    // Returns - adapt to available data (need N candles for N-period return)
    if (candles.length >= 12) {
      features.m5_ret_60m = this.calculateReturn(candles, 12);
    } else if (candles.length >= 6) {
      // If we have 6-11 bars, calculate return for whatever we have (30-55 min)
      features.m5_ret_60m = this.calculateReturn(candles, candles.length);
    }
    
    if (candles.length >= 3) {
      features.m5_ret_last_3 = this.calculateReturn(candles, 3);
    } else if (candles.length >= 2) {
      // Use whatever we have
      features.m5_ret_last_3 = this.calculateReturn(candles, candles.length);
    }
    
    // Volatility - need at least 2 candles (to calculate returns between them)
    if (candles.length >= 2) {
      const volPeriod = Math.min(12, candles.length);
      features.m5_vol_60m = this.calculateVolatility(candles, volPeriod);
    }
    
    // Relative volume
    const avgVol = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
    if (avgVol > 0 && candles.length >= 3) {
      const rvolPeriod = Math.min(3, candles.length);
      features.m5_rvol_15m = this.calculateRVol(candles, rvolPeriod, avgVol);
    }
    
    // Slopes - use whatever we have (minimum 2 points)
    if (candles.length >= 2) {
      features.m5_price_slope_60m = this.calculateSlope(candles.map(c => c.close));
      features.m5_volume_slope_60m = this.calculateSlope(candles.map(c => c.volume));
    }
    
    // Consecutive patterns
    features.m5_consecutive_green = this.countConsecutiveGreen(candles);
    
    // Pullback depth - need at least 3 candles
    if (candles.length >= 3) {
      const last3 = candles.slice(-3);
      const returns = [];
      for (let i = 1; i < last3.length; i++) {
        returns.push((last3[i].close - last3[i-1].close) / last3[i-1].close);
      }
      features.m5_pullback_depth = Math.min(...returns) * 100;
    }
    
    // Range average for last 30 minutes (6 candles) - needed for volume squeeze
    if (candles.length >= 6) {
      const last6 = candles.slice(-6);
      features.m5_range_avg_30m = this.calculateAvgRange(last6);
    } else if (candles.length >= 2) {
      // Use whatever we have if less than 6 candles
      features.m5_range_avg_30m = this.calculateAvgRange(candles);
    }
    
    return features;
  }
  
  /**
   * Calculate cross-timeframe features
   * Only calculates if both required features are available
   */
  private calculateCrossTimeframeFeatures(
    m1Features: Partial<PriceActionFeatures>,
    m5Features: Partial<PriceActionFeatures>
  ): Partial<PriceActionFeatures> {
    const features: Partial<PriceActionFeatures> = {};
    
    // Momentum alignment
    if (m1Features.m1_ret_5m !== undefined && m1Features.m1_ret_5m !== null &&
        m5Features.m5_ret_last_3 !== undefined && m5Features.m5_ret_last_3 !== null) {
      const m1Sign = Math.sign(m1Features.m1_ret_5m);
      const m5Sign = Math.sign(m5Features.m5_ret_last_3);
      features.pa_momo_alignment = m1Sign * m5Sign;
    }
    
    // Volume ratios
    const eps = 1e-8;
    if (m1Features.m1_vol_5m !== undefined && m1Features.m1_vol_5m !== null &&
        m5Features.m5_vol_60m !== undefined && m5Features.m5_vol_60m !== null) {
      features.pa_vol_ratio_m1_m5 = m1Features.m1_vol_5m / (m5Features.m5_vol_60m + eps);
    }
    
    if (m1Features.m1_rvol_5m !== undefined && m1Features.m1_rvol_5m !== null &&
        m5Features.m5_rvol_15m !== undefined && m5Features.m5_rvol_15m !== null) {
      features.pa_rvol_ratio_m1_m5 = m1Features.m1_rvol_5m / (m5Features.m5_rvol_15m + eps);
    }
    
    // Volume squeeze: m1_range_avg_5m / m5_range_avg_30m
    // Low values indicate compression (squeeze) before breakout
    if (m1Features.m1_range_avg_5m !== undefined && m1Features.m1_range_avg_5m !== null &&
        m5Features.m5_range_avg_30m !== undefined && m5Features.m5_range_avg_30m !== null &&
        m5Features.m5_range_avg_30m > 0) {
      features.volume_squeeze = m1Features.m1_range_avg_5m / m5Features.m5_range_avg_30m;
    }
    
    // Pullback strength: m5_pullback_depth / abs(m5_ret_60m)
    // Normalizes pullback depth by overall trend strength
    if (m5Features.m5_pullback_depth !== undefined && m5Features.m5_pullback_depth !== null &&
        m5Features.m5_ret_60m !== undefined && m5Features.m5_ret_60m !== null) {
      const absRet60m = Math.abs(m5Features.m5_ret_60m);
      if (absRet60m > 0) {
        features.pullback_strength = m5Features.m5_pullback_depth / absRet60m;
      }
    }
    
    return features;
  }
  
  /**
   * Calculate features from in-memory candles (efficient - no DB fetch)
   * Use this when you already have candles from API (e.g., during scan)
   * 
   * @param candles1m - Array of 1-minute candles (should be in chronological order, oldest first)
   * @param candles5m - Array of 5-minute candles (should be in chronological order, oldest first)
   * @param tokenAddress - Token address (for logging)
   */
  calculateFeaturesFromCandles(
    candles1m: Candle[],
    candles5m: Candle[],
    tokenAddress?: string
  ): PriceActionFeatures {
    try {
      // Validate and ensure chronological order
      const validated1m = this.validateAndSortCandles(candles1m);
      const validated5m = this.validateAndSortCandles(candles5m);
      
      if (tokenAddress) {
        logger.debug(
          `[PriceActionFeatures] ${tokenAddress.substring(0, 8)}...: ` +
          `${validated1m.length} x 1m candles, ${validated5m.length} x 5m candles`
        );
      }
      
      // Calculate features with whatever data is available
      const m1Features = this.calculate1mFeatures(validated1m);
      const m5Features = this.calculate5mFeatures(validated5m);
      const crossFeatures = this.calculateCrossTimeframeFeatures(m1Features, m5Features);
      
      // Merge all features
      return {
        ...this.getDefaultFeatures(),
        ...m1Features,
        ...m5Features,
        ...crossFeatures,
        m1_candles_available: validated1m.length,
        m5_candles_available: validated5m.length
      } as PriceActionFeatures;
      
    } catch (error) {
      logger.error('[PriceActionFeatures] Failed to calculate features from candles:', error);
      return {
        ...this.getDefaultFeatures(),
        m1_candles_available: 0,
        m5_candles_available: 0
      };
    }
  }
  
  /**
   * Main entry point: calculate all price action features (fetches from DB)
   * Use this for backfilling historical data
   * For real-time scans, use calculateFeaturesFromCandles() instead (more efficient)
   */
  async calculateFeatures(
    tokenAddress: string,
    chain: string,
    scanTimestamp: Date
  ): Promise<PriceActionFeatures> {
    try {
      // Fetch candles (will return whatever is available)
      const [candles1m, candles5m] = await Promise.all([
        this.fetchCandles(tokenAddress, chain, scanTimestamp, '1m', 15),
        this.fetchCandles(tokenAddress, chain, scanTimestamp, '5m', 12)
      ]);
      
      // Use the in-memory calculation method
      return this.calculateFeaturesFromCandles(candles1m, candles5m, tokenAddress);
      
    } catch (error) {
      logger.error('[PriceActionFeatures] Failed to calculate features:', error);
      return {
        ...this.getDefaultFeatures(),
        m1_candles_available: 0,
        m5_candles_available: 0
      };
    }
  }
  
  /**
   * Validate and sort candles to ensure chronological order
   */
  private validateAndSortCandles(candles: Candle[]): Candle[] {
    if (candles.length === 0) return candles;
    
    // Sort by timestamp (oldest first)
    const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    
    // Validate order
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].timestamp < sorted[i - 1].timestamp) {
        logger.warn(`[PriceActionFeatures] Candles out of order detected, fixed by sorting`);
        break;
      }
    }
    
    return sorted;
  }
  
  // ============================================================================
  // Helper methods
  // ============================================================================
  
  private calculateReturn(candles: Candle[], periods: number): number | null {
    if (candles.length < periods) return null;
    
    // If we have exactly 'periods' candles, use first candle as start
    // Otherwise, use the candle 'periods' back from the end
    const startIndex = candles.length === periods ? 0 : candles.length - periods - 1;
    const start = candles[startIndex].close;
    const end = candles[candles.length - 1].close;
    
    if (start === 0) return null;
    return ((end - start) / start) * 100;
  }
  
  private calculateVolatility(candles: Candle[], periods: number): number | null {
    if (candles.length < periods) return null;
    
    // If we have exactly 'periods' candles, start from index 1 (need i-1 to exist)
    // Otherwise, start from 'periods' back from the end
    const startIndex = candles.length === periods ? 1 : candles.length - periods;
    const returns = [];
    for (let i = startIndex; i < candles.length; i++) {
      if (candles[i-1].close === 0) continue;
      const ret = (candles[i].close - candles[i-1].close) / candles[i-1].close;
      returns.push(ret);
    }
    if (returns.length < 2) return null;
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    return Math.sqrt(variance) * 100;
  }
  
  private calculateRVol(candles: Candle[], periods: number, avgVol: number): number | null {
    if (candles.length < periods || avgVol === 0) return null;
    const recentVol = candles.slice(-periods).reduce((sum, c) => sum + c.volume, 0);
    return recentVol / (avgVol * periods);
  }
  
  private calculateSlope(values: number[]): number | null {
    if (values.length < 2) return null;
    const n = values.length;
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((sum, v) => sum + v, 0) / n;
    
    let numerator = 0;
    let denominator = 0;
    
    for (let i = 0; i < n; i++) {
      numerator += (i - xMean) * (values[i] - yMean);
      denominator += Math.pow(i - xMean, 2);
    }
    
    return denominator === 0 ? 0 : numerator / denominator;
  }
  
  private calculateAvgBody(candles: Candle[]): number | null {
    if (candles.length === 0) return null;
    const bodies = candles
      .filter(c => c.open > 0)
      .map(c => Math.abs(c.close - c.open) / c.open);
    if (bodies.length === 0) return null;
    return bodies.reduce((sum, b) => sum + b, 0) / bodies.length;
  }
  
  private calculateAvgRange(candles: Candle[]): number | null {
    if (candles.length === 0) return null;
    const ranges = candles
      .filter(c => c.open > 0)
      .map(c => (c.high - c.low) / c.open);
    if (ranges.length === 0) return null;
    return ranges.reduce((sum, r) => sum + r, 0) / ranges.length;
  }
  
  private calculateAvgUpperWickRatio(candles: Candle[]): number | null {
    if (candles.length === 0) return null;
    const ratios = candles.map(c => this.getUpperWickRatio(c)).filter(r => r !== null) as number[];
    return ratios.length > 0 ? ratios.reduce((sum, r) => sum + r, 0) / ratios.length : null;
  }
  
  private calculateAvgLowerWickRatio(candles: Candle[]): number | null {
    if (candles.length === 0) return null;
    const ratios = candles.map(c => this.getLowerWickRatio(c)).filter(r => r !== null) as number[];
    return ratios.length > 0 ? ratios.reduce((sum, r) => sum + r, 0) / ratios.length : null;
  }
  
  private getUpperWickRatio(candle: Candle): number | null {
    const range = candle.high - candle.low;
    if (range === 0) return null;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    return upperWick / range;
  }
  
  private getLowerWickRatio(candle: Candle): number | null {
    const range = candle.high - candle.low;
    if (range === 0) return null;
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    return lowerWick / range;
  }
  
  private isDoji(candle: Candle): boolean {
    const range = candle.high - candle.low;
    if (range === 0 || candle.open === 0) return false;
    const body = Math.abs(candle.close - candle.open);
    return (body / range) < 0.2 && (range / candle.open) > 0.001; // reasonable range
  }
  
  private countConsecutiveGreen(candles: Candle[]): number {
    let count = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].close > candles[i].open) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
  
  private countConsecutiveRed(candles: Candle[]): number {
    let count = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].close < candles[i].open) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
  
  private getDefaultFeatures(): PriceActionFeatures {
    return {
      m1_ret_5m: null,
      m1_ret_10m: null,
      m1_ret_15m: null,
      m1_vol_5m: null,
      m1_vol_10m: null,
      m1_rvol_5m: null,
      m1_rvol_10m: null,
      m1_vol_slope_5m: null,
      m1_ret_slope_5m: null,
      m1_body_avg_5m: null,
      m1_range_avg_5m: null,
      m1_upper_wick_ratio_5m: null,
      m1_lower_wick_ratio_5m: null,
      m1_last_bar_green: null,
      m1_last_bar_long_upper_wick: null,
      m1_last_bar_doji: null,
      m1_consecutive_green: null,
      m1_consecutive_red: null,
      m5_ret_60m: null,
      m5_ret_last_3: null,
      m5_vol_60m: null,
      m5_rvol_15m: null,
      m5_price_slope_60m: null,
      m5_volume_slope_60m: null,
      m5_consecutive_green: null,
      m5_pullback_depth: null,
      m5_range_avg_30m: null,
      pa_momo_alignment: null,
      pa_vol_ratio_m1_m5: null,
      pa_rvol_ratio_m1_m5: null,
      volume_squeeze: null,
      pullback_strength: null,
      m1_candles_available: 0,
      m5_candles_available: 0
    };
  }
}

export const priceActionCalculator = new PriceActionFeatureCalculator();

