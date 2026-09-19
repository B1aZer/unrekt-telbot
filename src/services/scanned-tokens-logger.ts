/**
 * Scanned Tokens Logger
 * 
 * Logs comprehensive token data to scanned_tokens table
 * This includes ALL tokens from each scan, not just AI decisions
 * Used for missed opportunity tracking
 */

import { query } from '../infra/database';
import { logger } from '../utils/logger';
import type { Candle } from './data-gatherers/price-action-analyzer';
import { priceActionCalculator, type PriceActionFeatures } from './price-action-features';

export interface ScannedTokenData {
  scanId: string;
  tokenAddress: string;
  chain: string;
  symbol?: string;
  name?: string;
  discoveredByBots?: string[];
  
  // Market data (from Codex)
  priceUsd?: number;
  marketCap?: number;
  liquidity?: number;
  volume24h?: number;
  priceChange24h?: number;
  holders?: number;
  
  // Extended Codex data (volumes, transactions, wallet metrics)
  volume5mCodex?: number;
  volume1hCodex?: number;
  volume4hCodex?: number;
  volume24hCodex?: number;
  buyCount5mCodex?: number;
  sellCount5mCodex?: number;
  buyCount1hCodex?: number;
  sellCount1hCodex?: number;
  buyCount4hCodex?: number;
  sellCount4hCodex?: number;
  buyCount24hCodex?: number;
  sellCount24hCodex?: number;
  uniqueBuys5mCodex?: number;
  uniqueSells5mCodex?: number;
  uniqueBuys1hCodex?: number;
  uniqueSells1hCodex?: number;
  uniqueBuys24hCodex?: number;
  uniqueSells24hCodex?: number;
  uniqueTransactions5mCodex?: number;
  uniqueTransactions1hCodex?: number;
  uniqueTransactions24hCodex?: number;
  swapPct1dOldWallet?: number;
  swapPct7dOldWallet?: number;
  walletAgeAvg?: number;
  walletAgeStd?: number;
  isScamCodex?: boolean;
  
  // Wallet Type Metrics (risk signals)
  bundlerCount?: number;
  sniperCount?: number;
  insiderCount?: number;
  bundlerHeldPercentage?: number;
  sniperHeldPercentage?: number;
  insiderHeldPercentage?: number;
  devHeldPercentage?: number;
  
  // Trading activity (from scanner - bot trades)
  scannerData?: any;
  botBuys?: number;
  botSells?: number;
  netBuys?: number;
  uniqueUsers?: number;
  totalActivity?: number;
  botActivityJson?: Record<string, { buys: number; sells: number }>;
  totalBotsCount?: number;
  multiBotSignal?: boolean;
  
  // Trading activity (from DexScreener - all DEX trades)
  volume5m?: number;
  volume1h?: number;
  volume6h?: number;
  txnBuys5m?: number;
  txnSells5m?: number;
  txnBuys1h?: number;
  txnSells1h?: number;
  txnBuys6h?: number;
  txnSells6h?: number;
  txnBuys24h?: number;
  txnSells24h?: number;
  buySellRatio?: number;
  
  // Extended DexScreener data
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange6h?: number;
  priceChange24hDex?: number; // DexScreener 24h (separate from Codex)
  pairAddress?: string;
  dexId?: string;
  quoteToken?: string;
  pairCreatedAt?: number; // timestamp in milliseconds
  liquidityBase?: number;
  liquidityQuote?: number;
  fdv?: number; // Fully Diluted Valuation
  
  // Security analysis
  isSafe?: boolean;
  riskScore?: number;
  honeypotDetected?: boolean;
  ownershipRisk?: boolean;
  blacklistDetected?: boolean;
  hiddenFunctions?: boolean;
  buyTax?: number;
  sellTax?: number;
  canTakeBackOwnership?: boolean;
  ownerPercent?: number;
  top10HolderPercent?: number;
  ageHours?: number;
  
  // Filter tracking
  filterStage?: string;
  filterReason?: string;
  
  // Jupiter quote data (pre-trade liquidity check - for ML training)
  // BUY quote (entry liquidity)
  jupiterBuyQuoteSuccess?: boolean;
  jupiterBuyQuotePriceImpact?: number;
  jupiterBuyQuoteOutAmount?: string;
  jupiterBuyQuoteRoutesCount?: number;
  jupiterBuyQuoteError?: string;
  // SELL quote (exit liquidity)
  jupiterSellQuoteSuccess?: boolean;
  jupiterSellQuotePriceImpact?: number;
  jupiterSellQuoteOutAmount?: string;
  jupiterSellQuoteRoutesCount?: number;
  jupiterSellQuoteError?: string;
  
  // AI selection score (for prioritization)
  selectionScore?: number;
  
  // Calculated quantitative metrics
  volatility5m?: number;
  volatility1h?: number;
  volatility24h?: number;
  momentumScore?: number;
  momentumDirection?: string;
  volumeRatio5m1h?: number;
  volumeRatio1h24h?: number;
  volumeVelocity?: number;
  volumeAcceleration?: number;
  
  // Smart money metrics
  smartMoneyWalletCount?: number;
  smartMoneyWalletAddresses?: string[]; // Array of wallet addresses that bought
  smartMoneyBuyCount?: number;
  smartMoneyBuyPercentage?: number;
  smartMoneyConvictionScore?: number;
  smartMoneyFirstBuyer?: boolean;
  smartMoneyEntryTimeAvg?: number;
}

export class ScannedTokensLogger {
  /**
   * Log a token to scanned_tokens table
   * Returns the inserted ID
   */
  async logToken(data: ScannedTokenData): Promise<number | null> {
    try {
      const result = await query(`
        INSERT INTO scanned_tokens (
          scan_id, token_address, chain, symbol, name,
          discovered_by_bots,
          price_usd, market_cap, liquidity, volume_24h, price_change_24h, holders,
          scanner_data, bot_buys, bot_sells, net_buys, unique_users, total_activity,
          bot_activity_json, total_bots_count, multi_bot_signal,
          volume_5m, volume_1h, volume_6h, txn_buys_5m, txn_sells_5m, txn_buys_1h, txn_sells_1h, txn_buys_6h, txn_sells_6h, txn_buys_24h, txn_sells_24h, buy_sell_ratio,
          price_change_5m, price_change_1h, price_change_6h, price_change_24h_dex,
          pair_address, dex_id, quote_token, pair_created_at,
          liquidity_base, liquidity_quote, fdv,
          volume_5m_codex, volume_1h_codex, volume_4h_codex, volume_24h_codex,
          buy_count_5m_codex, sell_count_5m_codex, buy_count_1h_codex, sell_count_1h_codex, buy_count_4h_codex, sell_count_4h_codex, buy_count_24h_codex, sell_count_24h_codex,
          unique_buys_5m_codex, unique_sells_5m_codex, unique_buys_1h_codex, unique_sells_1h_codex, unique_buys_24h_codex, unique_sells_24h_codex,
          unique_transactions_5m_codex, unique_transactions_1h_codex, unique_transactions_24h_codex,
          swap_pct_1d_old_wallet, swap_pct_7d_old_wallet, wallet_age_avg, wallet_age_std,
          is_scam_codex,
          bundler_count, sniper_count, insider_count,
          bundler_held_percentage, sniper_held_percentage, insider_held_percentage, dev_held_percentage,
          is_safe, risk_score, honeypot_detected, ownership_risk, blacklist_detected,
          hidden_functions, buy_tax, sell_tax, can_take_back_ownership,
          owner_percent, top10_holder_percent, age_hours,
          filter_stage, filter_reason,
          jupiter_buy_quote_success, jupiter_buy_quote_price_impact, jupiter_buy_quote_out_amount, jupiter_buy_quote_routes_count, jupiter_buy_quote_error,
          jupiter_sell_quote_success, jupiter_sell_quote_price_impact, jupiter_sell_quote_out_amount, jupiter_sell_quote_routes_count, jupiter_sell_quote_error,
          selection_score,
          volatility_5m, volatility_1h, volatility_24h,
          momentum_score, momentum_direction,
          volume_ratio_5m_1h, volume_ratio_1h_24h,
          volume_velocity, volume_acceleration,
          smart_money_wallet_count, smart_money_wallet_addresses, smart_money_buy_count, smart_money_buy_percentage, smart_money_conviction_score
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18,
          $19, $20, $21,
          $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33,
          $34, $35, $36, $37,
          $38, $39, $40, $41,
          $42, $43, $44,
          $45, $46, $47, $48, $49,
          $50, $51, $52, $53,
          $54, $55, $56, $57, $58,
          $59, $60, $61, $62, $63, $64, $65, $66,
          $67, $68, $69, $70, $71, $72,
          $73, $74, $75,
          $76, $77, $78, $79,
          $80,
          $81, $82, $83,
          $84, $85, $86, $87,
          $88, $89, $90, $91, $92,
          $93, $94, $95,
          $96, $97,
          $98, $99, $100, $101, $102,
          $103, $104, $105, $106, $107,
          $108,
          $109, $110, $111,
          $112, $113,
          $114, $115,
          $116
        )
        RETURNING id
      `, [
        data.scanId,
        data.tokenAddress,
        data.chain,
        data.symbol || null,
        data.name || null,
        data.discoveredByBots || null,
        data.priceUsd || null,
        data.marketCap || null,
        data.liquidity || null,
        data.volume24h || null,
        data.priceChange24h !== undefined ? data.priceChange24h : null, // Allow 0 values (0 is a valid price change)
        data.holders || null,
        data.scannerData ? JSON.stringify(data.scannerData) : null,
        data.botBuys || null,
        data.botSells || null,
        data.netBuys || null,
        data.uniqueUsers || null,
        data.totalActivity || null,
        data.botActivityJson ? JSON.stringify(data.botActivityJson) : null,
        data.totalBotsCount || null,
        data.multiBotSignal || false,
        data.volume5m || null,
        data.volume1h || null,
        data.volume6h || null,
        data.txnBuys5m || null,
        data.txnSells5m || null,
        data.txnBuys1h || null,
        data.txnSells1h || null,
        data.txnBuys6h || null,
        data.txnSells6h || null,
        data.txnBuys24h || null,
        data.txnSells24h || null,
        data.buySellRatio || null,
        data.priceChange5m !== undefined ? data.priceChange5m : null,
        data.priceChange1h !== undefined ? data.priceChange1h : null,
        data.priceChange6h !== undefined ? data.priceChange6h : null,
        data.priceChange24hDex !== undefined ? data.priceChange24hDex : null,
        data.pairAddress || null,
        data.dexId || null,
        data.quoteToken || null,
        data.pairCreatedAt || null,
        data.liquidityBase || null,
        data.liquidityQuote || null,
        data.fdv || null,
        data.volume5mCodex || null,
        data.volume1hCodex || null,
        data.volume4hCodex || null,
        data.volume24hCodex || null,
        data.buyCount5mCodex || null,
        data.sellCount5mCodex || null,
        data.buyCount1hCodex || null,
        data.sellCount1hCodex || null,
        data.buyCount4hCodex || null,
        data.sellCount4hCodex || null,
        data.buyCount24hCodex || null,
        data.sellCount24hCodex || null,
        data.uniqueBuys5mCodex || null,
        data.uniqueSells5mCodex || null,
        data.uniqueBuys1hCodex || null,
        data.uniqueSells1hCodex || null,
        data.uniqueBuys24hCodex || null,
        data.uniqueSells24hCodex || null,
        data.uniqueTransactions5mCodex || null,
        data.uniqueTransactions1hCodex || null,
        data.uniqueTransactions24hCodex || null,
        data.swapPct1dOldWallet || null,
        data.swapPct7dOldWallet || null,
        data.walletAgeAvg || null,
        data.walletAgeStd || null,
        data.isScamCodex || false,
        data.bundlerCount ?? null,
        data.sniperCount ?? null,
        data.insiderCount ?? null,
        data.bundlerHeldPercentage ?? null,
        data.sniperHeldPercentage ?? null,
        data.insiderHeldPercentage ?? null,
        data.devHeldPercentage ?? null,
        data.isSafe ?? null,
        data.riskScore ?? null,
        data.honeypotDetected || false,
        data.ownershipRisk || false,
        data.blacklistDetected || false,
        data.hiddenFunctions || false,
        data.buyTax ?? null,
        data.sellTax ?? null,
        data.canTakeBackOwnership || false,
        data.ownerPercent ?? null,
        data.top10HolderPercent ?? null,
        data.ageHours || null,
        data.filterStage || null,
        data.filterReason || null,
        data.jupiterBuyQuoteSuccess ?? null,
        data.jupiterBuyQuotePriceImpact ?? null,
        data.jupiterBuyQuoteOutAmount || null,
        data.jupiterBuyQuoteRoutesCount ?? null,
        data.jupiterBuyQuoteError || null,
        data.jupiterSellQuoteSuccess ?? null,
        data.jupiterSellQuotePriceImpact ?? null,
        data.jupiterSellQuoteOutAmount || null,
        data.jupiterSellQuoteRoutesCount ?? null,
        data.jupiterSellQuoteError || null,
        data.selectionScore || null,
        data.volatility5m || null,
        data.volatility1h || null,
        data.volatility24h || null,
        data.momentumScore || null,
        data.momentumDirection || null,
        data.volumeRatio5m1h || null,
        data.volumeRatio1h24h || null,
        data.volumeVelocity || null,
        data.volumeAcceleration || null,
        data.smartMoneyWalletCount || null,
        data.smartMoneyWalletAddresses && data.smartMoneyWalletAddresses.length > 0 ? data.smartMoneyWalletAddresses : null,
        data.smartMoneyBuyCount || null,
        data.smartMoneyBuyPercentage || null,
        data.smartMoneyConvictionScore || null,
      ]);
      
      const id = result.rows[0]?.id;
      logger.debug(`✅ Logged scanned token: ${data.symbol || data.tokenAddress} (ID: ${id}, scan: ${data.scanId})`);
      
      // Debug: Log smart money data if present
      if (data.smartMoneyWalletCount && data.smartMoneyWalletCount > 0) {
        logger.debug(`   💰 Smart money saved: ${data.smartMoneyWalletCount} wallets, ${data.smartMoneyBuyCount || 0} buys, ${data.smartMoneyBuyPercentage?.toFixed(2) || 'null'}%, conviction=${data.smartMoneyConvictionScore || 0}`);
      }
      
      return id || null;
    } catch (error) {
      logger.error(`❌ Failed to log scanned token ${data.tokenAddress}:`);
      logger.error(`   Scan ID: ${data.scanId}`);
      logger.error(`   Chain: ${data.chain}`);
      
      // Improved error logging
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`   Error details: ${errorMessage}`);
      if (error instanceof Error && error.stack) {
        logger.error(`   Stack: ${error.stack}`);
      }
      
      // Don't throw - this is non-critical
      return null;
    }
  }

  /**
   * Log multiple tokens in batch
   * Returns array of { tokenAddress, scannedTokenId } for tracking
   */
  async logTokensBatch(tokens: ScannedTokenData[]): Promise<Array<{ tokenAddress: string; scannedTokenId: number; symbol: string; chain: string; scanPrice: number; filterStage: string | null }>> {
    const results: Array<{ tokenAddress: string; scannedTokenId: number; symbol: string; chain: string; scanPrice: number; filterStage: string | null }> = [];
    
    for (const token of tokens) {
      const id = await this.logToken(token);
      if (id && token.priceUsd) {
        results.push({
          tokenAddress: token.tokenAddress,
          scannedTokenId: id,
          symbol: token.symbol || token.tokenAddress,
          chain: token.chain,
          scanPrice: token.priceUsd,
          filterStage: token.filterStage || null,
        });
      }
    }
    
    return results;
  }

  /**
   * Log candlestick (OHLCV) data to candle_data table
   * @param scanId - Scan ID for linking candles to scan context
   * @param tokenAddress - Token address
   * @param chain - Chain identifier
   * @param candles1m - Array of 1-minute candles
   * @param candles5m - Array of 5-minute candles
   */
  async logCandles(
    scanId: string,
    tokenAddress: string,
    chain: string,
    candles1m: Candle[],
    candles5m: Candle[]
  ): Promise<void> {
    try {
      // Combine all candles with their timeframes
      const allCandles: Array<Candle & { timeframe: '1m' | '5m' }> = [
        ...candles1m.map(c => ({ ...c, timeframe: '1m' as const })),
        ...candles5m.map(c => ({ ...c, timeframe: '5m' as const })),
      ];

      if (allCandles.length === 0) {
        logger.debug(`[CandleLogger] No candles to save for ${tokenAddress.substring(0, 8)}...`);
        return;
      }

      // Build batch insert query
      // Using parameterized query with VALUES clause for batch insert
      const values: string[] = [];
      const params: any[] = [];
      
      allCandles.forEach((candle, idx) => {
        const base = idx * 10;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`);
        params.push(
          tokenAddress,
          chain,
          scanId,
          candle.timeframe,
          candle.timestamp,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume
        );
      });

      const queryText = `
        INSERT INTO candle_data (
          token_address, chain, scan_id, timeframe, timestamp,
          open_price, high_price, low_price, close_price, volume
        ) VALUES ${values.join(', ')}
        ON CONFLICT (token_address, chain, timeframe, timestamp) DO NOTHING
      `;

      await query(queryText, params);
      
      logger.debug(
        `✅ Logged ${allCandles.length} candles for ${tokenAddress.substring(0, 8)}... ` +
        `(${candles1m.length} × 1m, ${candles5m.length} × 5m)`
      );
    } catch (error) {
      logger.error(`❌ Failed to log candles for ${tokenAddress}:`, error);
      logger.error(`   Scan ID: ${scanId}`);
      logger.error(`   Chain: ${chain}`);
      logger.error(`   Error details:`, error);
      // Don't throw - this is non-critical, candles are supplementary data
    }
  }

  /**
   * Save pre-calculated price action features (efficient - no DB fetch)
   * Use this when you already have candles from API (e.g., during scan)
   * @param scannedTokenId - The ID from scanned_tokens table
   * @param features - Pre-calculated price action features
   */
  async savePriceActionFeatures(
    scannedTokenId: number,
    features: PriceActionFeatures
  ): Promise<void> {
    try {
      // Update scanned_tokens with the calculated features
      await query(`
        UPDATE scanned_tokens
        SET
          m1_ret_5m = $1, m1_ret_10m = $2, m1_ret_15m = $3,
          m1_vol_5m = $4, m1_vol_10m = $5,
          m1_rvol_5m = $6, m1_rvol_10m = $7,
          m1_vol_slope_5m = $8, m1_ret_slope_5m = $9,
          m1_body_avg_5m = $10, m1_range_avg_5m = $11,
          m1_upper_wick_ratio_5m = $12, m1_lower_wick_ratio_5m = $13,
          m1_last_bar_green = $14, m1_last_bar_long_upper_wick = $15, m1_last_bar_doji = $16,
          m1_consecutive_green = $17, m1_consecutive_red = $18,
          m5_ret_60m = $19, m5_ret_last_3 = $20,
          m5_vol_60m = $21, m5_rvol_15m = $22,
          m5_price_slope_60m = $23, m5_volume_slope_60m = $24,
          m5_consecutive_green = $25, m5_pullback_depth = $26,
          m5_range_avg_30m = $27,
          pa_momo_alignment = $28, pa_vol_ratio_m1_m5 = $29, pa_rvol_ratio_m1_m5 = $30,
          volume_squeeze = $31, pullback_strength = $32,
          m1_candles_available = $33, m5_candles_available = $34
        WHERE id = $35
      `, [
        features.m1_ret_5m, features.m1_ret_10m, features.m1_ret_15m,
        features.m1_vol_5m, features.m1_vol_10m,
        features.m1_rvol_5m, features.m1_rvol_10m,
        features.m1_vol_slope_5m, features.m1_ret_slope_5m,
        features.m1_body_avg_5m, features.m1_range_avg_5m,
        features.m1_upper_wick_ratio_5m, features.m1_lower_wick_ratio_5m,
        features.m1_last_bar_green, features.m1_last_bar_long_upper_wick, features.m1_last_bar_doji,
        features.m1_consecutive_green, features.m1_consecutive_red,
        features.m5_ret_60m, features.m5_ret_last_3,
        features.m5_vol_60m, features.m5_rvol_15m,
        features.m5_price_slope_60m, features.m5_volume_slope_60m,
        features.m5_consecutive_green, features.m5_pullback_depth,
        features.m5_range_avg_30m,
        features.pa_momo_alignment, features.pa_vol_ratio_m1_m5, features.pa_rvol_ratio_m1_m5,
        features.volume_squeeze, features.pullback_strength,
        features.m1_candles_available, features.m5_candles_available,
        scannedTokenId
      ]);

      logger.debug(
        `✅ Saved PA features for token ${scannedTokenId} ` +
        `(${features.m1_candles_available}x1m, ${features.m5_candles_available}x5m)`
      );
    } catch (error) {
      logger.error(`❌ Failed to save PA features for token ${scannedTokenId}:`, error);
      // Don't throw - this is non-critical
    }
  }

  /**
   * Calculate and update price action features for a scanned token (fetches from DB)
   * IMPORTANT: Only call this for ai_ready tokens (only these have candle data)
   * Use savePriceActionFeatures() instead when you have in-memory candles (more efficient)
   * @param scannedTokenId - The ID from scanned_tokens table
   * @param tokenAddress - Token address
   * @param chain - Chain identifier
   * @param scanTimestamp - Timestamp when token was scanned
   */
  async updatePriceActionFeatures(
    scannedTokenId: number,
    tokenAddress: string,
    chain: string,
    scanTimestamp: Date
  ): Promise<void> {
    try {
      // Safety check: Verify token is ai_ready (only these have candle data)
      const tokenCheck = await query(`
        SELECT filter_stage FROM scanned_tokens WHERE id = $1
      `, [scannedTokenId]);
      
      if (tokenCheck.rows.length === 0) {
        logger.warn(`[PA Features] Token ${scannedTokenId} not found, skipping`);
        return;
      }
      
      const filterStage = tokenCheck.rows[0].filter_stage;
      if (filterStage !== 'ai_ready') {
        logger.debug(
          `[PA Features] Skipping ${tokenAddress.substring(0, 8)}... ` +
          `(filter_stage: ${filterStage}, only ai_ready tokens have candle data)`
        );
        return;
      }
      
      // Calculate features from candle_data
      const features = await priceActionCalculator.calculateFeatures(
        tokenAddress,
        chain,
        scanTimestamp
      );

      // Update scanned_tokens with the calculated features
      await query(`
        UPDATE scanned_tokens
        SET
          m1_ret_5m = $1, m1_ret_10m = $2, m1_ret_15m = $3,
          m1_vol_5m = $4, m1_vol_10m = $5,
          m1_rvol_5m = $6, m1_rvol_10m = $7,
          m1_vol_slope_5m = $8, m1_ret_slope_5m = $9,
          m1_body_avg_5m = $10, m1_range_avg_5m = $11,
          m1_upper_wick_ratio_5m = $12, m1_lower_wick_ratio_5m = $13,
          m1_last_bar_green = $14, m1_last_bar_long_upper_wick = $15, m1_last_bar_doji = $16,
          m1_consecutive_green = $17, m1_consecutive_red = $18,
          m5_ret_60m = $19, m5_ret_last_3 = $20,
          m5_vol_60m = $21, m5_rvol_15m = $22,
          m5_price_slope_60m = $23, m5_volume_slope_60m = $24,
          m5_consecutive_green = $25, m5_pullback_depth = $26,
          m5_range_avg_30m = $27,
          pa_momo_alignment = $28, pa_vol_ratio_m1_m5 = $29, pa_rvol_ratio_m1_m5 = $30,
          volume_squeeze = $31, pullback_strength = $32,
          m1_candles_available = $33, m5_candles_available = $34
        WHERE id = $35
      `, [
        features.m1_ret_5m, features.m1_ret_10m, features.m1_ret_15m,
        features.m1_vol_5m, features.m1_vol_10m,
        features.m1_rvol_5m, features.m1_rvol_10m,
        features.m1_vol_slope_5m, features.m1_ret_slope_5m,
        features.m1_body_avg_5m, features.m1_range_avg_5m,
        features.m1_upper_wick_ratio_5m, features.m1_lower_wick_ratio_5m,
        features.m1_last_bar_green, features.m1_last_bar_long_upper_wick, features.m1_last_bar_doji,
        features.m1_consecutive_green, features.m1_consecutive_red,
        features.m5_ret_60m, features.m5_ret_last_3,
        features.m5_vol_60m, features.m5_rvol_15m,
        features.m5_price_slope_60m, features.m5_volume_slope_60m,
        features.m5_consecutive_green, features.m5_pullback_depth,
        features.m5_range_avg_30m,
        features.pa_momo_alignment, features.pa_vol_ratio_m1_m5, features.pa_rvol_ratio_m1_m5,
        features.volume_squeeze, features.pullback_strength,
        features.m1_candles_available, features.m5_candles_available,
        scannedTokenId
      ]);

      logger.debug(
        `✅ Updated PA features for ${tokenAddress.substring(0, 8)}... ` +
        `(${features.m1_candles_available}x1m, ${features.m5_candles_available}x5m)`
      );
    } catch (error) {
      logger.error(`❌ Failed to update PA features for ${tokenAddress}:`, error);
      // Don't throw - this is non-critical
    }
  }

  /**
   * Save microstructure features (calculated from Codex data and price action features)
   * These features are calculated from existing database data, no API calls needed
   * @param scannedTokenId - The ID from scanned_tokens table
   * @param features - Microstructure features to save
   */
  async saveMicrostructureFeatures(
    scannedTokenId: number,
    features: {
      imbalance_5m?: number | null;
      avg_buy_size_5m_codex?: number | null;
      avg_sell_size_5m_codex?: number | null;
      small_wallet_buy_ratio_5m?: number | null;
      small_trade_buy_ratio_5m?: number | null;
      small_flow_ratio_5m?: number | null;
      price_impact_5m?: number | null;
    }
  ): Promise<void> {
    try {
      await query(`
        UPDATE scanned_tokens
        SET
          imbalance_5m = $1,
          avg_buy_size_5m_codex = $2,
          avg_sell_size_5m_codex = $3,
          small_wallet_buy_ratio_5m = $4,
          small_trade_buy_ratio_5m = $5,
          small_flow_ratio_5m = $6,
          price_impact_5m = $7
        WHERE id = $8
      `, [
        features.imbalance_5m ?? null,
        features.avg_buy_size_5m_codex ?? null,
        features.avg_sell_size_5m_codex ?? null,
        features.small_wallet_buy_ratio_5m ?? null,
        features.small_trade_buy_ratio_5m ?? null,
        features.small_flow_ratio_5m ?? null,
        features.price_impact_5m ?? null,
        scannedTokenId
      ]);

      logger.debug(`✅ Saved microstructure features for token ${scannedTokenId}`);
    } catch (error) {
      logger.error(`❌ Failed to save microstructure features for token ${scannedTokenId}:`, error);
      // Don't throw - this is non-critical
    }
  }
}

// Singleton instance
export const scannedTokensLogger = new ScannedTokensLogger();

