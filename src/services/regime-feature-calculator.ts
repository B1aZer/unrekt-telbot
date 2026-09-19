/**
 * Regime Feature Calculator
 * 
 * Calculates macro market condition features (SOL momentum from Codex candles)
 * These features are calculated once per scan and stored in the scans table.
 * All tokens in a scan share the same regime features.
 * 
 * SOL Metrics: Codex API (candles)
 * - SOL price and returns (5m, 15m, 1h, 6h) - calculated from candles
 * - SOL volatility (1h, 24h) - calculated from candles
 * - SOL trend strength - calculated from returns and volatility
 * 
 * Note: DEX activity fields (volume, buy pressure) were removed as they were
 * not in sync with actual SOL activity. We rely on Codex charts for all metrics.
 */

import { logger } from '../utils/logger';
import { Chain, getChainConfig } from '../config/chain';

export interface RegimeFeatures {
  // SOL price and momentum
  sol_price: number | null;
  sol_ret_5m: number | null;
  sol_ret_15m: number | null;  // Will be null in Phase 1 (interpolate later)
  sol_ret_1h: number | null;
  sol_ret_6h: number | null;
  
  // SOL volatility (Phase 2 - null for now)
  sol_volatility_1h: number | null;
  sol_volatility_24h: number | null;
  sol_trend_strength: number | null;
  
  // DEX activity features - REMOVED (not in sync with actual SOL activity)
  // We rely on Codex charts for SOL metrics instead
}


interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class RegimeFeatureCalculator {
  // SOL native token address (WSOL)
  private readonly SOL_TOKEN_ADDRESS = 'So11111111111111111111111111111111111111112';
  private readonly CODEX_SOLANA_NETWORK_ID = 1399811149;
  
  /**
   * Fetch SOL candles from Codex API
   */
  private async fetchSOLCandles(
    scanTimestamp: Date,
    resolution: string,
    count: number
  ): Promise<Candle[]> {
    const codexApiKey = process.env.CODEX_API_KEY;
    if (!codexApiKey) {
      logger.warn('[RegimeFeatures] No CODEX_API_KEY - cannot fetch SOL candles');
      return [];
    }

    try {
      // Calculate time range: fetch candles BEFORE scan timestamp (to avoid data leakage)
      const scanTimeSeconds = Math.floor(scanTimestamp.getTime() / 1000);
      // Safely parse resolution (handle NaN from parseInt)
      const minutesPerCandle = Number.isFinite(+resolution) ? +resolution : 1;
      const timeFrom = scanTimeSeconds - (minutesPerCandle * 60 * count);
      const timeTo = scanTimeSeconds; // Up to (but not including) scan time

      const symbol = `${this.SOL_TOKEN_ADDRESS}:${this.CODEX_SOLANA_NETWORK_ID}`;

      const graphqlQuery = `
        query ChartData($symbol: String!, $from: Int!, $to: Int!, $resolution: String!) {
          getBars(
            symbol: $symbol
            from: $from
            to: $to
            resolution: $resolution
            removeEmptyBars: true
            removeLeadingNullValues: true
            symbolType: TOKEN
            currencyCode: "USD"
          ) {
            o
            h
            l
            c
            t
            volume
          }
        }
      `;

      const response = await fetch('https://graph.codex.io/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': codexApiKey,
        },
        body: JSON.stringify({
          query: graphqlQuery,
          variables: {
            symbol,
            from: timeFrom,
            to: timeTo,
            resolution,
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        logger.warn(`[RegimeFeatures] Codex API returned ${response.status}`);
        return [];
      }

      const data = await response.json() as any;
      if (data.errors) {
        logger.warn(`[RegimeFeatures] Codex GraphQL errors:`, data.errors[0]?.message);
        return [];
      }

      const bars = data.data?.getBars;
      if (!bars || !bars.t || !Array.isArray(bars.t)) {
        logger.warn('[RegimeFeatures] Invalid Codex response format');
        return [];
      }

      // Convert parallel arrays to Candle objects
      const candles: Candle[] = bars.t.map((timestamp: number, i: number) => ({
        timestamp,
        open: parseFloat(bars.o[i]),
        high: parseFloat(bars.h[i]),
        low: parseFloat(bars.l[i]),
        close: parseFloat(bars.c[i]),
        volume: parseFloat(bars.volume[i] || 0),
      }));

      // Sort by timestamp (in case Codex returns them unsorted)
      candles.sort((a, b) => a.timestamp - b.timestamp);

      return candles;
    } catch (error) {
      logger.warn(`[RegimeFeatures] Failed to fetch SOL candles:`, error);
      return [];
    }
  }

  /**
   * Calculate SOL metrics from candles (same logic as backfill script)
   */
  private calculateSOLMetricsFromCandles(
    candles1m: Candle[],
    candles5m: Candle[],
    scanTimestamp: Date
  ): {
    sol_price: number | null;
    sol_ret_5m: number | null;
    sol_ret_15m: number | null;
    sol_ret_1h: number | null;
    sol_ret_6h: number | null;
    sol_volatility_1h: number | null;
    sol_volatility_24h: number | null;
    sol_trend_strength: number | null;
  } {
    const metrics = {
      sol_price: null as number | null,
      sol_ret_5m: null as number | null,
      sol_ret_15m: null as number | null,
      sol_ret_1h: null as number | null,
      sol_ret_6h: null as number | null,
      sol_volatility_1h: null as number | null,
      sol_volatility_24h: null as number | null,
      sol_trend_strength: null as number | null,
    };

    if (candles1m.length === 0 && candles5m.length === 0) {
      return metrics;
    }

    // Filter candles to ensure they're strictly before scan timestamp
    const scanTs = Math.floor(scanTimestamp.getTime() / 1000);
    const filtered1m = candles1m.filter(c => c.timestamp < scanTs);
    const filtered5m = candles5m.filter(c => c.timestamp < scanTs);

    if (filtered1m.length === 0 && filtered5m.length === 0) {
      return metrics;
    }

    // Get current SOL price (last candle before scan timestamp)
    const lastCandle = filtered5m.length > 0 
      ? filtered5m[filtered5m.length - 1]
      : filtered1m.length > 0 
        ? filtered1m[filtered1m.length - 1]
        : null;
    
    if (lastCandle) {
      metrics.sol_price = lastCandle.close;
    }

    // Calculate returns from 5m candles
    if (filtered5m.length >= 2) {
      const now = filtered5m[filtered5m.length - 1];
      
      // 5m return: last candle vs 1 candle ago
      // 1 interval * 5m = 5m → index len - 2 (difference of 1 step)
      if (filtered5m.length >= 2) {
        const prev5m = filtered5m[filtered5m.length - 2];
        // Guard against division by zero (prev.close = 0)
        if (prev5m.close > 0) {
          metrics.sol_ret_5m = ((now.close - prev5m.close) / prev5m.close) * 100;
        }
      }
      
      // 15m return: last candle vs 3 candles ago
      // 3 intervals * 5m = 15m → index len - 4 (difference of 3 steps)
      if (filtered5m.length >= 4) {
        const prev15m = filtered5m[filtered5m.length - 4];
        // Guard against division by zero (prev.close = 0)
        if (prev15m.close > 0) {
          metrics.sol_ret_15m = ((now.close - prev15m.close) / prev15m.close) * 100;
        }
      }
      
      // 1h return: last candle vs 12 candles ago
      // 12 intervals * 5m = 60m = 1h → index len - 13 (difference of 12 steps)
      if (filtered5m.length >= 13) {
        const prev1h = filtered5m[filtered5m.length - 13];
        // Guard against division by zero (prev.close = 0)
        if (prev1h.close > 0) {
          metrics.sol_ret_1h = ((now.close - prev1h.close) / prev1h.close) * 100;
        }
      }
      
      // 6h return: last candle vs 72 candles ago
      // 72 intervals * 5m = 360m = 6h → index len - 73 (difference of 72 steps)
      if (filtered5m.length >= 73) {
        const prev6h = filtered5m[filtered5m.length - 73];
        // Guard against division by zero (prev.close = 0)
        if (prev6h.close > 0) {
          metrics.sol_ret_6h = ((now.close - prev6h.close) / prev6h.close) * 100;
        }
      }
    }

    // Calculate volatility from 1m candles (need 60 candles for 1h volatility)
    if (filtered1m.length >= 60) {
      const last60 = filtered1m.slice(-60);
      const returns: number[] = [];
      for (let i = 1; i < last60.length; i++) {
        // Guard against division by zero (prev.close = 0)
        if (last60[i-1].close > 0) {
          returns.push((last60[i].close - last60[i-1].close) / last60[i-1].close);
        }
      }
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
      metrics.sol_volatility_1h = Math.sqrt(variance) * 100; // Convert to %
    }

    // Calculate 24h volatility from 5m candles (need 288 candles = 24h × 12 candles/hour)
    if (filtered5m.length >= 288) {
      const last288 = filtered5m.slice(-288);
      const returns: number[] = [];
      for (let i = 1; i < last288.length; i++) {
        // Guard against division by zero (prev.close = 0)
        if (last288[i-1].close > 0) {
          returns.push((last288[i].close - last288[i-1].close) / last288[i-1].close);
        }
      }
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
      metrics.sol_volatility_24h = Math.sqrt(variance) * 100; // Convert to %
    }

    // Calculate trend strength: abs(ret_1h) * sqrt(abs(ret_1h / volatility_1h))
    // Guard against numerical instability when absVol is very small
    const eps = 1e-8;
    if (metrics.sol_ret_1h !== null && metrics.sol_volatility_1h !== null && metrics.sol_volatility_1h > eps) {
      const absRet = Math.abs(metrics.sol_ret_1h);
      const absVol = Math.abs(metrics.sol_volatility_1h);
      metrics.sol_trend_strength = absRet * Math.sqrt(absRet / absVol);
    }

    return metrics;
  }

  /**
   * Calculate regime features from Codex candles (SOL metrics only)
   * Returns null if chain is not Solana or if API calls fail
   */
  async calculateRegimeFeatures(scanTimestamp?: Date): Promise<RegimeFeatures | null> {
    const chainConfig = getChainConfig();
    
    // Only calculate for Solana chain
    if (chainConfig.chain !== Chain.SOLANA) {
      logger.debug('[RegimeFeatures] Skipping regime features (not Solana chain)');
      return null;
    }

    // Use current time if scanTimestamp not provided (for live scans)
    const timestamp = scanTimestamp || new Date();
    
    try {
      // Fetch SOL candles from Codex (for SOL metrics)
      const [candles1m, candles5m] = await Promise.all([
        this.fetchSOLCandles(timestamp, '1', 60),   // 1h of 1m candles (for 1h volatility)
        this.fetchSOLCandles(timestamp, '5', 288), // 24h of 5m candles (for returns + 24h volatility)
      ]);

      // Debug: Log candle counts to diagnose volatility calculation issues
      logger.debug(`[RegimeFeatures] Fetched candles: 1m=${candles1m.length} (need 60), 5m=${candles5m.length}`);

      // Calculate SOL metrics from candles
      const solMetrics = this.calculateSOLMetricsFromCandles(candles1m, candles5m, timestamp);

      const features: RegimeFeatures = {
        // SOL metrics from Codex candles
        sol_price: solMetrics.sol_price,
        sol_ret_5m: solMetrics.sol_ret_5m,
        sol_ret_15m: solMetrics.sol_ret_15m,
        sol_ret_1h: solMetrics.sol_ret_1h,
        sol_ret_6h: solMetrics.sol_ret_6h,
        sol_volatility_1h: solMetrics.sol_volatility_1h,
        sol_volatility_24h: solMetrics.sol_volatility_24h,
        sol_trend_strength: solMetrics.sol_trend_strength,
        
        // DEX activity fields removed (not in sync with actual SOL activity)
      };
      
      logger.debug(`[RegimeFeatures] Calculated regime features: SOL=${solMetrics.sol_price?.toFixed(2) || 'N/A'}, ret_1h=${solMetrics.sol_ret_1h?.toFixed(2) || 'null'}%, vol_1h=${solMetrics.sol_volatility_1h?.toFixed(2) || 'null'}%`);
      
      return features;
      
    } catch (error) {
      logger.error('[RegimeFeatures] Failed to calculate regime features:', error);
      return this.getEmptyFeatures();
    }
  }

  
  /**
   * Return empty features (all null) for error cases
   */
  private getEmptyFeatures(): RegimeFeatures {
    return {
      sol_price: null,
      sol_ret_5m: null,
      sol_ret_15m: null,
      sol_ret_1h: null,
      sol_ret_6h: null,
      sol_volatility_1h: null,
      sol_volatility_24h: null,
      sol_trend_strength: null,
    };
  }
}

export const regimeFeatureCalculator = new RegimeFeatureCalculator();

