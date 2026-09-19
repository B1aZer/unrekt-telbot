/**
 * Solana Security Scanner
 * 
 * Comprehensive security analysis for Solana tokens combining:
 * - On-chain authority checks (mint/freeze)
 * - Holder distribution analysis
 * - RugCheck.xyz API integration
 * - DexScreener liquidity/activity validation
 * - Bonding curve detection
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { logger } from '../../utils/logger';
import type { SolanaToken } from './scanner';
import { apiCache } from '../api-cache';
import {
  batchPoolQuotes,
  POOL_RPC_ERROR,
  type PoolQuotePair,
} from './pool-quote-service';

export interface SolanaSecurityAnalysis {
  // Token info
  mint: string;
  symbol: string;
  
  // Safety checks
  isSafe: boolean;
  riskScore: number; // 0-100 (lower is better)
  
  // Authority checks (on-chain)
  mintAuthority: string | null; // null = renounced (good)
  freezeAuthority: string | null; // null = renounced (good)
  
  // Metadata
  metadataVerified: boolean;
  hasImage: boolean;
  
  // Holder distribution (on-chain)
  topHolderPercent: number;
  top10HolderPercent: number;
  
  // Liquidity
  lpLocked: boolean;
  lpLockedPercent: number;
  lpLockedUntil?: number;
  
  // Age
  tokenAge?: number; // seconds since creation
  poolAge?: number;
  
  // RugCheck data
  rugcheckScore?: number;
  rugcheckRisks?: string[];
  
  // Jupiter quote data (pre-trade liquidity checks at ~$100 position size)
  // Critical for ML training - detects tokens with poor entry/exit liquidity
  
  // BUY quote (SOL → Token, entry liquidity)
  jupiterBuyQuoteSuccess?: boolean;
  jupiterBuyQuotePriceImpact?: number;
  jupiterBuyQuoteOutAmount?: string;
  jupiterBuyQuoteRoutesCount?: number;
  jupiterBuyQuoteError?: string;
  
  // SELL quote (Token → SOL, exit liquidity)
  jupiterSellQuoteSuccess?: boolean;
  jupiterSellQuotePriceImpact?: number;
  jupiterSellQuoteOutAmount?: string;
  jupiterSellQuoteRoutesCount?: number;
  jupiterSellQuoteError?: string;
  
  // Risk warnings
  risks: string[];
  warnings: string[];
}

interface RugCheckResponse {
  mint: string;
  score?: number;
  risks?: Array<{
    name: string;
    description: string;
    level: 'danger' | 'warn' | 'info';
    score: number;
  }>;
  tokenMeta?: {
    name?: string;
    symbol?: string;
  };
  markets?: any[];
  topHolders?: Array<{
    address: string;
    pct: number;
  }>;
}

export class SolanaSecurityScanner {
  private connection: Connection;
  private rpcUrl: string;
  
  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.connection = new Connection(rpcUrl, 'confirmed');
    logger.info('🔷 Solana Security Scanner initialized with comprehensive checks');
  }
  
  /**
   * Check RugCheck.xyz API for token analysis
   * Results are cached for 1 hour to avoid spamming the API
   */
  private async checkRugCheck(mint: string): Promise<RugCheckResponse | null> {
    // Check cache first
    const cached = apiCache.getRugCheck(mint);
    if (cached) {
      logger.debug(`RugCheck cache HIT for ${mint.slice(0, 8)}`);
      return cached;
    }
    
    // Retry logic: try up to 2 times with increased timeout
    const maxRetries = 2;
    const timeout = 10000; // 10 seconds
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(
          `https://api.rugcheck.xyz/v1/tokens/${mint}/report`,
          { signal: AbortSignal.timeout(timeout) }
        );
        
        if (!response.ok) {
          if (attempt === maxRetries) {
            logger.debug(`RugCheck API returned ${response.status} for ${mint.slice(0, 8)} after ${maxRetries} attempts`);
          }
          // Retry on server errors (5xx)
          if (response.status >= 500 && attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
            continue;
          }
          return null;
        }
        
        const data = await response.json() as RugCheckResponse;
        
        // Cache the result for 1 hour
        apiCache.setRugCheck(mint, data);
        logger.debug(`RugCheck cache SET for ${mint.slice(0, 8)}`);
        
        return data;
      } catch (error: any) {
        if (attempt < maxRetries && error.name === 'TimeoutError') {
          logger.debug(`RugCheck timeout for ${mint.slice(0, 8)} (attempt ${attempt}/${maxRetries}), retrying...`);
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
          continue;
        }
        logger.debug(`RugCheck error for ${mint.slice(0, 8)}: ${error.message}`);
        return null;
      }
    }
    
    return null;
  }
  
  private async checkAuthorities(mint: string): Promise<{
    mintAuthority: string | null;
    freezeAuthority: string | null;
  }> {
    try {
      const tokenMint = new PublicKey(mint);
      const mintInfo = await getMint(this.connection, tokenMint, 'confirmed', TOKEN_PROGRAM_ID);
      
      return {
        mintAuthority: mintInfo.mintAuthority?.toString() || null,
        freezeAuthority: mintInfo.freezeAuthority?.toString() || null,
      };
    } catch (error: any) {
      logger.info(`Failed to check authorities for ${mint.slice(0, 8)}: ${error.message}`);
      return {
        mintAuthority: 'unknown',
        freezeAuthority: 'unknown',
      };
    }
  }
  
  /**
   * Comprehensive token security analysis
   *
   * @param mint         Token mint address
   * @param tokenData    Optional scanner data (pairCreatedAt, dexId, liquidity, etc.)
   * @param poolQuote    Optional pre-fetched on-chain pool quote (buy+sell).
   *                     If omitted, the liquidity check is skipped — which is the
   *                     correct behavior for non-pump.fun tokens since pf_tokens
   *                     is pump.fun-only. Missing = unknown = don't penalize.
   */
  async analyzeToken(
    mint: string,
    tokenData?: SolanaToken,
    poolQuote?: PoolQuotePair,
  ): Promise<SolanaSecurityAnalysis> {
    logger.info(`🔍 [Solana Security] Analyzing ${mint.slice(0, 8)}...`);

    // Initialize risk tracking
    let riskScore = 0; // Start from 0, add points for each risk
    const risks: string[] = [];
    const warnings: string[] = [];

    // ========================================================================
    // 1. Calculate Token Age (from DexScreener pairCreatedAt)
    // ========================================================================
    let tokenAge: number | undefined;
    if (tokenData?.pairCreatedAt) {
      const ageMs = Date.now() - tokenData.pairCreatedAt;
      tokenAge = Math.floor(ageMs / 1000); // Convert to seconds

      // Age-based risk scoring (similar to BSC)
      if (tokenAge < 3600) { // Less than 1 hour
        riskScore += 12;
        warnings.push('Token pair is less than 1 hour old');
      } else if (tokenAge < 86400) { // Less than 1 day
        riskScore += 5;
        warnings.push('Token pair is less than 1 day old');
      }

      logger.debug(`Token age: ${(tokenAge / 3600).toFixed(1)}h (${tokenAge}s)`);
    } else {
      logger.debug(`Token age: Unknown (no pairCreatedAt from DexScreener)`);
    }

    // ========================================================================
    // 2-3. Run external checks in parallel (independent APIs)
    //      — pool quotes are prefetched in analyzeTokens() and passed in
    // ========================================================================
    const [rugcheckData, authorities] = await Promise.all([
      this.checkRugCheck(mint),
      this.checkAuthorities(mint),
    ]);

    // Process RugCheck results
    let rugcheckScore: number | undefined;
    let rugcheckRisks: string[] | undefined;

    if (rugcheckData) {
      rugcheckScore = rugcheckData.score;

      if (rugcheckData.risks && rugcheckData.risks.length > 0) {
        rugcheckRisks = rugcheckData.risks.map(r => r.name);

        for (const risk of rugcheckData.risks) {
          if (risk.level === 'danger') {
            riskScore += 30;
            risks.push(`RugCheck: ${risk.name} - ${risk.description}`);
          } else if (risk.level === 'warn') {
            riskScore += 10;
            warnings.push(`RugCheck: ${risk.name}`);
          }
        }
      }

      logger.debug(`RugCheck score for ${mint.slice(0, 8)}: ${rugcheckScore}/100`);
    } else {
      logger.debug(`No RugCheck data for ${mint.slice(0, 8)} - continuing with manual checks`);
    }

    // Process authority results
    const { mintAuthority, freezeAuthority } = authorities;

    if (freezeAuthority && freezeAuthority !== 'unknown') {
      riskScore += 50; // CRITICAL
      risks.push('Freeze authority exists - creator can freeze your wallet');
    }

    if (mintAuthority && mintAuthority !== 'unknown') {
      riskScore += 30;
      risks.push('Mint authority exists - creator can print unlimited tokens');
    }

    // Holder distribution (removed for Solana - was broken)
    const topHolderPercent = 0;
    const top10HolderPercent = 0;

    // ========================================================================
    // Process on-chain pool quote results (replaces Jupiter HTTP)
    //
    // IMPORTANT: three distinct cases here, handled differently:
    //   1. poolQuote === undefined  → skipped (non-pump.fun or not in pf_tokens).
    //      Don't penalize. DB columns stay null/undefined → ML imputes to 0,
    //      matching the 56% NaN training distribution.
    //   2. canGetQuote=false, error=POOL_RPC_ERROR → transient RPC failure.
    //      Don't penalize — same semantics as the old Jupiter 429/5xx handling.
    //   3. canGetQuote=false, other error → real signal (stale pool / no reserves).
    //      +30 risk, same as old Jupiter 'no route' behavior.
    //
    // See docs/JUPITER_QUOTE_ML_IMPACT_ANALYSIS.md for the full rationale.
    // ========================================================================
    const buyQuote = poolQuote?.buy;
    const sellQuote = poolQuote?.sell;

    const isTransientPoolError = (err?: string): boolean => err === POOL_RPC_ERROR;

    // Check BUY liquidity (entry)
    const buyTransient = !!buyQuote && !buyQuote.canGetQuote && isTransientPoolError(buyQuote.error);
    if (!buyQuote) {
      // Skipped — non-pump.fun token or not yet indexed. Not a safety signal.
      logger.debug(`Pool quote skipped for ${mint.slice(0, 8)} (non-pump.fun or unindexed)`);
    } else if (!buyQuote.canGetQuote) {
      if (buyTransient) {
        // RPC failure — don't penalize, just warn
        warnings.push(`Pool quote unavailable (transient RPC error) - safety unknown`);
      } else {
        riskScore += 30;
        risks.push('Cannot get pool buy quote - no entry liquidity or stale pool');
        warnings.push(buyQuote.error || 'Token may not be tradeable');
      }
    } else if (buyQuote.priceImpact && buyQuote.priceImpact > 0.5) {
      riskScore += 15;
      warnings.push(`Very high buy price impact (${(buyQuote.priceImpact * 100).toFixed(1)}%) on 1 SOL - possible honeypot`);
    } else if (buyQuote.priceImpact && buyQuote.priceImpact > 0.2) {
      riskScore += 5;
      warnings.push(`High buy price impact (${(buyQuote.priceImpact * 100).toFixed(1)}%) - low entry liquidity`);
    }

    // Check SELL liquidity (exit) — buy & sell come from the same reserves so
    // there's no cascade from transient-buy to sell like the old Jupiter flow.
    const sellTransient = !!sellQuote && !sellQuote.canGetQuote && isTransientPoolError(sellQuote.error);
    if (!sellQuote) {
      // Skipped — same reasoning as buy
    } else if (!sellQuote.canGetQuote) {
      if (sellTransient) {
        warnings.push(`Pool sell quote unavailable (transient RPC error) - safety unknown`);
      } else {
        riskScore += 30;
        risks.push('Cannot get pool sell quote - no exit liquidity or stale pool');
        warnings.push(sellQuote.error || 'Token may not be sellable');
      }
    } else if (sellQuote.priceImpact && sellQuote.priceImpact > 0.5) {
      riskScore += 15;
      warnings.push(`Very high sell price impact (${(sellQuote.priceImpact * 100).toFixed(1)}%) on 1 SOL - possible honeypot`);
    } else if (sellQuote.priceImpact && sellQuote.priceImpact > 0.2) {
      riskScore += 5;
      warnings.push(`High sell price impact (${(sellQuote.priceImpact * 100).toFixed(1)}%) - low exit liquidity`);
    }
    
    // ========================================================================
    // 4. Scanner Data Checks (if available)
    // ========================================================================
    if (tokenData) {
      // Bonding curve tokens (pump.fun) are higher risk
      if (tokenData.dexId === 'pumpfun') {
        riskScore += 20;
        risks.push('Token is on pump.fun bonding curve (not graduated to LP yet)');
        warnings.push('Bonding curve tokens often dump after LP migration');
      }
      
      // Low liquidity is risky
      if (tokenData.hasLiquidity && tokenData.liquidityUsd !== undefined) {
        if (tokenData.liquidityUsd < 5000) {
          riskScore += 20;
          risks.push(`Low liquidity: $${tokenData.liquidityUsd.toFixed(0)}`);
        } else if (tokenData.liquidityUsd < 10000) {
          riskScore += 5;
          warnings.push(`Moderate liquidity: $${tokenData.liquidityUsd.toFixed(0)}`);
        }
      } else if (!tokenData.hasLiquidity) {
        riskScore += 25;
        risks.push('No liquidity data available');
      }
      
      // Very few buyers could indicate manipulation
      if (tokenData.buys < 5) {
        riskScore += 10;
        warnings.push(`Low buy count: ${tokenData.buys} buys`);
      }
      
      // Single bot usage (less organic)
      if (tokenData.bots.size === 1) {
        riskScore += 5;
        warnings.push('Token traded through only one bot');
      }
    } else {
      // No token data available
      riskScore += 10;
      warnings.push('Limited scanner data available for analysis');
    }
    
    // ========================================================================
    // 5. Final Risk Assessment
    // ========================================================================
    // Clamp risk score to 0-100
    riskScore = Math.min(100, Math.max(0, riskScore));
    
    // Determine if safe (risk score < 60)
    const isSafe = riskScore < 60;
    
    const buyStatus = !buyQuote ? 'SKIP' : buyQuote.canGetQuote ? 'OK' : 'FAIL';
    const sellStatus = !sellQuote ? 'SKIP' : sellQuote.canGetQuote ? 'OK' : 'FAIL';
    logger.info(
      `✅ Security analysis complete for ${mint.slice(0, 8)}: ` +
      `Risk=${riskScore}/100, Safe=${isSafe}, ` +
      `Freeze=${freezeAuthority ? 'YES' : 'NO'}, ` +
      `Pool BUY=${buyStatus} SELL=${sellStatus}`
    );

    // "Contract Verified" for Solana = Multi-signal verification
    // 1. ✅ Pool can provide a quote (has liquidity) — OR skipped (non-pump.fun, unknown)
    //      — OR transient RPC failure (treat as "has liquidity" since we don't know)
    // 2. ✅ No freeze authority (cannot freeze wallets)
    // 3. ✅ RugCheck passes OR has metadata
    //
    // Transient RPC failures and "skipped" (non-pump.fun) are not safety signals —
    // penalizing them would pollute ML features. See docs/JUPITER_QUOTE_ML_IMPACT_ANALYSIS.md.
    const buyLiquidityOk = !buyQuote || buyQuote.canGetQuote || buyTransient;
    const sellLiquidityOk = !sellQuote || sellQuote.canGetQuote || sellTransient;
    const metadataVerified =
      buyLiquidityOk && sellLiquidityOk &&                           // Has tradeable liquidity (or unknown)
      freezeAuthority === null &&                                    // Cannot freeze
      (rugcheckData?.tokenMeta?.name != null || rugcheckScore === undefined || rugcheckScore < 80); // Passes basic checks
    
    return {
      mint,
      symbol: tokenData?.symbol || 'Unknown',
      isSafe,
      riskScore,
      
      // Authority checks
      mintAuthority,
      freezeAuthority,
      
      // Metadata - Multi-signal verification (Jupiter + authorities + RugCheck)
      metadataVerified,
      hasImage: false, // TODO: check Metaplex metadata
      
      // Holder distribution
      topHolderPercent,
      top10HolderPercent,
      
      // Liquidity info (from scanner data)
      lpLocked: false, // TODO: check on-chain LP locks
      lpLockedPercent: 0,
      lpLockedUntil: undefined,
      tokenAge, // from DexScreener pairCreatedAt (seconds since pair creation)
      
      // RugCheck data
      rugcheckScore,
      rugcheckRisks,
      
      // Pool quote data for ML training — pre-trade liquidity check at 1 SOL.
      // Column names kept as jupiter_* for backward compatibility with the training
      // pipeline and existing data. Values are now sourced from on-chain pf_tokens
      // pool reserves (constant-product AMM math) instead of Jupiter's HTTP quote.
      // For non-pump.fun tokens (poolQuote === undefined) all fields are left
      // undefined → DB writes null → ML imputes to 0 (matches 56% NaN training data).
      jupiterBuyQuoteSuccess: buyQuote?.canGetQuote,
      jupiterBuyQuotePriceImpact: buyQuote?.priceImpact,
      jupiterBuyQuoteOutAmount: buyQuote?.outAmount, // Token amount received for 1 SOL (atomic)
      jupiterBuyQuoteRoutesCount: buyQuote?.routesCount,
      jupiterBuyQuoteError: buyQuote?.error,

      jupiterSellQuoteSuccess: sellQuote?.canGetQuote,
      jupiterSellQuotePriceImpact: sellQuote?.priceImpact,
      jupiterSellQuoteOutAmount: sellQuote?.outAmount, // SOL amount received for selling tokens (lamports)
      jupiterSellQuoteRoutesCount: sellQuote?.routesCount,
      jupiterSellQuoteError: sellQuote?.error,
      
      risks,
      warnings,
    };
  }
  
  /**
   * Batch analyze multiple tokens
   *
   * Pool quotes are prefetched for the whole batch in a single DB query + single
   * `getMultipleAccountsInfo` RPC call, then distributed to each per-token analysis.
   * This replaces the per-token Jupiter HTTP call and eliminates the rate-limit
   * failure mode that caused the April 2026 ai_ready collapse.
   */
  async analyzeTokens(tokenDataMap: Map<string, SolanaToken>): Promise<Map<string, SolanaSecurityAnalysis>> {
    const results = new Map<string, SolanaSecurityAnalysis>();

    logger.info(`🔒 Running comprehensive security analysis for ${tokenDataMap.size} tokens...`);

    // Prefetch on-chain pool quotes for the entire batch up front.
    // pf_tokens is pump.fun-only, so non-pump.fun mints simply won't be in the
    // returned map — analyzeToken treats missing entries as "skipped, unknown"
    // rather than "failed, penalize", matching the old Jupiter behavior for the
    // transient-failure case.
    const mintList = Array.from(tokenDataMap.keys());
    const poolQuotes = await batchPoolQuotes(this.connection, mintList);

    // Process tokens with concurrency limit of 3 to avoid rate-limiting on
    // the remaining per-token HTTP APIs (RugCheck)
    const CONCURRENCY = 3;
    const entries = Array.from(tokenDataMap.entries());

    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);

      const batchResults = await Promise.all(
        batch.map(async ([mint, tokenData]) => {
          try {
            const analysis = await this.analyzeToken(mint, tokenData, poolQuotes.get(mint));
            return { mint, analysis };
          } catch (error: any) {
            logger.error(`Error analyzing ${mint.slice(0, 8)}:`, error.message);
            return {
              mint,
              analysis: {
                mint,
                symbol: tokenData?.symbol || 'Unknown',
                isSafe: false,
                riskScore: 90,
                mintAuthority: 'unknown',
                freezeAuthority: 'unknown',
                metadataVerified: false,
                hasImage: false,
                topHolderPercent: 0,
                top10HolderPercent: 0,
                lpLocked: false,
                lpLockedPercent: 0,
                lpLockedUntil: undefined,
                tokenAge: undefined,
                jupiterBuyQuoteSuccess: false,
                jupiterBuyQuoteError: 'Security analysis error',
                jupiterSellQuoteSuccess: false,
                jupiterSellQuoteError: 'Security analysis error',
                risks: ['Failed to analyze token security - analysis error'],
                warnings: ['Security analysis error - proceed with extreme caution'],
              } as SolanaSecurityAnalysis,
            };
          }
        })
      );

      for (const { mint, analysis } of batchResults) {
        results.set(mint, analysis);
      }
    }

    logger.success(`✅ Security analysis complete: ${results.size} tokens analyzed`);

    return results;
  }
}

