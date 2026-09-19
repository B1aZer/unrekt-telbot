/**
 * Liquidity Depth Data Gatherer
 * 
 * Analyzes liquidity depth and slippage using DexScreener API
 */

import { logger } from '../../utils/logger';

export interface LiquidityDepth {
  totalLiquidity: number;       // Total liquidity in USD
  slippageAt1000: number;       // Estimated slippage at $1k trade
  slippageAt5000: number;       // Estimated slippage at $5k trade
  slippageAt10000: number;      // Estimated slippage at $10k trade
  liquidityConcentration: number; // 0-1 (how concentrated is liquidity)
  poolInfo: {
    dexName: string;
    pairAddress: string;
    baseToken: string;
    quoteToken: string;
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
  quoteToken: {
    address: string;
    symbol: string;
    name: string;
  };
  priceUsd: string;
  liquidity?: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  fdv?: number;
  marketCap?: number;
  volume: {
    h24?: number;
  };
  txns: {
    h24?: {
      buys: number;
      sells: number;
    };
  };
}

interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[];
}

export class LiquidityDepthAnalyzer {
  /**
   * Analyze liquidity depth for a token
   */
  async analyze(tokenAddress: string): Promise<LiquidityDepth | null> {
    logger.debug(`[LiquidityDepthAnalyzer] Analyzing ${tokenAddress.substring(0, 10)}...`);
    
    try {
      // Fetch from DexScreener
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
        { signal: AbortSignal.timeout(5000) }
      );
      
      if (!response.ok) {
        logger.warn(`[LiquidityDepthAnalyzer] DexScreener API returned ${response.status}`);
        return null;
      }
      
      const data = await response.json() as DexScreenerResponse;
      
      // Find BSC pair with highest liquidity
      const bscPairs = data.pairs?.filter(p => p.chainId === 'bsc') || [];
      if (bscPairs.length === 0) {
        logger.warn('[LiquidityDepthAnalyzer] No BSC pairs found on DexScreener');
        return null;
      }
      
      // Sort by liquidity (highest first)
      const sortedPairs = bscPairs.sort((a, b) => {
        const liqA = a.liquidity?.usd || 0;
        const liqB = b.liquidity?.usd || 0;
        return liqB - liqA;
      });
      
      const mainPair = sortedPairs[0]; // Most liquid pair
      
      return this.calculateLiquidityMetrics(mainPair);
      
    } catch (error) {
      logger.error('[LiquidityDepthAnalyzer] Error:', error);
      return null;
    }
  }
  
  /**
   * Calculate liquidity metrics from pair data
   */
  private calculateLiquidityMetrics(pair: DexScreenerPair): LiquidityDepth {
    const totalLiquidity = pair.liquidity?.usd || 0;
    const volume24h = pair.volume?.h24 || 0;
    const price = parseFloat(pair.priceUsd);
    
    // Estimate slippage using liquidity/trade size ratio
    // Formula: slippage ≈ (trade_size / liquidity) * 100 * impact_factor
    // Impact factor varies by DEX (PancakeSwap ≈ 2-3)
    const impactFactor = 2.5;
    
    const slippageAt1000 = this.estimateSlippage(1000, totalLiquidity, impactFactor);
    const slippageAt5000 = this.estimateSlippage(5000, totalLiquidity, impactFactor);
    const slippageAt10000 = this.estimateSlippage(10000, totalLiquidity, impactFactor);
    
    // Calculate liquidity concentration (volume/liquidity ratio)
    // Higher ratio = more concentrated trading
    // 0.0-0.1 = low activity, 0.1-0.5 = moderate, 0.5+ = high
    const liquidityConcentration = volume24h > 0 && totalLiquidity > 0
      ? Math.min(volume24h / totalLiquidity, 1)
      : 0;
    
    const liquidityDepth: LiquidityDepth = {
      totalLiquidity: Math.round(totalLiquidity),
      slippageAt1000: Number(slippageAt1000.toFixed(2)),
      slippageAt5000: Number(slippageAt5000.toFixed(2)),
      slippageAt10000: Number(slippageAt10000.toFixed(2)),
      liquidityConcentration: Number(liquidityConcentration.toFixed(3)),
      poolInfo: {
        dexName: pair.dexId,
        pairAddress: pair.pairAddress,
        baseToken: pair.baseToken.symbol,
        quoteToken: pair.quoteToken.symbol,
      },
    };
    
    // Log results
    logger.info(`[LiquidityDepthAnalyzer] Liquidity for ${pair.baseToken.symbol}:`);
    logger.info(`  Total Liquidity: $${liquidityDepth.totalLiquidity.toLocaleString()}`);
    logger.info(`  Pool: ${liquidityDepth.poolInfo.dexName} (${liquidityDepth.poolInfo.baseToken}/${liquidityDepth.poolInfo.quoteToken})`);
    logger.info(`  Slippage Estimates:`);
    logger.info(`    @ $1,000:  ${liquidityDepth.slippageAt1000}% ${this.getSlippageRating(liquidityDepth.slippageAt1000)}`);
    logger.info(`    @ $5,000:  ${liquidityDepth.slippageAt5000}% ${this.getSlippageRating(liquidityDepth.slippageAt5000)}`);
    logger.info(`    @ $10,000: ${liquidityDepth.slippageAt10000}% ${this.getSlippageRating(liquidityDepth.slippageAt10000)}`);
    logger.info(`  Liquidity Concentration: ${liquidityDepth.liquidityConcentration} ${this.getConcentrationRating(liquidityDepth.liquidityConcentration)}`);
    
    return liquidityDepth;
  }
  
  /**
   * Estimate slippage for a given trade size
   * Formula: slippage ≈ (trade_size / liquidity) * 100 * impact_factor
   */
  private estimateSlippage(
    tradeSize: number,
    totalLiquidity: number,
    impactFactor: number
  ): number {
    if (totalLiquidity === 0) return 100; // Max slippage if no liquidity
    
    const ratio = tradeSize / totalLiquidity;
    const slippage = ratio * 100 * impactFactor;
    
    // Cap at 100% (can't lose more than 100% to slippage in practice)
    return Math.min(slippage, 100);
  }
  
  /**
   * Get human-readable slippage rating
   */
  private getSlippageRating(slippage: number): string {
    if (slippage < 1) return '✅ (excellent)';
    if (slippage < 3) return '🟢 (good)';
    if (slippage < 5) return '🟡 (acceptable)';
    if (slippage < 10) return '🟠 (high)';
    return '🔴 (very high)';
  }
  
  /**
   * Get human-readable concentration rating
   */
  private getConcentrationRating(concentration: number): string {
    if (concentration < 0.1) return '(low activity)';
    if (concentration < 0.3) return '(moderate activity)';
    if (concentration < 0.5) return '(high activity)';
    return '(very high activity)';
  }
}

