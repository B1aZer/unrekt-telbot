/**
 * Price Action Data Gatherer
 * 
 * Analyzes price movement, trends, and volatility using DexScreener API
 * Multi-chain support (BSC & Solana)
 */

import { logger } from '../../utils/logger';
import { getChainConfig, Chain } from '../../config/chain';
import {
  calculateVolatility5m,
  calculateVolatility1h,
  calculateVolatility24h,
  calculateMomentumScore,
} from '../../utils/quant-calculations';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PriceAction {
  // Simple timeframes for fresh tokens
  priceChange1m: number;       // % change last 1 min (entry timing)
  priceChange5m: number;       // % change last 5 min (immediate momentum)
  priceChange4h: number;       // % change last 4 hours (context/trend)
  priceChange24h?: number;     // % change last 24 hours (from DexScreener, for scoring/risk params)
  
  // Technical analysis
  volatility: number;          // Price volatility 0-1 (overall, for backward compatibility)
  volatility5m?: number;      // 5-minute volatility (std dev of 5m candle changes)
  volatility1h?: number;      // 1-hour volatility (std dev of hourly changes)
  volatility24h?: number;     // 24-hour volatility (std dev of daily changes)
  trend: 'up' | 'down' | 'sideways';  // Overall trend
  momentum: number;            // -1 to 1 (bearish to bullish) - overall momentum
  momentumScore?: number;      // Momentum score: (priceChange5m - priceChange1h/12) / 50
  momentumDirection?: 'ACCELERATING' | 'DECELERATING' | 'STABLE' | 'INSUFFICIENT_DATA';
  
  // Context for AI
  interpretation: string;      // Human-readable summary
  
  // OHLCV Candles (different timeframes)
  candles1m: Candle[];         // Last 15 one-minute candles (15 minutes) - CRITICAL for catching dumps
  candles5m: Candle[];         // Last 12 five-minute candles (1 hour) - Overall pattern
  // Note: 4h candles removed to save Codex API calls - priceChange4h is interpolated from DexScreener
  
  // Pattern Recognition (help AI interpret candles)
  patterns1m: string;          // Candlestick patterns detected in 1m timeframe
  patterns5m: string;          // Candlestick patterns detected in 5m timeframe
  
  // Momentum Analysis (NEW - for catching pump phases)
  momentum5m?: {
    direction: 'ACCELERATING' | 'DECELERATING' | 'STABLE' | 'INSUFFICIENT_DATA';
    recentBars: string[];      // e.g., ["+2%", "+5%", "+8%"]
    strength: 'STRONG' | 'MODERATE' | 'WEAK';
    description: string;       // Human-readable explanation
  };
  
  // Volume Trend Analysis (NEW - for detecting new waves)
  volumeTrend?: {
    direction: 'INCREASING' | 'DECREASING' | 'STABLE' | 'INSUFFICIENT_DATA';
    recentVolumes: string[];   // e.g., ["$500", "$800", "$1200"]
    strength: 'STRONG' | 'MODERATE' | 'WEAK';
    description: string;       // Human-readable explanation
  };
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    symbol: string;
    name: string;
  };
  priceUsd: string;
  priceChange: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  volume: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  txns: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h6?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  liquidity?: {
    usd?: number;
  };
}

interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[];
}

export class PriceActionAnalyzer {
  /**
   * Analyze price action for a token
   */
  async analyze(tokenAddress: string): Promise<PriceAction | null> {
    logger.debug(`[PriceActionAnalyzer] Analyzing ${tokenAddress.substring(0, 10)}...`);
    
    try {
      const chainConfig = getChainConfig();
      
      // Fetch from DexScreener
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
        { signal: AbortSignal.timeout(5000) }
      );
      
      if (!response.ok) {
        logger.warn(`[PriceActionAnalyzer] DexScreener API returned ${response.status}`);
        return null;
      }
      
      const data = await response.json() as DexScreenerResponse;
      
      // Determine chain ID for DexScreener
      const dexScreenerChainId = chainConfig.chain === Chain.SOLANA ? 'solana' : 'bsc';
      
      // Find chain-specific pairs with highest liquidity
      const chainPairs = data.pairs?.filter(p => p.chainId === dexScreenerChainId) || [];
      if (chainPairs.length === 0) {
        logger.warn(`[PriceActionAnalyzer] No ${dexScreenerChainId} pairs found on DexScreener`);
        return null;
      }
      
      const mainPair = chainPairs[0]; // Most liquid pair
      
      // Fetch OHLCV candles (1m and 5m only - 4h candles removed to save Codex API calls)
      // priceChange4h is already interpolated from DexScreener (1h/6h data), not from candles
      // This saves 1 Codex API call per token (was 3 calls: 1m, 5m, 4h, now just 2: 1m, 5m)
      const [candles1m, candles5m] = await Promise.all([
        this.fetchCandles(tokenAddress, '1', 15),   // 15 x 1-minute bars = 15 minutes (timing)
        this.fetchCandles(tokenAddress, '5', 12),   // 12 x 5-minute bars = 1 hour (pattern)
      ]);
      
      // 4h candles removed to save Codex API calls
      // priceChange4h is interpolated from DexScreener (1h/6h data), not from candles
      
      return this.calculatePriceAction(mainPair, candles1m, candles5m);
      
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const errorType = error?.code || error?.name || 'Unknown';
      logger.error(`[PriceActionAnalyzer] Error analyzing ${tokenAddress} (${errorType}): ${errorMessage}`);
      return null;
    }
  }
  
  /**
   * Fetch OHLCV candles from Codex API
   * NOTE: Codex doesn't support batching candles - each token makes 2 requests (1m, 5m)
   * 4h candles removed to save API calls - priceChange4h is interpolated from DexScreener
   * @param tokenAddress - Token contract address
   * @param resolution - Candle resolution ('1' = 1min, '5' = 5min)
   * @param count - Number of recent candles to fetch
   */
  private async fetchCandles(tokenAddress: string, resolution: string, count: number): Promise<Candle[]> {
    try {
      const chainConfig = getChainConfig();
      const codexApiKey = process.env.CODEX_API_KEY;
      
      // Track candle request (Codex doesn't support batching) — logged after fetch so statusCode is recorded
      const { codexRequestTracker } = await import('../../utils/codex-request-tracker');
      logger.debug(`📡 [Codex] CANDLE: ${tokenAddress.substring(0, 8)}... ${resolution}m`);
      if (!codexApiKey) {
        logger.warn('[PriceActionAnalyzer] No CODEX_API_KEY - skipping candles');
        return [];
      }

      // Codex getBars query
      // Calculate time range based on resolution and count
      const timeNow = Math.floor(Date.now() / 1000);
      const minutesPerCandle = parseInt(resolution);
      const timeFrom = timeNow - (minutesPerCandle * 60 * count);
      
      // Codex symbol format: "tokenAddress:chainId"
      // BSC = 56, Solana = 1399811149
      const codexChainId = chainConfig.chain === Chain.SOLANA ? 1399811149 : 56;
      const symbol = `${tokenAddress}:${codexChainId}`;
      
    const query = `
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
          query,
          variables: {
            symbol,
            from: timeFrom,
            to: timeNow,
            resolution, // Dynamic: '1' or '5'
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      codexRequestTracker.logRequest('candle', {
        resolution,
        chain: chainConfig.chain,
        statusCode: response.status,
        success: response.ok,
        errorType: response.ok ? undefined : `http_${response.status}`,
      });

      if (!response.ok) {
        logger.warn(`[PriceActionAnalyzer] Codex API returned ${response.status}`);
        return [];
      }
      
      const data = await response.json() as any;
      
      // Check for errors
      if (data.errors) {
        logger.warn('[PriceActionAnalyzer] Codex GraphQL errors:', data.errors[0]?.message);
        return [];
      }
      
      const bars = data.data?.getBars;
      if (!bars || !bars.t || !Array.isArray(bars.t)) {
        logger.warn('[PriceActionAnalyzer] Invalid Codex response format');
        return [];
      }
      
      // Codex returns parallel arrays: o[], h[], l[], c[], t[], volume[]
      // Convert to array of Candle objects
      const candles: Candle[] = bars.t.map((timestamp: number, i: number) => ({
        timestamp,
        open: parseFloat(bars.o[i]),
        high: parseFloat(bars.h[i]),
        low: parseFloat(bars.l[i]),
        close: parseFloat(bars.c[i]),
        volume: parseFloat(bars.volume[i] || 0),
      }));
      
      // Get last N candles
      const recentCandles = candles.slice(-count);
      
      logger.debug(`[PriceActionAnalyzer] Fetched ${recentCandles.length} ${resolution}-minute candles from Codex`);
      return recentCandles;
      
    } catch (error: any) {
      try {
        const chainConfig = getChainConfig();
        const { codexRequestTracker } = await import('../../utils/codex-request-tracker');
        codexRequestTracker.logRequest('candle', {
          resolution,
          chain: chainConfig.chain,
          success: false,
          errorType: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network',
        });
      } catch { /* swallow tracker errors */ }
      logger.warn(`[PriceActionAnalyzer] Failed to fetch ${resolution}m candles from Codex:`, error);
      return [];
    }
  }
  
  /**
   * Analyze candlestick patterns for AI interpretation
   */
  private analyzeCandlePatterns(candles: Candle[], timeframe: string): string {
    if (candles.length < 3) return 'Insufficient data';
    
    const patterns: string[] = [];
    const last3 = candles.slice(-3);
    const last5 = candles.slice(-5);
    
    // Get the most recent candles
    const current = last3[2];
    const prev1 = last3[1];
    const prev2 = last3[0];
    
    // Calculate changes
    const currentChange = ((current.close - current.open) / current.open) * 100;
    const prev1Change = ((prev1.close - prev1.open) / prev1.open) * 100;
    const prev2Change = ((prev2.close - prev2.open) / prev2.open) * 100;
    
    // 1. REVERSAL PATTERNS (CRITICAL - dump starting)
    
    // Three consecutive red candles = strong downtrend
    if (currentChange < 0 && prev1Change < 0 && prev2Change < 0) {
      patterns.push('THREE RED BARS');
    }
    
    // Recent candles turning red after green = potential reversal
    if (currentChange < -2 && prev1Change < -2 && prev2Change > 2) {
      patterns.push('REVERSAL - Dump after pump');
    }
    
    // Large red candle with high volume = panic selling
    if (currentChange < -5 && current.volume > prev1.volume * 1.5) {
      patterns.push('PANIC SELL');
    }
    
    // Lower highs = downtrend forming
    if (current.high < prev1.high && prev1.high < prev2.high) {
      patterns.push('LOWER HIGHS');
    }
    
    // 2. CONTINUATION PATTERNS (pump continuing)
    
    // Three consecutive green candles = strong uptrend
    if (currentChange > 0 && prev1Change > 0 && prev2Change > 0) {
      patterns.push('THREE GREEN BARS');
    }
    
    // Higher lows = uptrend intact
    if (current.low > prev1.low && prev1.low > prev2.low) {
      patterns.push('HIGHER LOWS');
    }
    
    // Small consolidation after pump = accumulation
    if (Math.abs(currentChange) < 2 && Math.abs(prev1Change) < 2 && prev2Change > 5) {
      patterns.push('CONSOLIDATION');
    }
    
    // 3. VOLUME ANALYSIS
    
    const avgVolume = last5.reduce((sum, c) => sum + c.volume, 0) / last5.length;
    const currentVolRatio = current.volume / avgVolume;
    
    // High volume on green candle = strong buying
    if (currentChange > 3 && currentVolRatio > 1.5) {
      patterns.push('STRONG BUYING');
    }
    
    // Low volume on green candle = weak pump
    if (currentChange > 3 && currentVolRatio < 0.7) {
      patterns.push('WEAK PUMP');
    }
    
    // 4. CANDLESTICK FORMATIONS
    
    // Doji (indecision) - open ≈ close
    const isDoji = Math.abs(current.close - current.open) / current.open < 0.005;
    if (isDoji && prev1Change > 5) {
      patterns.push('DOJI AFTER PUMP');
    }
    
    // Long wick on top = rejection of higher prices
    const upperWick = current.high - Math.max(current.open, current.close);
    const bodySize = Math.abs(current.close - current.open);
    if (upperWick > bodySize * 2 && currentChange > 0) {
      patterns.push('LONG UPPER WICK');
    }
    
    // Long wick on bottom = strong support
    const lowerWick = Math.min(current.open, current.close) - current.low;
    if (lowerWick > bodySize * 2 && currentChange < 0) {
      patterns.push('LONG LOWER WICK');
    }
    
    // 5. MOMENTUM ANALYSIS
    
    // Accelerating pump (each candle bigger than last)
    if (currentChange > prev1Change && prev1Change > prev2Change && currentChange > 3) {
      patterns.push('ACCELERATING PUMP');
    }
    
    // Decelerating pump (each candle smaller than last)
    if (currentChange > 0 && currentChange < prev1Change && prev1Change < prev2Change) {
      patterns.push('DECELERATING PUMP');
    }
    
    // No clear pattern
    if (patterns.length === 0) {
      patterns.push('NO CLEAR PATTERN');
    }
    
    return patterns.join('\n  • ');
  }
  
  /**
   * Calculate price action metrics from pair data and candles
   */
  private calculatePriceAction(pair: DexScreenerPair, candles1m: Candle[], candles5m: Candle[]): PriceAction {
    const currentPrice = parseFloat(pair.priceUsd);
    
    // Get price changes from DexScreener
    const priceChange5m = pair.priceChange?.m5 || 0;
    const priceChange1h = pair.priceChange?.h1 || 0;
    const priceChange6h = pair.priceChange?.h6 || 0;
    const priceChange24h = pair.priceChange?.h24; // Extract 24h price change from DexScreener
    
    // Calculate 1m and 4h (interpolate from available data)
    const priceChange1m = this.interpolatePrice(0, priceChange5m, 1, 0, 5);
    const priceChange4h = this.interpolatePrice(priceChange1h, priceChange6h, 4, 1, 6);
    
    // Calculate volatility from our 3 timeframes (overall, for backward compatibility)
    const volatility = this.calculateVolatility([
      priceChange1m,
      priceChange5m,
      priceChange4h,
    ]);
    
    // Calculate volatility for specific timeframes (quant analysis)
    const volatility5m = calculateVolatility5m(candles5m);
    const volatility1h = calculateVolatility1h(candles5m);
    const volatility24h = calculateVolatility24h(priceChange24h);
    
    // Determine overall trend
    const trend = this.determineTrend(priceChange1m, priceChange5m, priceChange4h);
    
    // Calculate momentum (1m vs 5m shows acceleration) - overall, for backward compatibility
    const momentum = this.calculateMomentum(priceChange1m, priceChange5m);
    
    // Calculate momentum score (5m vs 1h) - quant approach
    const momentumScore = calculateMomentumScore(priceChange5m, priceChange1h);
    const momentumDirection = this.analyzeMomentum5m(candles5m).direction;
    
    // Generate human-readable interpretation
    const interpretation = this.generateInterpretation(
      priceChange1m, priceChange5m, priceChange4h, trend, momentum
    );
    
    // Analyze candlestick patterns for both timeframes
    const patterns1m = this.analyzeCandlePatterns(candles1m, '1m');
    const patterns5m = this.analyzeCandlePatterns(candles5m, '5m');
    
    const priceAction: PriceAction = {
      priceChange1m: Number(priceChange1m.toFixed(2)),
      priceChange5m: Number(priceChange5m.toFixed(2)),
      priceChange4h: Number(priceChange4h.toFixed(2)),
      priceChange24h: priceChange24h !== undefined ? Number(priceChange24h.toFixed(2)) : undefined, // From DexScreener
      volatility: Number(volatility.toFixed(3)),
      volatility5m: volatility5m !== undefined ? Number(volatility5m.toFixed(3)) : undefined,
      volatility1h: volatility1h !== undefined ? Number(volatility1h.toFixed(3)) : undefined,
      volatility24h: volatility24h !== undefined ? Number(volatility24h.toFixed(3)) : undefined,
      trend,
      momentum: Number(momentum.toFixed(2)),
      momentumScore: momentumScore !== undefined ? Number(momentumScore.toFixed(3)) : undefined,
      momentumDirection,
      interpretation,
      candles1m, // CRITICAL for catching dumps
      candles5m, // Overall pattern
      patterns1m, // Pattern interpretation for 1m
      patterns5m, // Pattern interpretation for 5m
      momentum5m: this.analyzeMomentum5m(candles5m), // NEW: Momentum direction analysis
      volumeTrend: this.analyzeVolumeTrend(candles5m), // NEW: Volume trend analysis
    };
    
    // Log results
    logger.info(`[PriceActionAnalyzer] Price Action for ${pair.baseToken.symbol}:`);
    logger.info(`  Current Price: $${currentPrice.toExponential(4)}`);
    logger.info(`  📊 Timeframes:`);
    logger.info(`    1m:  ${this.formatChange(priceChange1m)}  (entry timing)`);
    logger.info(`    5m:  ${this.formatChange(priceChange5m)}  (momentum)`);
    logger.info(`    4h:  ${this.formatChange(priceChange4h)}  (trend context)`);
    logger.info(`  📈 Trend: ${trend.toUpperCase()} ${this.getTrendEmoji(trend)}`);
    logger.info(`  💨 Momentum: ${momentum.toFixed(2)} ${this.interpretMomentum(momentum)}`);
    logger.info(`  🎲 Volatility: ${volatility.toFixed(3)} ${this.interpretVolatility(volatility)}`);
    logger.info(`  🕯️  Candles: ${candles1m.length} 1-min bars, ${candles5m.length} 5-min bars`);
    
    // Log NEW momentum & volume analysis
    if (priceAction.momentum5m) {
      const m = priceAction.momentum5m;
      logger.info(`  🚀 5m Momentum: ${m.direction} (${m.strength})`);
      logger.info(`     Bars: ${m.recentBars.join(' → ')}`);
      logger.info(`     ${m.description}`);
    }
    if (priceAction.volumeTrend) {
      const v = priceAction.volumeTrend;
      logger.info(`  📊 Volume Trend: ${v.direction} (${v.strength})`);
      logger.info(`     Volumes: ${v.recentVolumes.join(' → ')}`);
      logger.info(`     ${v.description}`);
    }
    
    logger.info(`  💡 Interpretation: ${interpretation}`);
    
    return priceAction;
  }
  
  /**
   * Interpolate price change between two time points
   */
  private interpolatePrice(
    change1: number,
    change2: number,
    targetMinutes: number,
    time1Minutes: number,
    time2Minutes: number
  ): number {
    // Simple linear interpolation
    const ratio = (targetMinutes - time1Minutes) / (time2Minutes - time1Minutes);
    return change1 + (change2 - change1) * ratio;
  }
  
  /**
   * Calculate volatility from price changes (0-1 scale)
   * @deprecated Use calculateVolatility from quant-calculations.ts instead
   */
  private calculateVolatility(priceChanges: number[]): number {
    const { calculateVolatility: calcVol } = require('../../utils/quant-calculations');
    return calcVol(priceChanges) || 0;
  }
  
  /**
   * Determine price trend from multiple timeframes
   */
  private determineTrend(
    change1: number,
    change2: number,
    change3: number
  ): 'up' | 'down' | 'sideways' {
    // Weighted average (recent gets more weight)
    const weighted = change1 * 0.5 + change2 * 0.3 + change3 * 0.2;
    
    if (weighted > 2) return 'up';
    if (weighted < -2) return 'down';
    return 'sideways';
  }
  
  /**
   * Calculate momentum (-1 to 1)
   * Compares 1m vs 5m to detect acceleration/deceleration
   * (Legacy method for backward compatibility)
   */
  private calculateMomentum(
    change1m: number,
    change5m: number
  ): number {
    // If 1m is more positive than 5m average = accelerating up
    // If 1m is more negative than 5m average = accelerating down
    const momentum = (change1m - change5m) / 50; // Normalize
    
    return Math.max(-1, Math.min(1, momentum));
  }
  
  
  /**
   * Generate human-readable interpretation
   */
  private generateInterpretation(
    change1m: number,
    change5m: number,
    change4h: number,
    trend: string,
    momentum: number
  ): string {
    const parts: string[] = [];
    
    // 4h context (is it a new token or established?)
    if (change4h > 50) {
      parts.push('Massive 4h pump');
    } else if (change4h > 20) {
      parts.push('Strong 4h rally');
    } else if (change4h > 5) {
      parts.push('Bullish 4h');
    } else if (change4h < -20) {
      parts.push('Heavy 4h dump');
    } else if (change4h < -5) {
      parts.push('Bearish 4h');
    } else {
      parts.push('Flat 4h');
    }
    
    // Immediate action (what's happening NOW)
    if (change5m > 10 && momentum > 0.3) {
      parts.push('pumping NOW 🚀');
    } else if (change5m < -10 && momentum < -0.3) {
      parts.push('dumping NOW 📉');
    } else if (change5m > 5) {
      parts.push('rising');
    } else if (change5m < -5) {
      parts.push('falling');
    } else {
      parts.push('consolidating');
    }
    
    // Momentum insight
    if (momentum > 0.4) {
      parts.push('accelerating up');
    } else if (momentum < -0.4) {
      parts.push('accelerating down');
    }
    
    return parts.join(', ');
  }
  
  /**
   * Format price change with color
   */
  private formatChange(change: number): string {
    const sign = change > 0 ? '+' : '';
    const formatted = `${sign}${change.toFixed(2)}%`;
    return formatted.padStart(8);
  }
  
  /**
   * Helper: Get trend emoji
   */
  private getTrendEmoji(trend: string): string {
    if (trend === 'up') return '📈';
    if (trend === 'down') return '📉';
    return '➡️';
  }
  
  /**
   * Helper: Interpret momentum
   */
  private interpretMomentum(momentum: number): string {
    if (momentum > 0.5) return '🚀 (strong bullish)';
    if (momentum > 0.2) return '📈 (bullish)';
    if (momentum > -0.2) return '⚪ (neutral)';
    if (momentum > -0.5) return '📉 (bearish)';
    return '🚨 (strong bearish)';
  }
  
  /**
   * Helper: Interpret volatility
   */
  private interpretVolatility(volatility: number): string {
    if (volatility > 0.7) return '🌋 (extreme - very risky)';
    if (volatility > 0.4) return '⚡ (high - risky)';
    if (volatility > 0.2) return '🎢 (moderate)';
    return '😴 (low - stable)';
  }
  
  /**
   * NEW: Analyze 5m momentum direction (ACCELERATING vs DECELERATING)
   * This helps catch NEW waves vs END of waves
   */
  private analyzeMomentum5m(candles: Candle[]): {
    direction: 'ACCELERATING' | 'DECELERATING' | 'STABLE' | 'INSUFFICIENT_DATA';
    recentBars: string[];
    strength: 'STRONG' | 'MODERATE' | 'WEAK';
    description: string;
  } {
    if (!candles || candles.length < 3) {
      return {
        direction: 'INSUFFICIENT_DATA',
        recentBars: [],
        strength: 'WEAK',
        description: 'Not enough candle data'
      };
    }
    
    // Get last 3 candles (most recent movement)
    const last3 = candles.slice(-3);
    const changes = last3.map(c => {
      const change = ((c.close - c.open) / c.open) * 100;
      return {
        value: change,
        formatted: `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`
      };
    });
    
    const [bar1, bar2, bar3] = changes;
    
    // Determine direction
    let direction: 'ACCELERATING' | 'DECELERATING' | 'STABLE';
    let strength: 'STRONG' | 'MODERATE' | 'WEAK';
    let description: string;
    
    // ACCELERATING: Each bar bigger than previous
    if (bar3.value > bar2.value && bar2.value > bar1.value) {
      const totalIncrease = Math.abs(bar3.value - bar1.value);
      if (totalIncrease > 10) {
        direction = 'ACCELERATING';
        strength = 'STRONG';
        description = `Strong acceleration: ${bar1.formatted} → ${bar2.formatted} → ${bar3.formatted}. New wave starting!`;
      } else if (totalIncrease > 3) {
        direction = 'ACCELERATING';
        strength = 'MODERATE';
        description = `Moderate acceleration: ${bar1.formatted} → ${bar2.formatted} → ${bar3.formatted}. Building momentum.`;
      } else {
        direction = 'STABLE';
        strength = 'WEAK';
        description = `Slight uptick: ${bar1.formatted} → ${bar2.formatted} → ${bar3.formatted}. Minimal change.`;
      }
    }
    // DECELERATING: Each bar smaller than previous
    else if (bar3.value < bar2.value && bar2.value < bar1.value) {
      const totalDecrease = Math.abs(bar1.value - bar3.value);
      if (totalDecrease > 10) {
        direction = 'DECELERATING';
        strength = 'STRONG';
        description = `Strong deceleration: ${bar1.formatted} → ${bar2.formatted} → ${bar3.formatted}. Momentum dying - wave ending!`;
      } else if (totalDecrease > 3) {
        direction = 'DECELERATING';
        strength = 'MODERATE';
        description = `Moderate deceleration: ${bar1.formatted} → ${bar2.formatted} → ${bar3.formatted}. Losing steam.`;
      } else {
        direction = 'STABLE';
        strength = 'WEAK';
        description = `Slight decline: ${bar1.formatted} → ${bar2.formatted} → ${bar3.formatted}. Minimal change.`;
      }
    }
    // Recovery pattern
    else if (bar1.value < 0 && bar2.value < bar3.value && bar3.value > 0) {
      direction = 'ACCELERATING';
      strength = 'MODERATE';
      description = `Recovery pattern: ${bar1.formatted} → ${bar2.formatted} → ${bar3.formatted}. Bouncing from dip - possible Wave 2!`;
    }
    // STABLE or MIXED
    else {
      direction = 'STABLE';
      strength = 'WEAK';
      description = `Mixed signals: ${bar1.formatted} → ${bar2.formatted} → ${bar3.formatted}. No clear trend.`;
    }
    
    return {
      direction,
      recentBars: changes.map(c => c.formatted),
      strength,
      description
    };
  }
  
  /**
   * NEW: Analyze volume trend (INCREASING vs DECREASING)
   */
  private analyzeVolumeTrend(candles: Candle[]): {
    direction: 'INCREASING' | 'DECREASING' | 'STABLE' | 'INSUFFICIENT_DATA';
    recentVolumes: string[];
    strength: 'STRONG' | 'MODERATE' | 'WEAK';
    description: string;
  } {
    if (!candles || candles.length < 3) {
      return {
        direction: 'INSUFFICIENT_DATA',
        recentVolumes: [],
        strength: 'WEAK',
        description: 'Not enough volume data'
      };
    }
    
    // Get last 3 candles
    const last3 = candles.slice(-3);
    const volumes = last3.map(c => ({
      value: c.volume,
      formatted: `$${Math.round(c.volume).toLocaleString()}`
    }));
    
    const [vol1, vol2, vol3] = volumes;
    
    // Determine direction
    let direction: 'INCREASING' | 'DECREASING' | 'STABLE';
    let strength: 'STRONG' | 'MODERATE' | 'WEAK';
    let description: string;
    
    // INCREASING: Each bar higher volume
    if (vol3.value > vol2.value && vol2.value > vol1.value) {
      const increase = ((vol3.value - vol1.value) / vol1.value) * 100;
      if (increase > 100) {
        direction = 'INCREASING';
        strength = 'STRONG';
        description = `Volume surging +${increase.toFixed(0)}%: ${vol1.formatted} → ${vol2.formatted} → ${vol3.formatted}. New buyers flooding in!`;
      } else if (increase > 30) {
        direction = 'INCREASING';
        strength = 'MODERATE';
        description = `Volume growing +${increase.toFixed(0)}%: ${vol1.formatted} → ${vol2.formatted} → ${vol3.formatted}. Interest building.`;
      } else {
        direction = 'STABLE';
        strength = 'WEAK';
        description = `Volume slight increase: ${vol1.formatted} → ${vol2.formatted} → ${vol3.formatted}.`;
      }
    }
    // DECREASING: Each bar lower volume
    else if (vol3.value < vol2.value && vol2.value < vol1.value) {
      const decrease = ((vol1.value - vol3.value) / vol1.value) * 100;
      if (decrease > 50) {
        direction = 'DECREASING';
        strength = 'STRONG';
        description = `Volume collapsing -${decrease.toFixed(0)}%: ${vol1.formatted} → ${vol2.formatted} → ${vol3.formatted}. Buyers exhausted!`;
      } else if (decrease > 20) {
        direction = 'DECREASING';
        strength = 'MODERATE';
        description = `Volume declining -${decrease.toFixed(0)}%: ${vol1.formatted} → ${vol2.formatted} → ${vol3.formatted}. Interest fading.`;
      } else {
        direction = 'STABLE';
        strength = 'WEAK';
        description = `Volume slight decrease: ${vol1.formatted} → ${vol2.formatted} → ${vol3.formatted}.`;
      }
    }
    // STABLE or MIXED
    else {
      direction = 'STABLE';
      strength = 'WEAK';
      description = `Volume mixed: ${vol1.formatted} → ${vol2.formatted} → ${vol3.formatted}. No clear trend.`;
    }
    
    return {
      direction,
      recentVolumes: volumes.map(v => v.formatted),
      strength,
      description
    };
  }
}

