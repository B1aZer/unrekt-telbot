/**
 * Scan Logger
 * 
 * Tracks scanner performance metrics to database
 * Minimal implementation - tracks only scanner-level metrics
 */

import { query } from '../infra/database';
import { logger } from '../utils/logger';
import { getChainConfig } from '../config/chain';
import type { ScanResult } from '../utils/scanner';
import { regimeFeatureCalculator } from './regime-feature-calculator';

export interface ScanMetrics {
  scanId: string;
  scanTimestamp: Date;              // Timestamp used for DB insert, regime features, ML service, and duration calculation
  
  // Scanner metrics
  tokensFound: number;              // Total tokens discovered by bots
  tokensFilteredSecurity: number;   // Filtered by security hard stops
  tokensFilteredActivity: number;   // Filtered by activity thresholds
  tokensFilteredLiquidity: number;  // Filtered by liquidity/volume
  tokensAnalyzed: number;            // Sent to AI
  tokensBuy: number;                 // AI said BUY
  tokensSkip: number;               // AI said SKIP
  
  // Bot breakdown
  botBreakdown: Map<string, number>; // Transaction counts per bot
  botTokensBreakdown: Map<string, number>; // Unique tokens per bot
  
  // Total transactions
  totalTransactions: number;
  
  // Performance
  durationMs: number;
}

export class ScanLogger {
  private currentScan: ScanMetrics | null = null;
  
  /**
   * Start tracking a new scan
   */
  async startScan(scanResult: ScanResult): Promise<string> {
    const scanId = `scan_${Date.now()}`;
    const chainConfig = getChainConfig();
    
    // Convert botBreakdown Map to JSON (transaction counts)
    const botTxBreakdownJson: Record<string, number> = {};
    scanResult.botBreakdown.forEach((count, botName) => {
      botTxBreakdownJson[botName] = count;
    });
    
    // Convert botTokensBreakdown Map to JSON (unique tokens)
    const botTokensBreakdownJson: Record<string, number> = {};
    if (scanResult.botTokensBreakdown) {
      scanResult.botTokensBreakdown.forEach((count, botName) => {
        botTokensBreakdownJson[botName] = count;
      });
    }
    
    // Calculate regime features (macro market conditions)
    // Create scan timestamp ONCE and use it for both DB insert and regime calculation
    // This ensures they're in sync and prevents data leakage.
    //
    // Why this is safe (not error-prone):
    // 1. We create the timestamp once and reuse it (no drift between calculations and DB)
    // 2. RegimeFeatureCalculator filters candles to be strictly BEFORE this timestamp
    // 3. Even if there's a delay between creating the timestamp and using it, the regime
    //    features are still calculated from pre-scan data (no data leakage)
    // 4. The timestamp represents "when we decided to do the scan" which is semantically correct
    const scanTimestamp = new Date();
    
    this.currentScan = {
      scanId,
      scanTimestamp,  // Single source of truth for scan timestamp
      tokensFound: scanResult.topTokens.length,
      tokensFilteredSecurity: 0,
      tokensFilteredActivity: 0,
      tokensFilteredLiquidity: 0,
      tokensAnalyzed: 0,
      tokensBuy: 0,
      tokensSkip: 0,
      botBreakdown: scanResult.botBreakdown,
      botTokensBreakdown: scanResult.botTokensBreakdown || new Map(),
      totalTransactions: scanResult.totalTrades || 0,
      durationMs: 0,
    };
    const regimeFeatures = await regimeFeatureCalculator.calculateRegimeFeatures(scanTimestamp);
    
    // Detect market regime using SOL features and scan data
    let regimeData = null;
    try {
      const { detectRegime } = await import('./regime-detector');
      if (regimeFeatures && 
          regimeFeatures.sol_ret_5m != null &&
          regimeFeatures.sol_ret_15m != null &&
          regimeFeatures.sol_ret_1h != null &&
          regimeFeatures.sol_ret_6h != null &&
          regimeFeatures.sol_volatility_1h != null &&
          regimeFeatures.sol_volatility_24h != null &&
          regimeFeatures.sol_trend_strength != null) {
        regimeData = await detectRegime({
          sol_ret_5m: regimeFeatures.sol_ret_5m,
          sol_ret_15m: regimeFeatures.sol_ret_15m,
          sol_ret_1h: regimeFeatures.sol_ret_1h,
          sol_ret_6h: regimeFeatures.sol_ret_6h,
          sol_volatility_1h: regimeFeatures.sol_volatility_1h,
          sol_volatility_24h: regimeFeatures.sol_volatility_24h,
          sol_trend_strength: regimeFeatures.sol_trend_strength,
          total_transactions: scanResult.totalTrades || 0,
          tokens_found: scanResult.topTokens.length,
          bot_breakdown: botTxBreakdownJson,
        });
      }
    } catch (error) {
      logger.warn('Failed to detect regime (non-critical):', error);
    }
    
    // Insert scan into database immediately (so scanned_tokens FK constraint works)
    // Use the same scanTimestamp we used for regime features to ensure consistency
    try {
      await query(`
        INSERT INTO scans (
          id, timestamp, chain,
          tokens_found, tokens_filtered_security, tokens_filtered_activity, 
          tokens_filtered_liquidity, tokens_analyzed, tokens_buy, tokens_skip,
          bot_tx_breakdown, bot_tokens_breakdown, total_transactions, duration_ms,
          sol_price, sol_ret_5m, sol_ret_15m, sol_ret_1h, sol_ret_6h,
          sol_volatility_1h, sol_volatility_24h, sol_trend_strength,
          regime_trend_score, regime_liquidity_score, regime_risk_score, regime_micro_score,
          market_winrate_1h, market_ev_1h
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
        ON CONFLICT (id) DO NOTHING
      `, [
        scanId,
        scanTimestamp, // Use the same timestamp we used for regime features
        chainConfig.chain,
        scanResult.topTokens.length,
        0, // tokens_filtered_security (will be updated)
        0, // tokens_filtered_activity (will be updated)
        0, // tokens_filtered_liquidity (will be updated)
        0, // tokens_analyzed (will be updated)
        0, // tokens_buy (will be updated)
        0, // tokens_skip (will be updated)
        JSON.stringify(botTxBreakdownJson),
        JSON.stringify(botTokensBreakdownJson),
        scanResult.totalTrades || 0,
        0, // duration_ms (will be updated on complete)
        // Regime features (SOL metrics from Codex only - DEX activity fields removed)
        regimeFeatures?.sol_price ?? null,
        regimeFeatures?.sol_ret_5m ?? null,
        regimeFeatures?.sol_ret_15m ?? null,
        regimeFeatures?.sol_ret_1h ?? null,
        regimeFeatures?.sol_ret_6h ?? null,
        regimeFeatures?.sol_volatility_1h ?? null,
        regimeFeatures?.sol_volatility_24h ?? null,
        regimeFeatures?.sol_trend_strength ?? null,
        // Regime scores only (classifications calculated on-the-fly in analytics)
        regimeData?.scores.trend_score ?? null,
        regimeData?.scores.liquidity_score ?? null,
        regimeData?.scores.risk_score ?? null,
        regimeData?.scores.micro_score ?? null,
        // Raw metrics (not classifications)
        regimeData?.metadata.market_winrate_1h ?? null,
        regimeData?.metadata.market_ev_1h ?? null,
      ]);
      
      logger.debug(`📊 [ScanLogger] Created scan ${scanId} in database (${scanResult.topTokens.length} tokens found)`);
      if (regimeFeatures) {
        logger.debug(`   Regime: SOL=${regimeFeatures.sol_price?.toFixed(2) || 'N/A'}, ret_1h=${regimeFeatures.sol_ret_1h?.toFixed(2) || 'N/A'}%, vol_1h=${regimeFeatures.sol_volatility_1h?.toFixed(2) || 'N/A'}%`);
      }
      if (regimeData) {
        logger.info(`🎯 Market Regime: ${regimeData.classifications.global_regime}`);
      }
    } catch (error) {
      logger.error(`[ScanLogger] Failed to create scan ${scanId} in database:`);
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`   Error details: ${errorMessage}`);
      if (error instanceof Error && error.stack) {
        logger.error(`   Stack: ${error.stack}`);
      }
      // Don't throw - continue with scan tracking in memory
    }
    
    return scanId;
  }
  
  /**
   * Update scan metrics as filtering progresses
   */
  updateFiltering(
    tokensAfterSecurity: number,
    tokensAfterActivity: number,
    tokensAfterLiquidity: number,
    tokensAnalyzed: number
  ): void {
    if (!this.currentScan) return;
    
    this.currentScan.tokensFilteredSecurity = this.currentScan.tokensFound - tokensAfterSecurity;
    this.currentScan.tokensFilteredActivity = tokensAfterSecurity - tokensAfterActivity;
    this.currentScan.tokensFilteredLiquidity = tokensAfterActivity - tokensAfterLiquidity;
    this.currentScan.tokensAnalyzed = tokensAnalyzed;
    
    logger.debug(
      `📊 [ScanLogger] Filtering: ${this.currentScan.tokensFound} found → ` +
      `${tokensAfterSecurity} after security → ${tokensAfterActivity} after activity → ` +
      `${tokensAfterLiquidity} after liquidity → ${tokensAnalyzed} analyzed`
    );
  }
  
  /**
   * Update AI decision counts
   */
  updateDecisions(buyCount: number, skipCount: number): void {
    if (!this.currentScan) return;
    
    this.currentScan.tokensBuy = buyCount;
    this.currentScan.tokensSkip = skipCount;
    
    logger.debug(`📊 [ScanLogger] Decisions: ${buyCount} BUY, ${skipCount} SKIP`);
  }
  
  /**
   * Complete and log the scan to database
   */
  async completeScan(): Promise<void> {
    if (!this.currentScan) {
      logger.warn('[ScanLogger] No active scan to complete');
      return;
    }
    
    const scan = this.currentScan;
    scan.durationMs = Date.now() - scan.scanTimestamp.getTime();
    
    try {
      const chainConfig = getChainConfig();
      
      // Convert botBreakdown Map to JSON (transaction counts)
      const botTxBreakdownJson: Record<string, number> = {};
      scan.botBreakdown.forEach((count, botName) => {
        botTxBreakdownJson[botName] = count;
      });
      
      // Convert botTokensBreakdown Map to JSON (unique tokens)
      const botTokensBreakdownJson: Record<string, number> = {};
      if (scan.botTokensBreakdown) {
        scan.botTokensBreakdown.forEach((count, botName) => {
          botTokensBreakdownJson[botName] = count;
        });
      }
      
      await query(`
        INSERT INTO scans (
          id, timestamp, chain,
          tokens_found, tokens_filtered_security, tokens_filtered_activity, 
          tokens_filtered_liquidity, tokens_analyzed, tokens_buy, tokens_skip,
          bot_tx_breakdown, bot_tokens_breakdown, total_transactions, duration_ms
        ) VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (id) DO UPDATE SET
          tokens_found = EXCLUDED.tokens_found,
          tokens_filtered_security = EXCLUDED.tokens_filtered_security,
          tokens_filtered_activity = EXCLUDED.tokens_filtered_activity,
          tokens_filtered_liquidity = EXCLUDED.tokens_filtered_liquidity,
          tokens_analyzed = EXCLUDED.tokens_analyzed,
          tokens_buy = EXCLUDED.tokens_buy,
          tokens_skip = EXCLUDED.tokens_skip,
          bot_tx_breakdown = EXCLUDED.bot_tx_breakdown,
          bot_tokens_breakdown = EXCLUDED.bot_tokens_breakdown,
          total_transactions = EXCLUDED.total_transactions,
          duration_ms = EXCLUDED.duration_ms
      `, [
        scan.scanId,
        chainConfig.chain,
        scan.tokensFound,
        scan.tokensFilteredSecurity,
        scan.tokensFilteredActivity,
        scan.tokensFilteredLiquidity,
        scan.tokensAnalyzed,
        scan.tokensBuy,
        scan.tokensSkip,
        JSON.stringify(botTxBreakdownJson),
        JSON.stringify(botTokensBreakdownJson),
        scan.totalTransactions,
        scan.durationMs,
      ]);
      
      logger.info(
        `📊 [ScanLogger] Logged scan ${scan.scanId}: ` +
        `${scan.tokensFound} found → ${scan.tokensAnalyzed} analyzed → ` +
        `${scan.tokensBuy} BUY, ${scan.tokensSkip} SKIP (${scan.durationMs}ms)`
      );
      
      // Clear current scan
      this.currentScan = null;
      
    } catch (error) {
      logger.error('[ScanLogger] Failed to log scan:', error);
      // Don't throw - logging failures shouldn't break the scan
    }
  }
  
  /**
   * Get current scan ID (for linking decisions)
   */
  getCurrentScanId(): string | null {
    return this.currentScan?.scanId || null;
  }
  
  /**
   * Get the scan timestamp (Date object used for DB insert and regime features)
   */
  getCurrentScanTimestamp(): Date | null {
    return this.currentScan?.scanTimestamp || null;
  }
}

// Singleton instance
export const scanLogger = new ScanLogger();

