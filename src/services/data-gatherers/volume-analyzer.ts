/**
 * Volume Metrics Data Gatherer (Enhanced with DexScreener API)
 * 
 * Now uses DexScreener for accurate volume data from all DEXs
 */

import { scanHotTokens } from '../../utils/scanner';
import { logger } from '../../utils/logger';
import { getChainConfig, Chain } from '../../config/chain';
import {
  calculateVolumeRatio5m1h,
  calculateVolumeRatio1h24h,
  calculateVolumeVelocity,
  calculateVolumeAcceleration,
} from '../../utils/quant-calculations';

export interface VolumeMetrics {
  volume5m: number;
  volume10m: number;
  volume15m: number;
  volume1h: number;            // 1-hour volume (for trend calculation)
  volume6h?: number;            // 6-hour volume (for longer trend)
  volume24h?: number;            // 24-hour volume (from DexScreener, not estimated)
  volumeVelocity?: number;        // Rate of change (vol5m / (vol1h / 12)) - undefined if insufficient data
  volumeAcceleration?: number;    // 2nd derivative (rate of change of velocity) - undefined if insufficient data
  volumeRatio5m1h?: number;      // (vol5m / vol1h) * 12
  volumeRatio1h24h?: number;     // (vol1h / vol24h) * 24
  buyVsSellVolume: number;       // Ratio
  // Transaction counts (from DexScreener - more reliable than blockchain tracking for Solana)
  txnBuys5m?: number;            // Buy transactions in last 5 minutes
  txnSells5m?: number;           // Sell transactions in last 5 minutes
  txnBuys1h?: number;            // Buy transactions in last 1 hour
  txnSells1h?: number;           // Sell transactions in last 1 hour
  txnBuys6h?: number;            // Buy transactions in last 6 hours
  txnSells6h?: number;           // Sell transactions in last 6 hours
  txnBuys24h?: number;           // Buy transactions in last 24 hours
  txnSells24h?: number;          // Sell transactions in last 24 hours
  // Extended DexScreener pair data (fetched in same API call)
  // Price changes
  priceChange5m?: number;        // Price change % in last 5 minutes
  priceChange1h?: number;        // Price change % in last 1 hour
  priceChange6h?: number;        // Price change % in last 6 hours
  priceChange24h?: number;       // Price change % in last 24 hours (from DexScreener)
  // Pair metadata
  pairAddress?: string;          // DEX pair address
  dexId?: string;                // DEX identifier (e.g., raydium, pancakeswap, pumpfun)
  quoteToken?: string;           // Quote token symbol (e.g., SOL, USDC, BNB)
  pairCreatedAt?: number;        // Pair creation timestamp in milliseconds
  // Liquidity details
  liquidityBase?: number;       // Base token liquidity amount
  liquidityQuote?: number;      // Quote token liquidity amount
  // Market metrics
  fdv?: number;                  // Fully Diluted Valuation
}

export interface DexScreenerPairData {
  // Pair metadata
  pairAddress?: string;
  dexId?: string;
  quoteToken?: string;
  pairCreatedAt?: number; // timestamp in milliseconds
  
  // Price changes
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange6h?: number;
  priceChange24h?: number;
  
  // Liquidity details
  liquidityBase?: number;
  liquidityQuote?: number;
  
  // Market metrics
  fdv?: number; // Fully Diluted Valuation
}

interface DexScreenerResponse {
  schemaVersion: string;
  pairs: Array<{
    chainId: string;
    dexId: string;
    pairAddress: string;
    baseToken: {
      address: string;
      symbol: string;
    };
    quoteToken?: {
      address: string;
      symbol: string;
      name: string;
    };
    priceUsd?: string;
    priceChange?: {
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
      base?: number;
      quote?: number;
    };
    fdv?: number;
    pairCreatedAt?: number;
  }>;
}

export class VolumeAnalyzer {
  /**
   * Get full DexScreener pair data (includes all metadata, price changes, liquidity, etc.)
   * NOTE: This is a convenience method. For efficiency, use getVolumeMetrics() which includes all this data
   */
  async getDexScreenerPairData(tokenAddress: string): Promise<DexScreenerPairData | null> {
    const metrics = await this.getVolumeMetrics(tokenAddress);
    if (!metrics) return null;
    
    return {
      pairAddress: metrics.pairAddress,
      dexId: metrics.dexId,
      quoteToken: metrics.quoteToken,
      pairCreatedAt: metrics.pairCreatedAt,
      priceChange5m: metrics.priceChange5m,
      priceChange1h: metrics.priceChange1h,
      priceChange6h: metrics.priceChange6h,
      priceChange24h: metrics.priceChange24h,
      liquidityBase: metrics.liquidityBase,
      liquidityQuote: metrics.liquidityQuote,
      fdv: metrics.fdv,
    };
  }

  /**
   * Calculate volume metrics for a token using DexScreener API
   */
  async getVolumeMetrics(tokenAddress: string): Promise<VolumeMetrics> {
    logger.debug(`[VolumeAnalyzer] Fetching volume for ${tokenAddress.substring(0, 10)}...`);
    
    try {
      // Try DexScreener API first (more accurate, covers all DEXs)
      const dexMetrics = await this.getVolumeFromDexScreener(tokenAddress);
      if (dexMetrics) {
        logger.info('[VolumeAnalyzer] ✅ Using DexScreener data (all DEXs)');
        return dexMetrics;
      }
      
      // Fallback to scanner (bot trades only)
      logger.info('[VolumeAnalyzer] ℹ️  Falling back to scanner data (bot trades only)');
      return await this.getVolumeFromScanner(tokenAddress);
      
    } catch (error) {
      logger.error('[VolumeAnalyzer] Error:', error);
      return this.getEmptyMetrics();
    }
  }
  
  /**
   * Get volume from DexScreener API (accurate, all DEXs)
   */
  private async getVolumeFromDexScreener(tokenAddress: string): Promise<VolumeMetrics | null> {
    try {
      const chainConfig = getChainConfig();
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
        { signal: AbortSignal.timeout(5000) }
      );
      
      if (!response.ok) {
        logger.warn(`[VolumeAnalyzer] DexScreener API returned ${response.status}`);
        return null;
      }
      
      const data = await response.json() as DexScreenerResponse;
      
      // Determine chain ID for DexScreener
      const dexScreenerChainId = chainConfig.chain === Chain.SOLANA ? 'solana' : 'bsc';
      
      // Find chain-specific pairs with highest liquidity
      const chainPairs = data.pairs?.filter(p => p.chainId === dexScreenerChainId) || [];
      if (chainPairs.length === 0) {
        logger.warn(`[VolumeAnalyzer] No ${dexScreenerChainId} pairs found on DexScreener`);
        return null;
      }
      
      // Sort by liquidity (highest first)
      const sortedPairs = chainPairs.sort((a, b) => {
        const liqA = a.liquidity?.usd || 0;
        const liqB = b.liquidity?.usd || 0;
        return liqB - liqA;
      });
      
      const mainPair = sortedPairs[0]; // Most liquid pair
      
      // Extract volume data
      const volume5m = mainPair.volume?.m5 || 0;
      const volume1h = mainPair.volume?.h1 || 0;
      const volume6h = mainPair.volume?.h6 || 0;
      const volume24h = mainPair.volume?.h24 || 0;
      
      // Estimate 10m and 15m from available data
      // Assuming linear distribution (rough but reasonable)
      const volume10m = volume5m * 2;
      const volume15m = volume5m * 3;
      
      // Get buy/sell ratio from transactions
      const txns5m = mainPair.txns?.m5;
      const txns1h = mainPair.txns?.h1;
      const txns6h = mainPair.txns?.h6;
      const txns24h = mainPair.txns?.h24;
      const buyVsSellVolume = txns5m && txns5m.sells > 0 
        ? txns5m.buys / txns5m.sells 
        : txns5m?.buys || 1;
      
      // Calculate volume ratios (quant approach: adjacent timeframes)
      const volumeRatio5m1h = calculateVolumeRatio5m1h(volume5m, volume1h);
      const volumeRatio1h24h = calculateVolumeRatio1h24h(volume1h, volume24h);
      
      // Calculate velocity and acceleration (centralized validation)
      const volumeVelocity = calculateVolumeVelocity(volume5m, volume1h);
      const volumeAcceleration = calculateVolumeAcceleration(volume5m, volume10m, volume1h);
      
      const metrics: VolumeMetrics = {
        volume5m: Math.round(volume5m),
        volume10m: Math.round(volume10m),
        volume15m: Math.round(volume15m),
        volume1h: Math.round(volume1h),
        volume6h: volume6h > 0 ? Math.round(volume6h) : undefined,
        volume24h: volume24h > 0 ? Math.round(volume24h) : undefined,
        volumeVelocity: volumeVelocity !== undefined ? Number(volumeVelocity.toFixed(2)) : undefined,
        volumeAcceleration: volumeAcceleration !== undefined ? Number(volumeAcceleration.toFixed(2)) : undefined,
        volumeRatio5m1h: volumeRatio5m1h !== undefined ? Number(volumeRatio5m1h.toFixed(2)) : undefined,
        volumeRatio1h24h: volumeRatio1h24h !== undefined ? Number(volumeRatio1h24h.toFixed(2)) : undefined,
        buyVsSellVolume: Number(buyVsSellVolume.toFixed(2)),
        // Transaction counts for all timeframes
        txnBuys5m: txns5m?.buys,
        txnSells5m: txns5m?.sells,
        txnBuys1h: txns1h?.buys,
        txnSells1h: txns1h?.sells,
        txnBuys6h: txns6h?.buys,
        txnSells6h: txns6h?.sells,
        txnBuys24h: txns24h?.buys,
        txnSells24h: txns24h?.sells,
        // Extended DexScreener pair data (from same API call)
        priceChange5m: mainPair.priceChange?.m5,
        priceChange1h: mainPair.priceChange?.h1,
        priceChange6h: mainPair.priceChange?.h6,
        priceChange24h: mainPair.priceChange?.h24,
        pairAddress: mainPair.pairAddress,
        dexId: mainPair.dexId,
        quoteToken: mainPair.quoteToken?.symbol,
        pairCreatedAt: mainPair.pairCreatedAt,
        liquidityBase: mainPair.liquidity?.base,
        liquidityQuote: mainPair.liquidity?.quote,
        fdv: mainPair.fdv,
      };
      
      logger.info(`[VolumeAnalyzer] DexScreener metrics:`);
      logger.info(`  Volume 5m: $${metrics.volume5m.toLocaleString()}`);
      logger.info(`  Volume 10m: $${metrics.volume10m.toLocaleString()} (estimated)`);
      logger.info(`  Volume 15m: $${metrics.volume15m.toLocaleString()} (estimated)`);
      logger.info(`  Volume 1h: $${metrics.volume1h.toLocaleString()}`);
      if (metrics.volume6h) logger.info(`  Volume 6h: $${metrics.volume6h.toLocaleString()}`);
      if (metrics.volume24h) logger.info(`  Volume 24h: $${metrics.volume24h.toLocaleString()}`);
      logger.info(`  Velocity: ${metrics.volumeVelocity !== undefined ? `${metrics.volumeVelocity}x` : 'N/A'}`);
      logger.info(`  Acceleration: ${metrics.volumeAcceleration !== undefined ? `${metrics.volumeAcceleration > 0 ? '+' : ''}${metrics.volumeAcceleration}` : 'N/A'}`);
      logger.info(`  Buy/Sell Ratio: ${metrics.buyVsSellVolume}:1`);
      if (txns5m) {
        logger.info(`  Transactions (5m): ${txns5m.buys}B / ${txns5m.sells}S`);
      }
      if (txns1h) {
        logger.info(`  Transactions (1h): ${txns1h.buys}B / ${txns1h.sells}S`);
      }
      if (txns6h) {
        logger.info(`  Transactions (6h): ${txns6h.buys}B / ${txns6h.sells}S`);
      }
      if (txns24h) {
        logger.info(`  Transactions (24h): ${txns24h.buys}B / ${txns24h.sells}S`);
      }
      
      return metrics;
      
    } catch (error) {
      logger.warn('[VolumeAnalyzer] DexScreener fetch failed:', error);
      return null;
    }
  }
  
  /**
   * Get volume from scanner (fallback, bot trades only)
   */
  private async getVolumeFromScanner(tokenAddress: string): Promise<VolumeMetrics> {
    const scanResult = await scanHotTokens();
    
    const tokenData = scanResult.topTokens.find(
      t => t.token.toLowerCase() === tokenAddress.toLowerCase()
    );
    
    if (!tokenData) {
      logger.warn(`[VolumeAnalyzer] Token not found in scanner`);
      return this.getEmptyMetrics();
    }
    
    const metadata = scanResult.tokenMetadata.get(tokenData.token);
    if (!metadata) {
      logger.warn(`[VolumeAnalyzer] No metadata found`);
      return this.getEmptyMetrics();
    }
    
    // Calculate from scanner data (bot trades only)
    const volume24h = metadata.volume24h;
    const volume1h = volume24h / 24;  // Estimate 1h from 24h
    const volume15m = volume24h * (15 / (24 * 60));
    const volume10m = volume15m * (10 / 15);
    const volume5m = volume15m * (5 / 15);
    
    // Calculate velocity and acceleration (centralized validation)
    const volumeVelocity = calculateVolumeVelocity(volume5m, volume1h);
    const volumeAcceleration = calculateVolumeAcceleration(volume5m, volume10m, volume1h);
    
    const buyVsSellVolume = tokenData.sells > 0 
      ? tokenData.buys / tokenData.sells 
      : tokenData.buys;
    
    const metrics: VolumeMetrics = {
      volume5m: Math.round(volume5m),
      volume10m: Math.round(volume10m),
      volume15m: Math.round(volume15m),
      volume1h: Math.round(volume1h),
      volumeVelocity: volumeVelocity !== undefined ? Number(volumeVelocity.toFixed(2)) : undefined,
      volumeAcceleration: volumeAcceleration !== undefined ? Number(volumeAcceleration.toFixed(2)) : undefined,
      volumeRatio5m1h: undefined, // Can't calculate from scanner data alone
      volumeRatio1h24h: undefined, // Can't calculate from scanner data alone
      buyVsSellVolume: Number(buyVsSellVolume.toFixed(2)),
    };
    
    logger.info(`[VolumeAnalyzer] Scanner metrics (bot trades only):`);
    logger.info(`  Volume 15m: $${metrics.volume15m.toLocaleString()}`);
    logger.info(`  Volume 10m: $${metrics.volume10m.toLocaleString()}`);
    logger.info(`  Volume 5m: $${metrics.volume5m.toLocaleString()}`);
    logger.info(`  Velocity: ${metrics.volumeVelocity !== undefined ? `${metrics.volumeVelocity}x` : 'N/A'}`);
    logger.info(`  Buy/Sell Ratio: ${metrics.buyVsSellVolume}:1`);
    
    return metrics;
  }
  
  /**
   * Return empty metrics as fallback
   */
  private getEmptyMetrics(): VolumeMetrics {
    return {
      volume5m: 0,
      volume10m: 0,
      volume15m: 0,
      volume1h: 0,
      volumeVelocity: undefined,
      volumeAcceleration: undefined,
      buyVsSellVolume: 1,
    };
  }
}
