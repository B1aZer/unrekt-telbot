/**
 * Hybrid Shadow Tracker
 * 
 * Runs parallel to the main trading strategy in "shadow mode".
 * Logs all hybrid strategy decisions and simulates trades without executing.
 * This allows comparison between old (v4.3) and new (hybrid) strategies.
 * 
 * Key features:
 * - Uses decision_price (fair entry) instead of scan_price
 * - Uses 4 ML models: entry, crash, upside, regime
 * - 15min pure timed exit (no SL/TP)
 * - Logs everything to hybrid_shadow_decisions and hybrid_shadow_trades tables
 */

import { query } from '../infra/database';
import { MLPredictionClient, TokenFeatures, HybridPrediction } from './ml-prediction-client';
import { logger } from '../utils/logger';
import { scanLogger } from './scan-logger';
import { priceService } from './price-tracking';
import { getChainConfig } from '../config/chain';
import { getSwapService } from './solana/swap-service';
import { Chain } from '../config/chain';
import { rawToUi, isSafeForNumber } from '../utils/bigint-utils';

export interface HybridShadowConfig {
  enabled: boolean;
  exitMinutes: number;           // Default: 15
  initialBalance: number;        // Default: 1000 (for simulation)
  maxTradesPerScan: number;      // Default: 12
}

interface ShadowTrade {
  id: number;
  token_address: string;
  symbol: string;
  entry_price: number;
  real_entry_price?: number | null;
  entry_ata_rent_paid_sol?: number | null;
  entry_timestamp: Date;
  position_pct: number;
  position_usd: number;
  real_position_usd?: number | null; // Real position size in USD (for real trading)
  tx_hash: string | null;
  exit_tx_hash: string | null;
  entry_prob: number;
  crash_pred: number;
  upside_pred: number;
  p_tail: number | null;
  regime_prob: number | null;
  actual_tokens_received?: number | string; // Tokens received when entering position
  actual_sol_spent?: number | string; // SOL spent when entering position
  actual_tokens_sold?: number | string; // Tokens sold when exiting position
  actual_sol_received?: number | string; // SOL received when exiting position
  exit_ata_rent_refunded_sol?: number | string; // ATA rent refunded on exit (SOL)
  real_exit_price?: number | null;
  real_pnl_pct?: number | null;
  real_pnl_usd?: number | null;
  extension_reason?: string | null;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Maximum allowed scan-time Jupiter roundtrip impact (buy+sell, in %)
// Computed as abs(jupiter_buy_quote_price_impact) + abs(jupiter_sell_quote_price_impact)
// DATA-DRIVEN: Shadow trading analysis (Jan-Feb 2026) shows scan_total_impact < 5%
// combined with codex < 10% is the only profitable filter in real trading.
// Set to 0 to disable. Default: 5%.
const MAX_SCAN_TOTAL_IMPACT_PCT: number = (() => {
  const raw = process.env.MAX_SCAN_TOTAL_IMPACT_PCT;
  const parsed = raw != null ? parseFloat(raw) : NaN;
  return !isNaN(parsed) && parsed >= 0 ? parsed : 5;
})();

// Cost calculation constants (calibrated from 808 real trades Mar-May 2026, median implied 3.06%)
const JUPITER_FEE = 0.3; // % per swap
const ENTRY_COSTS = 1.5; // % (1.2% slippage + 0.3% fee)
const EXIT_COSTS = 1.5; // % (1.2% slippage + 0.3% fee)
const LIQUIDITY_IMPACT_A = 350.0;
const LIQUIDITY_IMPACT_B = 0.45;
const MIN_IMPACT = 0.3; // %
const MAX_IMPACT = 15.0; // %

/**
 * Estimate roundtrip transaction cost (%) from liquidity using power-law model.
 * Matches Python simulate_trade_outcomes.py logic.
 */
function estimateRoundtripCostFromLiquidity(liquidity: number | null | undefined): number {
  if (!liquidity || liquidity <= 0 || isNaN(liquidity)) {
    return MAX_IMPACT + 2 * JUPITER_FEE;
  }
  
  const impact = LIQUIDITY_IMPACT_A / Math.pow(liquidity, LIQUIDITY_IMPACT_B);
  const clampedImpact = Math.max(MIN_IMPACT, Math.min(MAX_IMPACT, impact));
  return clampedImpact + 2 * JUPITER_FEE;
}

/**
 * Compute per-token entry and exit costs from best available data.
 * Matches Python simulate_trade_outcomes.py logic.
 * Priority: Jupiter quotes → liquidity estimate → flat defaults
 */
function computeTokenCosts(
  jupiterBuyImpact: number | null | undefined,
  jupiterSellImpact: number | null | undefined,
  liquidity: number | null | undefined
): { entryCosts: number; exitCosts: number; costSource: string } {
  const hasBuy = jupiterBuyImpact != null && !isNaN(jupiterBuyImpact);
  const hasSell = jupiterSellImpact != null && !isNaN(jupiterSellImpact);
  
  if (hasBuy && hasSell) {
    // Best case: actual Jupiter quote data
    // Price impact is in fraction (e.g., 0.025 = 2.5%), convert to % and add fee
    const entryCosts = Math.abs(jupiterBuyImpact) * 100 + JUPITER_FEE;
    const exitCosts = Math.abs(jupiterSellImpact) * 100 + JUPITER_FEE;
    return { entryCosts, exitCosts, costSource: 'jupiter_quotes' };
  }
  
  if (liquidity != null && !isNaN(liquidity) && liquidity > 0) {
    // Fallback: estimate from liquidity
    const roundtrip = estimateRoundtripCostFromLiquidity(liquidity);
    const entryCosts = roundtrip * 0.45;
    const exitCosts = roundtrip * 0.55;
    return { entryCosts, exitCosts, costSource: 'liquidity_estimate' };
  }
  
  // Last resort: flat defaults
  return { entryCosts: ENTRY_COSTS, exitCosts: EXIT_COSTS, costSource: 'flat_default' };
}

export class HybridShadowTracker {
  private config: HybridShadowConfig;
  private mlClient: MLPredictionClient;
  private monitorInterval: NodeJS.Timeout | null = null;
  private simulatedBalance: number;
  private useRealTrading: boolean;
  
  constructor(config?: Partial<HybridShadowConfig>) {
    // Direct configuration (no env vars for now)
    this.config = {
      enabled: true,  // Enabled by default - shadow mode active
      exitMinutes: 15,
      initialBalance: 1000,  // Base initial balance (actual balance = initial + sum of closed trades P&L)
      maxTradesPerScan: 5,
      ...config,
    };
    
    this.mlClient = new MLPredictionClient();
    this.simulatedBalance = this.config.initialBalance;
    this.useRealTrading = process.env.USE_REAL_SOLANA_TRADING === 'true';
    
    if (this.config.enabled) {
      const tradingMode = this.useRealTrading ? 'REAL TRADING' : 'SIMULATION';
      logger.info(`🔮 Hybrid Shadow Tracker enabled (${tradingMode})`);
      logger.info(`   Exit: ${this.config.exitMinutes}min (pure timed, no SL/TP)`);
      
      if (this.useRealTrading) {
        logger.info(`   Using actual SOL wallet balance for real position sizing`);
      } else {
        logger.info(`   Initial Balance: $${this.config.initialBalance} (simulated)`);
      }

      // Always load paper balance from database so it compounds across restarts
      this.loadBalanceFromDatabase().catch(err => {
        logger.warn(`[Hybrid Shadow] Failed to load balance from database, using initial: ${err}`);
      });
      
      logger.info(`   Max trades/scan: ${this.config.maxTradesPerScan}`);
    }
  }
  
  /**
   * Get SOL price from DexScreener
   */
  private async getSOLPrice(): Promise<number | null> {
    try {
      const chainConfig = getChainConfig();
      if (chainConfig.chain !== Chain.SOLANA) return null;
      
      const solUsdcPair = '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm';
      const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${solUsdcPair}`;
      const response = await fetch(url);
      if (!response.ok) return null;
      
      const data = await response.json() as { pair?: { priceUsd?: string | number } };
      const solPrice = parseFloat(String(data.pair?.priceUsd || 0));
      return isNaN(solPrice) || solPrice <= 0 ? null : solPrice;
    } catch {
      return null;
    }
  }
  
  /**
   * Load current balance from database (initial balance + sum of all closed trades P&L)
   */
  private async loadBalanceFromDatabase(): Promise<void> {
    try {
      const result = await query(`
        SELECT 
          COALESCE(SUM(pnl_usd), 0) as total_pnl
        FROM hybrid_shadow_trades
        WHERE status = 'closed'
      `);
      
      const totalPnl = parseFloat(result.rows[0]?.total_pnl || '0');
      this.simulatedBalance = this.config.initialBalance + totalPnl;
      
      logger.info(`🔮 [Hybrid Shadow] Loaded balance from database: $${this.simulatedBalance.toFixed(2)} (initial: $${this.config.initialBalance.toFixed(2)} + P&L: $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)})`);
    } catch (error) {
      logger.warn(`[Hybrid Shadow] Failed to load balance from database: ${error}`);
      // Keep using initial balance
    }
  }
  
  /**
   * Get current balance (real wallet or paper balance)
   */
  async getCurrentBalance(): Promise<{ balanceUsd: number; balanceSol?: number }> {
    if (this.useRealTrading) {
      // Real trading: fetch actual SOL wallet balance
      try {
        const swapService = getSwapService();
        const solBalance = await swapService.getSolBalance();
        const solPrice = await this.getSOLPrice() || 100;
        const balanceUsd = solBalance * solPrice;
        return { balanceUsd, balanceSol: solBalance };
      } catch (error) {
        logger.error(`[Hybrid Shadow] Failed to get real wallet balance: ${error}`);
        return { balanceUsd: 0, balanceSol: 0 };
      }
    } else {
      // Paper trading: use simulated balance
      return { balanceUsd: this.simulatedBalance };
    }
  }
  
  isEnabled(): boolean {
    return this.config.enabled;
  }
  
  /**
   * Process tokens from the current scan in shadow mode.
   * Fetches features directly from scanned_tokens table (simpler integration).
   * Called from monitor.ts after normal analysis completes.
   */
  /**
   * Process a scan by scan ID (called from monitor after scan completes)
   */
  async processScanById(scanId: string): Promise<void> {
    if (!this.config.enabled) return;
    
    try {
      logger.debug(`🔮 [Hybrid Shadow] Processing scan: ${scanId}`);
      
      // Get scan timestamp for regime model (needs actual scan time, not current time)
      const scanResult = await query(`
        SELECT timestamp
        FROM scans
        WHERE id = $1
      `, [scanId]);
      
      if (!scanResult.rows || scanResult.rows.length === 0) {
        logger.warn(`🔮 [Hybrid Shadow] Scan ${scanId} not found in database`);
        return;
      }
      
      const scanTimestamp = scanResult.rows[0]?.timestamp || new Date();
      
      // Fetch tokens that passed TradingAnalyzer's hard stops (trap, price pump, etc.)
      // Only use tokens with filter_stage = 'ai_ready' (same as main trading system)
      // These tokens passed: security, activity, liquidity, volume filters, and hard stops (trap, price pump, etc.)
      // NOTE: SOL features are in scans table, not scanned_tokens
      // IMPORTANT: This query must include ALL 129 features expected by the models
      const result = await query(`
      SELECT 
        st.id as scanned_token_id,
        st.token_address,
        st.symbol,
        st.price_usd as scan_price,
        -- Basic market data
        st.age_hours, st.market_cap, st.liquidity, st.holders, st.fdv,
        st.liquidity_base, st.liquidity_quote,
        -- Volume metrics (DexScreener)
        st.volume_5m, st.volume_1h, st.volume_6h, st.volume_24h,
        -- Price changes
        st.price_change_5m, st.price_change_1h, st.price_change_6h, st.price_change_24h,
        st.price_change_24h_dex,
        -- Transaction counts (DexScreener)
        st.txn_buys_5m, st.txn_sells_5m, st.txn_buys_1h, st.txn_sells_1h,
        st.txn_buys_6h, st.txn_sells_6h, st.txn_buys_24h, st.txn_sells_24h,
        -- Activity metrics
        st.buy_sell_ratio, st.bot_buys, st.net_buys, st.total_activity,
        st.total_bots_count, st.multi_bot_signal, 
        array_length(st.discovered_by_bots, 1) as discovered_by_bots_count,
        -- Security metrics
        st.risk_score, 
        st.is_safe::int as is_safe_int, 
        st.honeypot_detected::int as honeypot_int, 
        st.ownership_risk::int as ownership_risk_int,
        st.blacklist_detected::int as blacklist_int, 
        st.hidden_functions::int as hidden_functions_int, 
        st.buy_tax, st.sell_tax,
        st.owner_percent, st.top10_holder_percent, 
        st.can_take_back_ownership::int as can_take_back_ownership_int,
        st.is_scam_codex::int as is_scam_codex,
        st.pair_created_at,
        -- Codex extended volumes
        st.volume_5m_codex, st.volume_1h_codex, st.volume_4h_codex, st.volume_24h_codex,
        -- Codex transaction counts
        st.buy_count_5m_codex, st.sell_count_5m_codex,
        st.buy_count_1h_codex, st.sell_count_1h_codex,
        st.buy_count_4h_codex, st.sell_count_4h_codex,
        st.buy_count_24h_codex, st.sell_count_24h_codex,
        -- Codex unique transactions
        st.unique_buys_5m_codex, st.unique_sells_5m_codex,
        st.unique_buys_1h_codex, st.unique_sells_1h_codex,
        st.unique_buys_24h_codex, st.unique_sells_24h_codex,
        st.unique_transactions_5m_codex, st.unique_transactions_1h_codex, st.unique_transactions_24h_codex,
        -- Codex wallet metrics
        st.swap_pct_1d_old_wallet, st.swap_pct_7d_old_wallet,
        st.wallet_age_avg, st.wallet_age_std,
        -- Codex wallet type metrics (risk signals)
        st.bundler_count, st.sniper_count, st.insider_count,
        st.bundler_held_percentage, st.sniper_held_percentage,
        st.insider_held_percentage, st.dev_held_percentage,
        -- Calculated quantitative metrics (volatility, momentum, volume ratios)
        st.volatility_5m, st.volatility_1h, st.volatility_24h,
        st.momentum_score, st.momentum_direction,
        st.volume_ratio_5m_1h, st.volume_ratio_1h_24h,
        st.volume_velocity, st.volume_acceleration,
        -- Price Action Features (1m candles - short-term microstructure)
        st.m1_ret_5m, st.m1_ret_10m, st.m1_ret_15m,
        st.m1_vol_5m, st.m1_vol_10m,
        st.m1_rvol_5m, st.m1_rvol_10m,
        st.m1_vol_slope_5m, st.m1_ret_slope_5m,
        st.m1_body_avg_5m, st.m1_range_avg_5m,
        st.m1_upper_wick_ratio_5m, st.m1_lower_wick_ratio_5m,
        st.m1_last_bar_green::int as m1_last_bar_green_int,
        st.m1_last_bar_long_upper_wick::int as m1_last_bar_long_upper_wick_int,
        st.m1_last_bar_doji::int as m1_last_bar_doji_int,
        st.m1_consecutive_green, st.m1_consecutive_red,
        st.m1_candles_available,
        -- Price Action Features (5m candles - context/build-up)
        st.m5_ret_60m, st.m5_ret_last_3, st.m5_vol_60m,
        st.m5_rvol_15m, st.m5_price_slope_60m, st.m5_volume_slope_60m,
        st.m5_consecutive_green, st.m5_pullback_depth, st.m5_range_avg_30m,
        st.m5_candles_available,
        -- Cross-timeframe features
        st.pa_momo_alignment, st.pa_vol_ratio_m1_m5, st.pa_rvol_ratio_m1_m5,
        -- Microstructure features
        st.volume_squeeze, st.pullback_strength,
        -- Order-flow imbalance
        st.imbalance_5m,
        -- Average trade sizes (from Codex)
        st.avg_buy_size_5m_codex, st.avg_sell_size_5m_codex,
        -- Small wallet/trade buy ratios (from Codex)
        st.small_wallet_buy_ratio_5m, st.small_trade_buy_ratio_5m, st.small_flow_ratio_5m,
        -- Price impact coefficient
        st.price_impact_5m,
        -- Jupiter quote data (pre-trade liquidity check - for realistic cost model)
        st.jupiter_buy_quote_success::int as jupiter_buy_quote_success,
        st.jupiter_buy_quote_price_impact,
        st.jupiter_buy_quote_routes_count,
        st.jupiter_sell_quote_success::int as jupiter_sell_quote_success,
        st.jupiter_sell_quote_price_impact,
        st.jupiter_sell_quote_routes_count,
        -- SOL features from scans table
        s.sol_price, s.sol_ret_5m, s.sol_ret_15m, s.sol_ret_1h, s.sol_ret_6h,
        s.sol_volatility_1h, s.sol_volatility_24h, s.sol_trend_strength,
        s.market_winrate_1h
      FROM scanned_tokens st
      JOIN scans s ON s.id = st.scan_id
      WHERE st.scan_id = $1
        -- Only use tokens that passed all hard stops (same as main trading system)
        AND st.filter_stage = 'ai_ready'
      `, [scanId]);
      
      if (result.rows.length === 0) {
        logger.debug('🔮 [Hybrid Shadow] No tokens found for scan');
        return;
      }
      
      logger.info(`🔮 [Hybrid Shadow] Processing ${result.rows.length} tokens from scan ${scanId}...`);
      
      // Store all predictions first (before filtering/ranking)
      const allPredictions: Array<{
        row: any;
        prediction: HybridPrediction;
      }> = [];
      
      const decisions: Array<{
        row: any;
        prediction: HybridPrediction;
      }> = [];
      
      // Get hybrid predictions for all tokens
      for (const row of result.rows) {
      try {
        // Build features object from DB row - ALL 129 features required by hybrid models
        const features: TokenFeatures = {
          // Identifiers
          scanned_token_id: row.scanned_token_id,
          scan_price: parseFloat(row.scan_price) || 0,
          
          // Basic market data
          age_hours: parseFloat(row.age_hours) || 0,
          market_cap: parseFloat(row.market_cap) || 0,
          liquidity: parseFloat(row.liquidity) || 0,
          holders: parseInt(row.holders) || 0,
          fdv: parseFloat(row.fdv) || 0,
          liquidity_base: parseFloat(row.liquidity_base) || 0,
          liquidity_quote: parseFloat(row.liquidity_quote) || 0,
          pair_created_at: row.pair_created_at != null ? (typeof row.pair_created_at === 'number' ? row.pair_created_at : (typeof row.pair_created_at === 'string' ? parseInt(row.pair_created_at, 10) : new Date(row.pair_created_at).getTime())) : null,
          
          // Volume metrics (DexScreener)
          volume_5m: parseFloat(row.volume_5m) || 0,
          volume_1h: parseFloat(row.volume_1h) || 0,
          volume_6h: parseFloat(row.volume_6h) || 0,
          volume_24h: parseFloat(row.volume_24h) || 0,
          
          // Price changes
          price_change_5m: parseFloat(row.price_change_5m) || 0,
          price_change_1h: parseFloat(row.price_change_1h) || 0,
          price_change_6h: parseFloat(row.price_change_6h) || 0,
          price_change_24h: parseFloat(row.price_change_24h) || 0,
          price_change_24h_dex: parseFloat(row.price_change_24h_dex) || null,
          
          // Transaction counts (DexScreener)
          txn_buys_5m: parseInt(row.txn_buys_5m) || 0,
          txn_sells_5m: parseInt(row.txn_sells_5m) || 0,
          txn_buys_1h: parseInt(row.txn_buys_1h) || 0,
          txn_sells_1h: parseInt(row.txn_sells_1h) || 0,
          txn_buys_6h: parseInt(row.txn_buys_6h) || 0,
          txn_sells_6h: parseInt(row.txn_sells_6h) || 0,
          txn_buys_24h: parseInt(row.txn_buys_24h) || 0,
          txn_sells_24h: parseInt(row.txn_sells_24h) || 0,
          
          // Activity metrics
          buy_sell_ratio: parseFloat(row.buy_sell_ratio) || 0,
          bot_buys: parseInt(row.bot_buys) || 0,
          net_buys: parseInt(row.net_buys) || 0,
          total_activity: parseInt(row.total_activity) || 0,
          total_bots_count: parseInt(row.total_bots_count) || 0,
          multi_bot_signal: parseInt(row.multi_bot_signal) || 0,
          discovered_by_bots_count: parseInt(row.discovered_by_bots_count) || 0,
          
          // Security metrics
          risk_score: parseFloat(row.risk_score) || 0,
          is_safe_int: parseInt(row.is_safe_int) || 0,
          honeypot_int: parseInt(row.honeypot_int) || 0,
          ownership_risk_int: parseInt(row.ownership_risk_int) || 0,
          blacklist_int: parseInt(row.blacklist_int) || 0,
          hidden_functions_int: parseInt(row.hidden_functions_int) || 0,
          buy_tax: parseFloat(row.buy_tax) || 0,
          sell_tax: parseFloat(row.sell_tax) || 0,
          owner_percent: parseFloat(row.owner_percent) || 0,
          top10_holder_percent: parseFloat(row.top10_holder_percent) || 0,
          can_take_back_ownership_int: parseInt(row.can_take_back_ownership_int) || 0,
          is_scam_codex: parseInt(row.is_scam_codex) || 0,
          
          // Codex extended volumes
          volume_5m_codex: parseFloat(row.volume_5m_codex) || 0,
          volume_1h_codex: parseFloat(row.volume_1h_codex) || 0,
          volume_4h_codex: parseFloat(row.volume_4h_codex) || 0,
          volume_24h_codex: parseFloat(row.volume_24h_codex) || 0,
          
          // Codex transaction counts
          // CRITICAL: Use != null check to preserve 0 values (counts can be 0)
          buy_count_5m_codex: row.buy_count_5m_codex != null ? parseInt(row.buy_count_5m_codex) : null,
          sell_count_5m_codex: row.sell_count_5m_codex != null ? parseInt(row.sell_count_5m_codex) : null,
          buy_count_1h_codex: row.buy_count_1h_codex != null ? parseInt(row.buy_count_1h_codex) : null,
          sell_count_1h_codex: row.sell_count_1h_codex != null ? parseInt(row.sell_count_1h_codex) : null,
          buy_count_4h_codex: row.buy_count_4h_codex != null ? parseInt(row.buy_count_4h_codex) : null,
          sell_count_4h_codex: row.sell_count_4h_codex != null ? parseInt(row.sell_count_4h_codex) : null,
          buy_count_24h_codex: row.buy_count_24h_codex != null ? parseInt(row.buy_count_24h_codex) : null,
          sell_count_24h_codex: row.sell_count_24h_codex != null ? parseInt(row.sell_count_24h_codex) : null,
          
          // Codex unique transactions
          // CRITICAL: Use != null check to preserve 0 values (counts can be 0)
          unique_buys_5m_codex: row.unique_buys_5m_codex != null ? parseInt(row.unique_buys_5m_codex) : null,
          unique_sells_5m_codex: row.unique_sells_5m_codex != null ? parseInt(row.unique_sells_5m_codex) : null,
          unique_buys_1h_codex: row.unique_buys_1h_codex != null ? parseInt(row.unique_buys_1h_codex) : null,
          unique_sells_1h_codex: row.unique_sells_1h_codex != null ? parseInt(row.unique_sells_1h_codex) : null,
          unique_buys_24h_codex: row.unique_buys_24h_codex != null ? parseInt(row.unique_buys_24h_codex) : null,
          unique_sells_24h_codex: row.unique_sells_24h_codex != null ? parseInt(row.unique_sells_24h_codex) : null,
          unique_transactions_5m_codex: row.unique_transactions_5m_codex != null ? parseInt(row.unique_transactions_5m_codex) : null,
          unique_transactions_1h_codex: row.unique_transactions_1h_codex != null ? parseInt(row.unique_transactions_1h_codex) : null,
          unique_transactions_24h_codex: row.unique_transactions_24h_codex != null ? parseInt(row.unique_transactions_24h_codex) : null,
          
          // Codex wallet metrics
          swap_pct_1d_old_wallet: parseFloat(row.swap_pct_1d_old_wallet) || null,
          swap_pct_7d_old_wallet: parseFloat(row.swap_pct_7d_old_wallet) || null,
          wallet_age_avg: parseFloat(row.wallet_age_avg) || null,
          wallet_age_std: parseFloat(row.wallet_age_std) || null,
          
          // Codex wallet type metrics (risk signals)
          // IMPORTANT: Use ternary with != null to preserve 0 values (model expects these features)
          // CRITICAL: Use `null` not `undefined` - undefined values are DROPPED during JSON serialization!
          // JSON.stringify({a: 1, b: undefined, c: null}) => '{"a":1,"c":null}' (b is missing!)
          bundler_count: row.bundler_count != null ? parseInt(row.bundler_count) : null,
          sniper_count: row.sniper_count != null ? parseInt(row.sniper_count) : null,
          insider_count: row.insider_count != null ? parseInt(row.insider_count) : null,
          bundler_held_percentage: row.bundler_held_percentage != null ? parseFloat(row.bundler_held_percentage) : null,
          sniper_held_percentage: row.sniper_held_percentage != null ? parseFloat(row.sniper_held_percentage) : null,
          insider_held_percentage: row.insider_held_percentage != null ? parseFloat(row.insider_held_percentage) : null,
          dev_held_percentage: row.dev_held_percentage != null ? parseFloat(row.dev_held_percentage) : null,
          
          // Calculated quantitative metrics (volatility)
          volatility_5m: parseFloat(row.volatility_5m) || 0,
          volatility_1h: parseFloat(row.volatility_1h) || 0,
          volatility_24h: parseFloat(row.volatility_24h) || 0,
          
          // Calculated quantitative metrics (momentum)
          momentum_score: parseFloat(row.momentum_score) || 0,
          momentum_direction: parseFloat(row.momentum_direction) || 0,
          
          // Calculated quantitative metrics (volume ratios)
          volume_ratio_5m_1h: parseFloat(row.volume_ratio_5m_1h) || null,
          volume_ratio_1h_24h: parseFloat(row.volume_ratio_1h_24h) || null,
          
          // Calculated quantitative metrics (volume velocity/acceleration)
          volume_velocity: parseFloat(row.volume_velocity) || null,
          volume_acceleration: parseFloat(row.volume_acceleration) || null,
          
          // Price Action Features (1m candles - short-term microstructure)
          m1_ret_5m: parseFloat(row.m1_ret_5m) || null,
          m1_ret_10m: parseFloat(row.m1_ret_10m) || null,
          m1_ret_15m: parseFloat(row.m1_ret_15m) || null,
          m1_vol_5m: parseFloat(row.m1_vol_5m) || null,
          m1_vol_10m: parseFloat(row.m1_vol_10m) || null,
          m1_rvol_5m: parseFloat(row.m1_rvol_5m) || null,
          m1_rvol_10m: parseFloat(row.m1_rvol_10m) || null,
          m1_vol_slope_5m: parseFloat(row.m1_vol_slope_5m) || null,
          m1_ret_slope_5m: parseFloat(row.m1_ret_slope_5m) || null,
          m1_body_avg_5m: parseFloat(row.m1_body_avg_5m) || null,
          m1_range_avg_5m: parseFloat(row.m1_range_avg_5m) || null,
          m1_upper_wick_ratio_5m: parseFloat(row.m1_upper_wick_ratio_5m) || null,
          m1_lower_wick_ratio_5m: parseFloat(row.m1_lower_wick_ratio_5m) || null,
          // IMPORTANT: Use ternary with != null to preserve 0 values (valid for boolean ints and counts)
          // These are boolean-like ints (0/1) where 0 is a valid meaningful value
          m1_last_bar_green_int: row.m1_last_bar_green_int != null ? parseInt(row.m1_last_bar_green_int) : null,
          m1_last_bar_long_upper_wick_int: row.m1_last_bar_long_upper_wick_int != null ? parseInt(row.m1_last_bar_long_upper_wick_int) : null,
          m1_last_bar_doji_int: row.m1_last_bar_doji_int != null ? parseInt(row.m1_last_bar_doji_int) : null,
          m1_consecutive_green: row.m1_consecutive_green != null ? parseInt(row.m1_consecutive_green) : null,
          m1_consecutive_red: row.m1_consecutive_red != null ? parseInt(row.m1_consecutive_red) : null,
          // CRITICAL: Use != null check to preserve 0 values (candles can be 0)
          m1_candles_available: row.m1_candles_available != null ? parseInt(row.m1_candles_available) : null,
          
          // Price Action Features (5m candles - context/build-up)
          m5_ret_60m: parseFloat(row.m5_ret_60m) || null,
          m5_ret_last_3: parseFloat(row.m5_ret_last_3) || null,
          m5_vol_60m: parseFloat(row.m5_vol_60m) || null,
          m5_rvol_15m: parseFloat(row.m5_rvol_15m) || null,
          m5_price_slope_60m: parseFloat(row.m5_price_slope_60m) || null,
          m5_volume_slope_60m: parseFloat(row.m5_volume_slope_60m) || null,
          m5_consecutive_green: row.m5_consecutive_green != null ? parseInt(row.m5_consecutive_green) : null,
          m5_pullback_depth: parseFloat(row.m5_pullback_depth) || null,
          m5_range_avg_30m: parseFloat(row.m5_range_avg_30m) || null,
          // CRITICAL: Use != null check to preserve 0 values (candles can be 0)
          m5_candles_available: row.m5_candles_available != null ? parseInt(row.m5_candles_available) : null,
          
          // Cross-timeframe features
          pa_momo_alignment: parseFloat(row.pa_momo_alignment) || null,
          pa_vol_ratio_m1_m5: parseFloat(row.pa_vol_ratio_m1_m5) || null,
          pa_rvol_ratio_m1_m5: parseFloat(row.pa_rvol_ratio_m1_m5) || null,
          
          // Microstructure features
          volume_squeeze: parseFloat(row.volume_squeeze) || null,
          pullback_strength: parseFloat(row.pullback_strength) || null,
          
          // Order-flow imbalance
          imbalance_5m: parseFloat(row.imbalance_5m) || null,
          
          // Average trade sizes (from Codex)
          avg_buy_size_5m_codex: parseFloat(row.avg_buy_size_5m_codex) || null,
          avg_sell_size_5m_codex: parseFloat(row.avg_sell_size_5m_codex) || null,
          
          // Small wallet/trade buy ratios (from Codex)
          small_wallet_buy_ratio_5m: parseFloat(row.small_wallet_buy_ratio_5m) || null,
          small_trade_buy_ratio_5m: parseFloat(row.small_trade_buy_ratio_5m) || null,
          small_flow_ratio_5m: parseFloat(row.small_flow_ratio_5m) || null,
          
          // Price impact coefficient
          price_impact_5m: parseFloat(row.price_impact_5m) || null,
          
          // Jupiter quote data (for cost calculation)
          jupiter_buy_quote_success: row.jupiter_buy_quote_success != null ? parseInt(row.jupiter_buy_quote_success) : null,
          jupiter_buy_quote_price_impact: row.jupiter_buy_quote_price_impact != null ? parseFloat(row.jupiter_buy_quote_price_impact) : null,
          jupiter_buy_quote_routes_count: row.jupiter_buy_quote_routes_count != null ? parseInt(row.jupiter_buy_quote_routes_count) : null,
          jupiter_sell_quote_success: row.jupiter_sell_quote_success != null ? parseInt(row.jupiter_sell_quote_success) : null,
          jupiter_sell_quote_price_impact: row.jupiter_sell_quote_price_impact != null ? parseFloat(row.jupiter_sell_quote_price_impact) : null,
          jupiter_sell_quote_routes_count: row.jupiter_sell_quote_routes_count != null ? parseInt(row.jupiter_sell_quote_routes_count) : null,
          
          // SOL features (from scans table)
          sol_price: parseFloat(row.sol_price) || null,
          sol_ret_5m: parseFloat(row.sol_ret_5m) || null,
          sol_ret_15m: parseFloat(row.sol_ret_15m) || null,
          sol_ret_1h: parseFloat(row.sol_ret_1h) || null,
          sol_ret_6h: parseFloat(row.sol_ret_6h) || null,
          sol_volatility_1h: parseFloat(row.sol_volatility_1h) || null,
          sol_volatility_24h: parseFloat(row.sol_volatility_24h) || null,
          sol_trend_strength: parseFloat(row.sol_trend_strength) || null,
        };
        
        // Market-level feature (not token-level, so stored separately)
        const market_winrate_1h = row.market_winrate_1h != null ? parseFloat(row.market_winrate_1h) : null;
        
        // Calculate derived Jupiter quote features (matching ML training calculation)
        const buyImpact = features.jupiter_buy_quote_price_impact;
        const sellImpact = features.jupiter_sell_quote_price_impact;
        if (buyImpact != null && sellImpact != null) {
          const absBuy = Math.abs(buyImpact);
          const absSell = Math.abs(sellImpact);
          features.jupiter_roundtrip_impact = absBuy + absSell;
          features.jupiter_impact_asymmetry = absBuy > 0 ? absSell / absBuy : null;
          features.jupiter_roundtrip_cost_pct = (absBuy + absSell) * 100 + 2 * JUPITER_FEE;
          features.jupiter_buy_impact_log = Math.log1p(absBuy * 100);
          features.jupiter_sell_impact_log = Math.log1p(absSell * 100);
          const liq = features.liquidity;
          features.impact_per_unit_liquidity = liq && liq > 0 
            ? (absBuy + absSell) / Math.log1p(liq) 
            : null;
        } else {
          // Set to null if quote data unavailable
          features.jupiter_roundtrip_impact = null;
          features.jupiter_impact_asymmetry = null;
          features.jupiter_roundtrip_cost_pct = null;
          features.jupiter_buy_impact_log = null;
          features.jupiter_sell_impact_log = null;
          features.impact_per_unit_liquidity = null;
        }
        
        // Calculate cost columns (matching ML training calculation)
        const costs = computeTokenCosts(
          features.jupiter_buy_quote_price_impact ?? null,
          features.jupiter_sell_quote_price_impact ?? null,
          features.liquidity ?? null
        );
        features.effective_entry_costs = costs.entryCosts;
        features.effective_exit_costs = costs.exitCosts;
        features.effective_total_costs = costs.entryCosts + costs.exitCosts;
        
        // SOL features for regime model (all sol_* features that regime model expects)
        const solFeatures = {
          sol_price: features.sol_price ?? undefined,
          sol_ret_5m: features.sol_ret_5m ?? undefined,
          sol_ret_15m: features.sol_ret_15m ?? undefined,
          sol_ret_1h: features.sol_ret_1h ?? undefined,
          sol_ret_6h: features.sol_ret_6h ?? undefined,
          sol_volatility_1h: features.sol_volatility_1h ?? undefined,
          sol_volatility_24h: features.sol_volatility_24h ?? undefined,
          sol_trend_strength: features.sol_trend_strength ?? undefined,
          market_winrate_1h: market_winrate_1h ?? undefined,
        };
        
        let prediction: HybridPrediction | null = null;
        try {
          prediction = await this.mlClient.predictHybrid(features, solFeatures, scanTimestamp);
        } catch (error: any) {
          logger.warn(`   ${row.symbol}: Hybrid prediction error: ${error?.message || String(error)}`);
          continue;
        }
        
        if (!prediction) {
          logger.debug(`   ${row.symbol}: No hybrid prediction returned`);
          continue;
        }
        
        // Use complete features from ML service response (includes trap_suspicion_score, market features, time features)
        // This is the EXACT feature set used by the models (for backtest comparison)
        // Store as features_complete to match ML service naming
        (prediction as any).features_complete = prediction.features_complete || null;
        
        // Store thresholds from ML service response (for logging/debugging)
        // ML service now returns effective thresholds (may be relaxed by p_tail adaptive)
        (prediction as any).entry_threshold = prediction.effective_entry_threshold ?? 0.50;
        (prediction as any).crash_threshold = null; // No crash filter when use_crash_for_sizing_only=true
        (prediction as any).rr_threshold = prediction.effective_rr_threshold ?? 1.25;
        (prediction as any).p_tail_used = prediction.p_tail; // Store p_tail for debugging
        (prediction as any).regime_prob_used = prediction.regime_prob;
        (prediction as any).use_crash_for_sizing_only = true; // Pipeline v2 config
        
        // Store all predictions (we'll log them after ranking)
        allPredictions.push({ row, prediction });
        
        // Trust ML service's should_trade decision completely
        // ML service already applies all filters correctly (entry + crash-for-sizing-only + risk-reward)
        // No need to duplicate filter logic in bot - ML service is the source of truth
        if (prediction.should_trade) {
          // NOTE: MAX_SCAN_TOTAL_IMPACT_PCT check is now done inside simulateTrade()
          // to allow paper trading simulation even when real trading is blocked
          decisions.push({ row, prediction });
        }
      } catch (error) {
          logger.warn(`   ${row.symbol}: Hybrid prediction error: ${error}`);
        }
      }
      
      // Sort by entry_prob (best first) and take top N
      decisions.sort((a, b) => b.prediction.entry_prob - a.prediction.entry_prob);
      const tradesToExecute = decisions.slice(0, this.config.maxTradesPerScan);
      
      // Mark which tokens will be traded (for comparison with backtest)
      // Create a map of scanned_token_id -> rank/will_trade for quick lookup
      const rankMap = new Map<number, { rank: number; willTrade: boolean }>();
      for (let i = 0; i < decisions.length; i++) {
        const scannedTokenId = decisions[i].row.scanned_token_id;
        rankMap.set(scannedTokenId, {
          rank: i + 1,
          willTrade: i < tradesToExecute.length
        });
        (decisions[i].prediction as any).rank_in_scan = i + 1;
        (decisions[i].prediction as any).will_trade = i < tradesToExecute.length;
        (decisions[i].prediction as any).max_trades_per_scan = this.config.maxTradesPerScan;
      }
      
      // Now log ALL decisions (with rank/will_trade for those that passed filters)
      for (const { row, prediction } of allPredictions) {
        const rankInfo = rankMap.get(row.scanned_token_id);
        if (rankInfo) {
          (prediction as any).rank_in_scan = rankInfo.rank;
          (prediction as any).will_trade = rankInfo.willTrade;
        }
        (prediction as any).max_trades_per_scan = this.config.maxTradesPerScan;
        
        // Log decision to database (decisionPrice will be fetched later at trade time)
        await this.logDecision(scanId, {
          scannedTokenId: row.scanned_token_id,
          tokenAddress: row.token_address,
          symbol: row.symbol,
          scanPrice: parseFloat(row.scan_price) || 0,
          decisionPrice: 0, // Will be fetched fresh at trade time
        }, prediction);
      }
      
      logger.info(`🔮 [Hybrid Shadow] ${decisions.length} passed filters, taking top ${tradesToExecute.length} (max=${this.config.maxTradesPerScan})`);
      
      // Simulate trades for tokens that passed all filters
      // Fetch fresh prices via PriceTrackingService (Codex under the hood) at decision time (not scan time)
      // This also writes prices into price_history for analytics/backtests.
      const tokenAddresses = tradesToExecute.map(({ row }) => row.token_address);
      const allMints = Array.from(new Set([...tokenAddresses, SOL_MINT]));
      logger.info(
        `🔮 [Hybrid Shadow] Fetching fresh prices from Codex (PriceService) for ${tokenAddresses.length} tokens + SOL...`,
      );
      
      let freshPrices: Map<string, number>;
      try {
        freshPrices = await priceService.getPrices(allMints);
        logger.info(
          `🔮 [Hybrid Shadow] Got prices for ${freshPrices.size}/${allMints.length} mints from Codex (PriceService)`,
        );
      } catch (error) {
        logger.error(`🔮 [Hybrid Shadow] PriceService/Codex error: ${error}`);
        freshPrices = new Map();
      }
      
      for (const { row, prediction } of tradesToExecute) {
        // Get fresh price from Codex (via PriceService) at decision time
        const freshPrice = freshPrices.get(row.token_address);
        const solPriceUsd = freshPrices.get(SOL_MINT) ?? null;
        const scanPrice = parseFloat(row.scan_price) || 0;
        const decisionPrice = (freshPrice && freshPrice > 0) ? freshPrice : scanPrice;
        
        // Log price comparison (important for verifying realistic trading)
        if (freshPrice && freshPrice > 0) {
          const priceDiff = ((decisionPrice - scanPrice) / scanPrice * 100).toFixed(2);
          logger.info(`   📊 ${row.symbol}: scan_price=$${scanPrice.toExponential(4)} → decision_price=$${decisionPrice.toExponential(4)} (${priceDiff}% diff)`);
        } else {
          logger.warn(`   ${row.symbol}: Codex API failed, using scan_price=$${scanPrice.toExponential(4)} as entry (NOT IDEAL for realistic trading!)`);
        }
        
        // Update decision with actual decision price
        await this.updateDecisionPrice(row.scanned_token_id, decisionPrice);
        
        await this.simulateTrade(
          {
            scannedTokenId: row.scanned_token_id,
            tokenAddress: row.token_address,
            symbol: row.symbol,
            decisionPrice: decisionPrice,
            solPriceUsd: solPriceUsd ?? undefined,
          },
          prediction,
        );
      }
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`[Hybrid Shadow] Error in processCurrentScan: ${errorMsg}`);
      if (errorStack) {
        logger.error(`[Hybrid Shadow] Stack: ${errorStack.substring(0, 500)}`);
      }
      throw error; // Re-throw so monitor.ts can catch it
    }
  }
  
  /**
   * Process current scan (legacy method - uses scanLogger.getCurrentScanId())
   * @deprecated Use processScanById() instead
   */
  async processCurrentScan(): Promise<void> {
    if (!this.config.enabled) return;
    
    const scanIdStr = scanLogger.getCurrentScanId();
    if (!scanIdStr) {
      logger.debug('🔮 [Hybrid Shadow] No current scan ID, skipping');
      return;
    }
    
    return this.processScanById(scanIdStr);
  }
  
  /**
   * Update decision price with fresh price from Codex API
   */
  private async updateDecisionPrice(scannedTokenId: number, decisionPrice: number): Promise<void> {
    try {
      // Use subquery because ORDER BY/LIMIT not allowed in UPDATE directly
      await query(`
        UPDATE hybrid_shadow_decisions
        SET decision_price = $1
        WHERE id = (
          SELECT id FROM hybrid_shadow_decisions 
          WHERE scanned_token_id = $2
          ORDER BY decision_timestamp DESC
          LIMIT 1
        )
      `, [decisionPrice, scannedTokenId]);
      logger.debug(`   📊 Updated decision_price=$${decisionPrice.toExponential(4)} for token ${scannedTokenId}`);
    } catch (error) {
      logger.warn(`Failed to update decision price for token ${scannedTokenId}: ${error}`);
    }
  }
  
  /**
   * Log a hybrid decision to the database
   */
  private async logDecision(
    scanId: string,  // TEXT in database (scans.id is TEXT)
    token: {
      scannedTokenId: number;
      tokenAddress: string;
      symbol: string;
      scanPrice: number;
      decisionPrice: number;
    },
    prediction: HybridPrediction
  ): Promise<number> {
    try {
      // Extract thresholds and config from prediction (added in processScanById)
      const entryThreshold = (prediction as any).entry_threshold ?? 0.50;
      const crashThreshold = (prediction as any).crash_threshold ?? null; // null when use_crash_for_sizing_only=true
      const rrThreshold = (prediction as any).rr_threshold ?? 1.25; // Default to neutral regime threshold
      const rankInScan = (prediction as any).rank_in_scan ?? null;
      const willTrade = (prediction as any).will_trade ?? false;
      const maxTradesPerScan = (prediction as any).max_trades_per_scan ?? this.config.maxTradesPerScan;
      
      // Extract complete features from prediction (stored for backtest comparison)
      // This includes all features used by models: original token features + trap_suspicion_score + market features + time features
      const featuresJson = (prediction as any).features_complete ?? null;
      const featuresModelInput = (prediction as any).features_model_input ?? null;

      const result = await query(`
        INSERT INTO hybrid_shadow_decisions (
          scan_id, scanned_token_id, token_address, symbol, chain,
          scan_price, decision_price,
          entry_prob, crash_pred, upside_pred, p_tail, regime_prob,
          risk_reward_ratio, position_pct,
          passed_entry_filter, passed_crash_filter, passed_rr_filter, should_trade,
          skip_reason,
          entry_threshold, crash_threshold, rr_threshold,
          effective_entry_threshold, effective_rr_threshold,
          rank_in_scan, was_traded, max_trades_per_scan, exit_minutes,
          base_position_pct, max_position_pct,
          features_json, features_model_input,
          entry_model_version, crash_model_version, upside_model_version, tail_model_version, regime_model_version
        ) VALUES (
          $1, $2, $3, $4, 'solana',
          $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13,
          $14, $15, $16, $17,
          $18,
          $19, $20, $21,
          $22, $23,
          $24, $25, $26, $27,
          $28, $29,
          $30, $31,
          $32, $33, $34, $35, $36
        )
        RETURNING id
      `, [
        scanId,
        token.scannedTokenId,
        token.tokenAddress,
        token.symbol,
        token.scanPrice,
        token.decisionPrice,
        prediction.entry_prob,
        prediction.crash_pred,
        prediction.upside_pred,
        prediction.p_tail,
        prediction.regime_prob,
        prediction.risk_reward_ratio,
        prediction.position_pct,
        prediction.passed_entry_filter,
        prediction.passed_crash_filter,
        prediction.passed_rr_filter,
        prediction.should_trade,
        prediction.skip_reason,
        0.50, // base entry threshold
        crashThreshold,
        1.25, // base RR threshold
        prediction.effective_entry_threshold ?? 0.50,
        prediction.effective_rr_threshold ?? 1.25,
        rankInScan,
        willTrade,
        maxTradesPerScan,
        this.config.exitMinutes,
        1.0, // base_position_pct (hardcoded for now)
        2.5, // max_position_pct (hardcoded for now)
        featuresJson ? JSON.stringify(featuresJson) : null,
        featuresModelInput ? JSON.stringify(featuresModelInput) : null,
        prediction.entry_model_version,
        prediction.crash_model_version,
        prediction.upside_model_version,
        prediction.tail_model_version ?? null,
        prediction.regime_model_version,
      ]);
      
      return result.rows[0].id;
    } catch (error) {
      logger.error(`Failed to log hybrid decision: ${error}`);
      throw error;
    }
  }
  
  /**
   * Simulate opening a trade (shadow mode)
   */
  private async simulateTrade(
    token: {
      scannedTokenId: number;
      tokenAddress: string;
      symbol: string;
      decisionPrice: number;
      solPriceUsd?: number;
    },
    prediction: HybridPrediction
  ): Promise<void> {
    try {
      // Entry price for SHADOW/ANALYTICS:
      // Always use decisionPrice from Codex/scan for shadow-mode PnL so it matches backtests.
      const entryPrice = token.decisionPrice;
      
      // Calculate position size
      // PAPER position: always based on simulated balance (used for analytics/graphs)
      const paperPositionUsd = this.simulatedBalance * (prediction.position_pct / 100);
      // REAL position: based on actual wallet balance / swap cost (tracked separately)
      let realPositionUsd: number | null = null;
      let txHash: string | null = null;
      let actualSolSpent: number | null = null;
      let entryAtaRentPaidSol = 0;
      let actualTokensReceived: number | null = null;
      let realEntryPrice: number | null = null; // Actual execution price in USD/token for real trades
      // Track why real trade failed (if it did) - used for analytics
      // Price impact rejections are tracked because they're intentional guardrails
      // Other failures (insufficient balance, network errors) are operational issues
      let buyErrorType: string | null = null;
      let buyFailureReason: string | null = null; // Generic failure reason (for non-price-impact failures)
      
      // Resolve decision ID once so we can link quotes and trades
      const decisionResult = await query(`
        SELECT id FROM hybrid_shadow_decisions
        WHERE scanned_token_id = $1
        ORDER BY decision_timestamp DESC
        LIMIT 1
      `, [token.scannedTokenId]);
      
      const decisionId = decisionResult.rows[0]?.id;
      
      if (this.useRealTrading) {
        // REAL TRADING: Use actual wallet balance
        // SCAN-TIME COST GATE: Check scan-time Jupiter roundtrip impact before attempting real trade.
        // DATA-DRIVEN: Shadow trading analysis shows scan_impact < 5% + codex < 10%
        // is the only filter combination that yields positive real PnL.
        // NOTE: Paper trading ALWAYS proceeds regardless of this check (for analytics).
        let blockedByScanImpact = false;
        if (MAX_SCAN_TOTAL_IMPACT_PCT > 0) {
          // Query Jupiter quote data from scanned_tokens table
          const quoteResult = await query(`
            SELECT jupiter_buy_quote_price_impact, jupiter_sell_quote_price_impact
            FROM scanned_tokens
            WHERE id = $1
          `, [token.scannedTokenId]);
          
          if (quoteResult.rows.length > 0) {
            const row = quoteResult.rows[0];
            const buyImpactPct = Math.abs(parseFloat(row.jupiter_buy_quote_price_impact) || 0) * 100;
            const sellImpactPct = Math.abs(parseFloat(row.jupiter_sell_quote_price_impact) || 0) * 100;
            const scanTotalImpact = buyImpactPct + sellImpactPct;
            
            // Block if threshold is enabled and exceeded
            if (MAX_SCAN_TOTAL_IMPACT_PCT > 0 && scanTotalImpact > MAX_SCAN_TOTAL_IMPACT_PCT) {
              logger.info(`   🚫 ${token.symbol}: Scan-time impact too high: ${scanTotalImpact.toFixed(2)}% (max ${MAX_SCAN_TOTAL_IMPACT_PCT}%) — skipping real trade, paper trade will proceed`);
              // Skip real trading but continue with paper trading simulation
              blockedByScanImpact = true;
              buyErrorType = 'scan_price_impact'; // Mark as rejected for analytics
            }
          }
        }
        
        // Only attempt real swap if we haven't been blocked by scan-time impact check
        if (!blockedByScanImpact) {
          const swapService = getSwapService();
          const solBalance = await swapService.getSolBalance();
          // Prefer Codex SOL price passed from processScanById; fall back to DexScreener helper if missing
          const solPrice =
            token.solPriceUsd && token.solPriceUsd > 0
              ? token.solPriceUsd
              : (await this.getSOLPrice()) || 100;
          const walletBalanceUsd = solBalance * solPrice;
          realPositionUsd = walletBalanceUsd * (prediction.position_pct / 100);
          
          logger.debug(`🔮 [Hybrid Shadow] Real trading: Wallet ${solBalance.toFixed(4)} SOL = $${walletBalanceUsd.toFixed(2)}, Position: ${prediction.position_pct.toFixed(2)}% = $${realPositionUsd.toFixed(2)}`);
          
          // Execute real swap
          const solAmount = (realPositionUsd || 0) / solPrice;
          if (solBalance < solAmount) {
            logger.error(`🔮 [Hybrid Shadow] Insufficient SOL: need ${solAmount.toFixed(4)} SOL, have ${solBalance.toFixed(4)} SOL - falling back to paper simulation`);
            // Fall back to paper trading only for this decision (no real tx)
            realPositionUsd = null;
            txHash = null;
            buyFailureReason = 'insufficient_balance'; // Track for analytics, but paper trade proceeds normally
          } else {
            // Ultra API handles slippage via RTSE — no manual slippage config needed.
          // Codex price guard still protects against catastrophic entry slippage.
          // Track error type for price impact rejections
          let capturedErrorType: 'codex_price_impact' | null = null;

          // Pass Codex decision price and SOL price so swap service can enforce
          // an additional max price impact vs Codex (protects against large pumps).
          // Ultra API handles slippage automatically via RTSE (no manual slippageBps needed).
          const swapResult = await swapService.buyToken(
            token.tokenAddress,
            solAmount,
            entryPrice,
            solPrice,
            // Callback for each attempt (for DB logging)
            async (attempt, attemptedSlippage, result) => {
              // Capture errorType from failed swap attempts (for price impact rejections)
              // Keep the FIRST price impact error encountered (don't overwrite if already set)
              if (result.errorType === 'codex_price_impact' && capturedErrorType === null) {
                capturedErrorType = result.errorType;
                logger.debug(`🔮 [Hybrid Shadow] Captured price impact rejection: ${capturedErrorType} (attempt ${attempt + 1})`);
              }
              
              // Persist quote metadata for this attempt (successful or rejected)
              if (decisionId) {
                try {
                  // Get actual token decimals for accurate price calculation
                  // Ensure we always have a valid number (default to 9 if fetch fails)
                  let tokenDecimals = 9; // Default fallback
                  try {
                    const fetched = await swapService.getTokenDecimals(token.tokenAddress);
                    if (fetched !== undefined && fetched !== null && !isNaN(fetched)) {
                      tokenDecimals = fetched;
                    }
                  } catch (err) {
                    logger.warn(`Failed to get token decimals for ${token.symbol}, using default 9: ${err}`);
                  }
                  
                  await query(
                    `
                    INSERT INTO jupiter_quotes (
                      decision_id,
                      scanned_token_id,
                      token_address,
                      symbol,
                      quote_type,
                      attempt_index,
                      slippage_bps,
                      used_for_swap,
                      input_mint,
                      output_mint,
                      in_amount,
                      out_amount,
                      price_impact_pct,
                      input_decimals,
                      output_decimals
                    ) VALUES (
                      $1, $2, $3, $4,
                      'entry', $5, $6, $7,
                      $8, $9, $10, $11, $12,
                      $13, $14
                    )
                  `,
                    [
                      decisionId,
                      token.scannedTokenId,
                      token.tokenAddress,
                      token.symbol,
                      attempt,
                      attemptedSlippage,
                      !!(result && result.success && result.txHash),
                      SOL_MINT, // input mint is always SOL for buys
                      token.tokenAddress, // output mint is token for buys
                      result?.quoteInAmount ? result.quoteInAmount : null,
                      result?.quoteOutAmount ? result.quoteOutAmount : null,
                      result?.quotePriceImpactPct ?? null,
                      9, // SOL always has 9 decimals
                      tokenDecimals, // Actual token decimals from on-chain
                    ],
                  );
                } catch (err) {
                  logger.warn(
                    `🔮 [Hybrid Shadow] Failed to insert jupiter_quote for ${token.symbol} attempt ${attempt}: ${err}`,
                  );
                }
              }
            }
          );
          
          if (swapResult.success && swapResult.txHash) {
            // Real swap succeeded
            txHash = swapResult.txHash;
            logger.info(`🔮 [Hybrid Shadow] BUY succeeded for ${token.symbol}: ${txHash}`);
            // Clear buyErrorType on success since trade executed successfully
            buyErrorType = null;
            
            // Use actual amounts from swap result
            // CRITICAL: actualAmountOut can exceed JS MAX_SAFE_INTEGER for meme tokens
            // Use string-based conversion to preserve precision
            const actualAmountInRaw = BigInt(swapResult.actualAmountIn || '0');
            const actualAmountOutRaw = BigInt(swapResult.actualAmountOut || '0');
            const actualAmountIn = Number(actualAmountInRaw) / 1e9; // Safe: lamports <= 10^18
            entryAtaRentPaidSol = swapResult.entryAtaRentPaid
              ? swapResult.entryAtaRentPaid / 1e9
              : 0;
            const tokenDecimals = await swapService.getTokenDecimals(token.tokenAddress).catch(() => 6);
            
            // Use safe string-based conversion for tokens (may exceed JS safe integer)
            const tokensBoughtStr = rawToUi(actualAmountOutRaw, tokenDecimals);
            const tokensBought = parseFloat(tokensBoughtStr); // For P&L math (acceptable precision loss)
            
            // Log warning if token amount exceeds safe integer
            if (!isSafeForNumber(actualAmountOutRaw)) {
              logger.warn(`🔮 [Hybrid Shadow] ${token.symbol}: Token amount ${actualAmountOutRaw.toString()} exceeds JS MAX_SAFE_INTEGER - using string conversion`);
            }
            
            // Store actual amounts for DB
            actualSolSpent = actualAmountIn;
            actualTokensReceived = tokensBought;
            
            // Realised capital at entry for REAL trading (separate from paperPositionUsd)
            // Exclude ATA rent paid for the output token account (refundable on close)
            const entrySolForPricing = Math.max(actualAmountIn - entryAtaRentPaidSol, 0);
            if (entryAtaRentPaidSol > 0) {
              logger.debug(`   🔮 ${token.symbol}: Excluding entry ATA rent ${entryAtaRentPaidSol.toFixed(8)} SOL from entry price calc`);
            }
            realPositionUsd = entrySolForPricing * solPrice;

            // Store REAL execution entry price (USD per token) separately
            if (tokensBought > 0) {
              realEntryPrice = realPositionUsd / tokensBought;
              
              // CRITICAL: Validate actual slippage vs expected (decision price from Codex)
              const expectedPrice = token.decisionPrice;
              const actualSlippagePct = ((realEntryPrice - expectedPrice) / expectedPrice) * 100;
              
              if (actualSlippagePct > 10) {
                logger.error(`🔮 [Hybrid Shadow] EXCESSIVE SLIPPAGE DETECTED on ${token.symbol}!`);
                logger.error(`   Expected: $${expectedPrice.toFixed(10)} | Actual: $${realEntryPrice.toFixed(10)} | Slippage: ${actualSlippagePct.toFixed(2)}%`);
                logger.error(`   This indicates poor liquidity or bonding curve issues. Consider filtering this token type.`);
              } else if (actualSlippagePct > 5) {
                logger.warn(`🔮 [Hybrid Shadow] High slippage on ${token.symbol}: ${actualSlippagePct.toFixed(2)}% (expected $${expectedPrice.toFixed(10)}, got $${realEntryPrice.toFixed(10)})`);
              } else {
                logger.debug(`🔮 [Hybrid Shadow] ${token.symbol} entry slippage: ${actualSlippagePct.toFixed(2)}% (acceptable)`);
              }
            }
          } else {
            // All retry attempts failed
            // Fall back to paper trading simulation to still track the decision
            // NOTE: Paper trade (paperPositionUsd) is ALWAYS calculated and stored, regardless of real trade outcome
            logger.warn(`🔮 [Hybrid Shadow] Real swap failed for ${token.symbol}: ${swapResult.error} - falling back to paper simulation`);
            realPositionUsd = null;
            txHash = null; // No real transaction
            
            // Keep buyErrorType if it was set (price impact rejection) - these are intentional guardrails
            // For other failures, track as generic failure reason (for analytics)
            buyErrorType = capturedErrorType;
            if (buyErrorType !== 'codex_price_impact' && buyErrorType !== 'scan_price_impact') {
              // Generic swap failure (network error, slippage exceeded max, etc.)
              buyFailureReason = swapResult.error ? `swap_failed_${swapResult.error.substring(0, 50)}` : 'swap_failed_unknown';
              buyErrorType = null; // Clear price impact type since this is a different error
              logger.debug(`🔮 [Hybrid Shadow] Real swap failed (${buyFailureReason}), paper trade will proceed normally`);
            } else {
              logger.debug(`🔮 [Hybrid Shadow] Preserving price impact rejection reason: ${buyErrorType} (paper trade will be simulated)`);
            }
          }
          }
        }
      } else {
        // SIMULATION ONLY: no real position; paperPositionUsd already computed above
      }
      
      // IMPORTANT: Paper trade (paperPositionUsd) ALWAYS proceeds regardless of real trade outcome
      // If real trade is rejected due to price impact, paper trade is still simulated normally
      // This allows tracking of "what would have happened" if the trade had been executed
      let initialStatus = 'open';
      let initialExitReason: string | null = null;
      let initialExitTimestamp: Date | null = null;
      
      // Track entry failure reason for analytics
      // All entry failures (price impact guardrails, insufficient balance, network errors, etc.) are tracked uniformly
      // Paper trade proceeds normally to analyze "what if we executed anyway?"
      let rejectionReason: string | null = null;
      if (buyErrorType === 'codex_price_impact' || buyErrorType === 'scan_price_impact') {
        // Real buy failed due to price impact - but paper trade will still be simulated
        // Trade will be monitored and exited normally after exitMinutes
        if (buyErrorType === 'codex_price_impact') {
          rejectionReason = 'entry_failed_codex_price_impact';
        } else if (buyErrorType === 'scan_price_impact') {
          rejectionReason = 'entry_failed_scan_price_impact';
        }
        logger.debug(`🔮 [Hybrid Shadow] Real trade failed (${rejectionReason}), but paper trade will be simulated normally`);
      } else if (buyFailureReason) {
        // Other failure (insufficient balance, network error, etc.) - track for analytics
        // Paper trade proceeds normally without special marking
        rejectionReason = `entry_failed_${buyFailureReason}`;
        logger.debug(`🔮 [Hybrid Shadow] Real trade failed (${rejectionReason}), paper trade will proceed normally`);
      }
      
      // Insert shadow trade
      // Store rejection reason in extension_reason field for later reference
      const result = await query(`
        INSERT INTO hybrid_shadow_trades (
          decision_id, token_address, symbol, chain,
          entry_price, entry_timestamp,
          position_pct, position_usd,
          entry_prob, crash_pred, upside_pred, p_tail, regime_prob,
          status, tx_hash, actual_sol_spent, actual_tokens_received,
          real_entry_price, real_position_usd, entry_ata_rent_paid_sol,
          exit_reason, exit_timestamp, exit_price, pnl_pct, pnl_usd,
          extension_reason
        ) VALUES (
          $1, $2, $3, 'solana',
          $4, NOW(),
          $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15,
          $16, $17, $18,
          $19, $20, $21, $22, $23,
          $24
        )
        RETURNING id
      `, [
        decisionId,
        token.tokenAddress,
        token.symbol,
        entryPrice,
        prediction.position_pct,
        paperPositionUsd,
        prediction.entry_prob,
        prediction.crash_pred,
        prediction.upside_pred,
        prediction.p_tail,
        prediction.regime_prob,
        initialStatus,
        txHash,
        actualSolSpent,
        actualTokensReceived,
        realEntryPrice,
        realPositionUsd,
        entryAtaRentPaidSol > 0 ? entryAtaRentPaidSol : null,
        null, // exit_reason - will be set when trade actually exits
        null, // exit_timestamp - will be set when trade actually exits
        null, // exit_price - will be set when trade actually exits
        null, // pnl_pct - will be calculated when trade actually exits
        null, // pnl_usd - will be calculated when trade actually exits
        rejectionReason, // Store rejection reason for later reference
      ]);

      const mode = this.useRealTrading ? 'REAL' : 'Shadow';
      const positionLabel = this.useRealTrading && realPositionUsd !== null
        ? `paper=$${paperPositionUsd.toFixed(2)}, real=$${realPositionUsd.toFixed(2)}`
        : `paper=$${paperPositionUsd.toFixed(2)}`;
      logger.info(`   🔮 ${token.symbol}: ${mode} trade opened @ $${entryPrice.toExponential(4)} (${prediction.position_pct.toFixed(2)}% | ${positionLabel})`);
      
    } catch (error) {
      logger.error(`🔮 [Hybrid Shadow] Failed to ${this.useRealTrading ? 'execute' : 'simulate'} trade for ${token.symbol}: ${error}`);
    }
  }
  
  /**
   * Start monitoring open shadow trades for exit
   */
  startMonitoring(): void {
    if (!this.config.enabled) return;
    
    // Check every 30 seconds for trades that need to exit + update peak/trough prices
    this.monitorInterval = setInterval(async () => {
      await this.updateOpenTradePeakTrough();
      await this.checkOpenTrades();
    }, 30 * 1000);
    
    logger.info('🔮 [Hybrid Shadow] Trade monitor started (30s interval)');
  }
  
  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      logger.info('🔮 [Hybrid Shadow] Trade monitor stopped');
    }
  }
  
  /**
   * Update peak/trough prices for all open trades (runs every 30s).
   * Records max and min prices observed during the hold period for later analysis.
   */
  private async updateOpenTradePeakTrough(): Promise<void> {
    try {
      const result = await query(`
        SELECT id, token_address, symbol, entry_price,
               max_price_during_hold, min_price_during_hold
        FROM hybrid_shadow_trades
        WHERE status = 'open'
      `);

      if (result.rows.length === 0) return;

      // Batch fetch all prices in one call
      const mints = Array.from(new Set(result.rows.map((t: any) => t.token_address)));
      let prices: Map<string, number>;
      try {
        prices = await priceService.getPrices(mints);
      } catch (error: any) {
        logger.debug(`[Hybrid Shadow] Peak/trough price fetch failed: ${error.message}`);
        return;
      }

      for (const trade of result.rows) {
        const currentPrice = prices.get(trade.token_address);
        if (!currentPrice || currentPrice <= 0 || isNaN(currentPrice)) continue;

        const entryPrice = parseFloat(trade.entry_price);
        if (!entryPrice || entryPrice <= 0) continue;

        const currentPnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
        const prevMax = trade.max_price_during_hold != null ? parseFloat(trade.max_price_during_hold) : null;
        const prevMin = trade.min_price_during_hold != null ? parseFloat(trade.min_price_during_hold) : null;

        const newMax = prevMax != null ? Math.max(prevMax, currentPrice) : currentPrice;
        const newMin = prevMin != null ? Math.min(prevMin, currentPrice) : currentPrice;
        const newMaxPnl = ((newMax - entryPrice) / entryPrice) * 100;
        const newMinPnl = ((newMin - entryPrice) / entryPrice) * 100;

        // Only write if values actually changed
        if (newMax !== prevMax || newMin !== prevMin) {
          await query(
            `UPDATE hybrid_shadow_trades
             SET max_price_during_hold = $1, min_price_during_hold = $2,
                 max_pnl_pct_during_hold = $3, min_pnl_pct_during_hold = $4
             WHERE id = $5`,
            [newMax, newMin, newMaxPnl, newMinPnl, trade.id],
          );
        }
      }
    } catch (error) {
      logger.error(`[Hybrid Shadow] Error updating peak/trough: ${error}`);
    }
  }

  /**
   * Check open trades and exit those that have reached their time limit
   */
  private async checkOpenTrades(): Promise<void> {
    try {
      // Find trades that are open and have been open for >= exitMinutes
      const result = await query(`
        SELECT t.*, 
               EXTRACT(EPOCH FROM (NOW() - t.entry_timestamp)) / 60 as minutes_held
        FROM hybrid_shadow_trades t
        WHERE t.status = 'open'
        AND t.entry_timestamp <= NOW() - INTERVAL '${this.config.exitMinutes} minutes'
      `);
      
      if (result.rows.length === 0) return;
      
      logger.info(`🔮 [Hybrid Shadow] Found ${result.rows.length} trades ready to exit`);
      
      for (const trade of result.rows) {
        await this.exitTrade(trade);
      }
    } catch (error) {
      logger.error(`[Hybrid Shadow] Error checking open trades: ${error}`);
    }
  }
  
  /**
   * Exit a shadow trade by looking up the actual price at exit time
   */
  private async exitTrade(trade: ShadowTrade): Promise<void> {
    try {
      // exitPrice: SHADOW/ANALYTICS exit price in USD/token (ALWAYS Codex/PriceService-based)
      let exitPrice: number | null = null;
      let exitReason = `timed_${this.config.exitMinutes}m`;
      
      // If trade was originally failed (stored in extension_reason), include it in exit_reason
      if (trade.extension_reason && trade.extension_reason.startsWith('entry_failed_')) {
        exitReason = `${exitReason}_${trade.extension_reason}`;
      }
      let exitTxHash: string | null = null;
      let exitAmountUsd: number | null = null; // Track actual USD received for real trades
      let actualTokensSold: number | null = null;
      let actualSolReceived: number | null = null;
      let exitAtaRentRefundedSol: number | null = null;
      let realExitPrice: number | null = null; // Actual execution exit price in USD/token for real trades
      let realPnlPct: number | null = null;
      let realPnlUsd: number | null = null;

      // 1) PAPER/ANALYTICS EXIT (mode-agnostic): always fetch from Codex via PriceService
      let solExitPriceUsd: number | null = null;
      try {
        const prices = await priceService.getPrices([trade.token_address, SOL_MINT]);
        const tokenExitPrice = prices.get(trade.token_address);
        solExitPriceUsd = prices.get(SOL_MINT) ?? null;

        if (tokenExitPrice && tokenExitPrice > 0 && !isNaN(tokenExitPrice)) {
          exitPrice = tokenExitPrice;
        } else {
          logger.warn(
            `🔮 [Hybrid Shadow] ${trade.symbol}: PriceService returned invalid exit price (falling back to entry price for analytics)`,
          );
        }
      } catch (error: any) {
        logger.error(
          `🔮 [Hybrid Shadow] Failed to fetch Codex exit prices via PriceService for ${trade.symbol}: ${error.message}`,
        );
      }

      // If Codex failed, fall back to entry_price for analytics P&L (0% before fees)
      if (exitPrice === null || exitPrice === undefined || isNaN(exitPrice)) {
        exitPrice = trade.entry_price;
        exitReason = `${exitReason}_no_codex_exit`;
      }

      // 2) REAL EXECUTION EXIT — sell if we hold real tokens, even if real trading was disabled
      //    This ensures open positions are always closed (kill switch only blocks NEW entries)
      const hasRealTokens = parseFloat(trade.actual_tokens_received?.toString() || '0') > 0;
      if (this.useRealTrading || hasRealTokens) {
        // REAL TRADING: Execute actual swap and track REAL execution amounts
        try {
          const swapService = getSwapService();
          
          // Use the tokens THIS trade received (not total wallet balance)
          // This allows multiple concurrent positions in the same token
          const tokensToSell = parseFloat(trade.actual_tokens_received?.toString() || '0');
          
          if (tokensToSell <= 0) {
            // This is a "phantom trade" - buy failed so no tokens exist on-chain.
            // For REAL trading we do NOT fabricate an exit from Codex/history.
            // Distinguish guardrail rejections (price impact / slippage) from generic failures.
            const rejectedByGuard =
              (!trade.tx_hash || trade.tx_hash === null) &&
              (!trade.actual_tokens_received || Number(trade.actual_tokens_received) === 0);

            logger.warn(
              `🔮 [Hybrid Shadow] Trade #${trade.id} ${trade.symbol}: No tokens recorded (buy failed)${
                rejectedByGuard ? ' - likely rejected by entry guard (price impact / slippage)' : ''
              } - marking as closed`,
            );

            // For paper trading, exit price is already set from Codex above
            // Only set exit reason for tracking; don't overwrite Codex-based exitPrice
            if (!exitPrice || exitPrice === trade.entry_price) {
              // Only if Codex also failed, use entry price as fallback
              exitPrice = trade.entry_price;
            }
            // Determine specific exit reason based on error type
            if (rejectedByGuard) {
              // If we have a specific reason from extension_reason, it was already included in exitReason at line 1359
              // If we don't have extension_reason, we can't determine the specific source, so don't set a generic fallback
              // The exit reason will remain as timed_XXm (or timed_XXm_no_codex_exit if Codex failed)
              // This ensures we only use specific, known reasons
            } else {
              exitReason = 'buy_failed_no_tokens';
            }
          } else {
            // Verify we actually have these tokens in wallet (safety check)
            const walletBalance = await swapService.getTokenBalance(trade.token_address);
            if (walletBalance < tokensToSell * 0.99) { // Allow 1% tolerance for rounding
              logger.warn(`🔮 [Hybrid Shadow] ${trade.symbol}: Wallet has ${walletBalance.toFixed(2)} tokens but trade #${trade.id} expects ${tokensToSell.toFixed(2)} - selling wallet balance`);
              // Wallet might have less due to external transfers or rounding
              // Sell what we have, but this indicates a problem
            }
            
            // Execute sell swap for THIS trade's tokens only
            // Ultra API handles slippage via RTSE; partial exit ladder still active for thin liquidity
            logger.info(`🔮 [Hybrid Shadow] ${trade.symbol}: Attempting to sell ${tokensToSell.toExponential(4)} tokens (trade #${trade.id})`);
            const swapResult = await swapService.sellToken(trade.token_address, tokensToSell);
            
            // Log exit quote (whether successful or not)
            if (swapResult.quoteInAmount && swapResult.quoteOutAmount) {
              try {
                // Get actual token decimals for accurate price calculation
                // Ensure we always have a valid number (default to 9 if fetch fails)
                let tokenDecimals = 9; // Default fallback
                try {
                  const fetched = await swapService.getTokenDecimals(trade.token_address);
                  if (fetched !== undefined && fetched !== null && !isNaN(fetched)) {
                    tokenDecimals = fetched;
                  }
                } catch (err) {
                  logger.warn(`Failed to get token decimals for ${trade.symbol}, using default 9: ${err}`);
                }
                
                // Ultra RTSE determines slippage automatically; log 0 as placeholder
                // (actual slippage is in the Ultra order response, not controllable by us)
                const defaultSlippageBps = 0; // RTSE auto-slippage, not manually set
                
                await query(
                  `
                  INSERT INTO jupiter_quotes (
                    trade_id,
                    scanned_token_id,
                    token_address,
                    symbol,
                    quote_type,
                    attempt_index,
                    slippage_bps,
                    used_for_swap,
                    input_mint,
                    output_mint,
                    in_amount,
                    out_amount,
                    price_impact_pct,
                    input_decimals,
                    output_decimals
                  ) VALUES (
                    $1, $2, $3, $4,
                    'exit', 0, $5, $6,
                    $7, $8, $9, $10, $11,
                    $12, $13
                  )
                `,
                  [
                    trade.id,
                    null, // scanned_token_id not needed for exit quotes
                    trade.token_address,
                    trade.symbol,
                    defaultSlippageBps, // RTSE auto-slippage
                    !!(swapResult.success && swapResult.txHash),
                    trade.token_address, // input mint is token for sells
                    SOL_MINT, // output mint is SOL for sells
                    swapResult.quoteInAmount,
                    swapResult.quoteOutAmount,
                    swapResult.quotePriceImpactPct ?? null,
                    tokenDecimals, // Actual token decimals from on-chain
                    9, // SOL always has 9 decimals
                  ],
                );
              } catch (err) {
                logger.warn(
                  `🔮 [Hybrid Shadow] Failed to insert exit quote for ${trade.symbol} trade #${trade.id}: ${err}`,
                );
              }
            }
            
            if (!swapResult.success || !swapResult.txHash) {
              const errorMsg = swapResult.error || 'Unknown error';
              const isPumpFunError = errorMsg.includes('6024');
              
              if (isPumpFunError) {
                logger.error(`🔮 [Hybrid Shadow] Real exit swap failed for ${trade.symbol}: Pump.fun error 6024`);
                logger.error(`   Error details: ${errorMsg}`);
                logger.error(`   Token amount attempted: ${tokensToSell.toExponential(4)} tokens`);
                logger.error(`   This error can mean:`);
                logger.error(`   1. Insufficient real SOL reserves in bonding curve (most common)`);
                logger.error(`   2. Arithmetic overflow due to large token amount or calculation error`);
                logger.error(`   The system will retry with higher slippage (lower min_sol_output).`);
                logger.error(`   If retries fail, tokens may be stuck or amount may be too large.`);
                // Update exit reason to indicate exit failed
                exitReason = isPumpFunError ? 'exit_failed_insufficient_liquidity' : 'exit_failed';
              } else {
                logger.error(`🔮 [Hybrid Shadow] Real exit swap failed for ${trade.symbol}: ${errorMsg}`);
                logger.error(`   Token amount attempted: ${tokensToSell.toExponential(4)} tokens`);
                // Update exit reason to indicate exit failed
                exitReason = 'exit_failed';
              }
              
              // Can't sell = tokens are stuck, treat as complete loss for REAL execution only
              // PAPER exit price remains unchanged (from Codex above)
              realExitPrice = 0; // -100% loss for real execution
              // Calculate real P&L: full loss = negative of SOL spent
              const actualSolSpent = parseFloat(trade.actual_sol_spent?.toString() || '0');
              if (actualSolSpent > 0) {
                realPnlPct = -100; // Full loss
                const solPriceAtExit = solExitPriceUsd && solExitPriceUsd > 0 ? solExitPriceUsd : (await this.getSOLPrice()) || 100;
                realPnlUsd = -actualSolSpent * solPriceAtExit; // Full loss in USD
                logger.error(`🔮 [Hybrid Shadow] ${trade.symbol}: Cannot sell tokens - marking as 100% loss (stuck): -${actualSolSpent.toFixed(6)} SOL = -$${realPnlUsd.toFixed(2)}`);
              } else {
                realPnlPct = -100; // Full loss
                realPnlUsd = null; // Can't calculate without SOL spent
              }
            } else {
              exitTxHash = swapResult.txHash;
              
              // Get actual SOL received from swap (Jupiter handles WSOL unwrapping automatically with wrapAndUnwrapSol: true)
              const actualAmountOut = parseFloat(swapResult.actualAmountOut || '0') / 1e9; // Convert lamports to SOL
              
              // Get ATA rent refund if account was closed (in SOL)
              const ataRentRefundSol = swapResult.ataRentRefund ? swapResult.ataRentRefund / 1e9 : 0;
              exitAtaRentRefundedSol = ataRentRefundSol > 0 ? ataRentRefundSol : null;
              
              // Total SOL received (for record-keeping, not used for PnL calculation)
              const totalSolReceived = actualAmountOut + ataRentRefundSol;
              
              const ataReturned = ataRentRefundSol > 0;
              
              if (ataRentRefundSol > 0) {
                logger.info(`   🔮 ATA rent refund: +${ataRentRefundSol.toFixed(8)} SOL (${swapResult.ataRentRefund} lamports)`);
                if (swapResult.closeAccountTxHash) {
                  logger.info(`   🔮 ATA closed in transaction: ${swapResult.closeAccountTxHash}`);
                }
              }
              
              // Update exit reason to indicate ATA status
              if (ataReturned) {
                exitReason = `${exitReason}_ata_returned`;
              } else {
                // ATA not returned - remaining tokens from overlapping trades or swap residue
                // Check if any other open trades exist for this token before cleanup
                try {
                  const otherOpenTrades = await query(
                    `SELECT COUNT(*) as cnt FROM hybrid_shadow_trades WHERE token_address = $1 AND status = 'open' AND id != $2`,
                    [trade.token_address, trade.id]
                  );
                  const hasOtherOpenTrades = parseInt(otherOpenTrades.rows[0]?.cnt || '0') > 0;

                  if (!hasOtherOpenTrades) {
                    logger.info(`🔮 [ATA Cleanup] ${trade.symbol}: No other open trades - cleaning up residual tokens`);
                    const cleanup = await swapService.cleanupResidualTokens(trade.token_address);
                    if (cleanup.success && cleanup.rentRefunded) {
                      exitAtaRentRefundedSol = cleanup.rentRefunded / 1e9;
                      exitReason = `${exitReason}_ata_returned`;
                      logger.success(`🔮 [ATA Cleanup] ${trade.symbol}: Done, rent refunded: ${exitAtaRentRefundedSol.toFixed(8)} SOL`);
                    } else {
                      exitReason = `${exitReason}_ata_not_returned`;
                      if (cleanup.error) logger.warn(`🔮 [ATA Cleanup] ${trade.symbol}: ${cleanup.error}`);
                    }
                  } else {
                    exitReason = `${exitReason}_ata_not_returned`;
                    logger.debug(`🔮 ${trade.symbol}: ATA not closed - other open trades exist for this token`);
                  }
                } catch (cleanupErr: any) {
                  exitReason = `${exitReason}_ata_not_returned`;
                  logger.warn(`🔮 [ATA Cleanup] ${trade.symbol}: ${cleanupErr.message}`);
                }
              }
              
              const solPrice =
                solExitPriceUsd && solExitPriceUsd > 0 ? solExitPriceUsd : (await this.getSOLPrice()) || 100;
              
              // REAL exit price: Exclude ATA rent refund for unbiased pricing (matches entry logic)
              // Entry excludes ATA rent paid, exit excludes ATA rent refunded - consistent unbiased prices
              const exitSolForPricing = actualAmountOut; // Swap output only (no rent refund)
              if (ataRentRefundSol > 0) {
                logger.debug(`   🔮 ${trade.symbol}: Excluding exit ATA rent refund ${ataRentRefundSol.toFixed(8)} SOL from exit price calc (for unbiased pricing)`);
              }
              exitAmountUsd = exitSolForPricing * solPrice; // USD from swap only (unbiased exit price)
              
              // REAL exit price: USD per token (calculated from swap output only, excluding rent refund)
              if (tokensToSell > 0 && exitAmountUsd > 0) {
                realExitPrice = exitAmountUsd / tokensToSell;
              }
              
              // Store actual amounts for DB (for record-keeping, not used for PnL calculation)
              actualTokensSold = tokensToSell; // Record what THIS trade sold
              actualSolReceived = totalSolReceived; // Total SOL received (includes unwrapped WSOL + ATA rent)
              
              logger.info(`   🔮 [Hybrid Shadow] ${trade.symbol}: REAL exit swap executed for trade #${trade.id}: sold ${tokensToSell.toFixed(2)} tokens → ${exitTxHash}`);
              if (ataRentRefundSol > 0) {
                logger.info(`   🔮 Total SOL received: ${actualAmountOut.toFixed(8)} (swap) + ${ataRentRefundSol.toFixed(8)} (rent) = ${totalSolReceived.toFixed(8)} SOL`);
              }
            }
          }
        } catch (error: any) {
          logger.error(`🔮 [Hybrid Shadow] Real exit execution failed for ${trade.symbol}: ${error.message}`);
          // Update exit reason to indicate exit failed
          exitReason = 'exit_failed_exception';
          // Can't sell = tokens are stuck (for REAL execution only) -> treat as full loss
          // PAPER exit price remains unchanged (from Codex above)
          realExitPrice = 0; // -100% loss for real execution
          // Calculate real P&L: full loss = negative of SOL spent
          const actualSolSpent = parseFloat(trade.actual_sol_spent?.toString() || '0');
          if (actualSolSpent > 0) {
            realPnlPct = -100; // Full loss
            const solPriceAtExit = solExitPriceUsd && solExitPriceUsd > 0 ? solExitPriceUsd : (await this.getSOLPrice()) || 100;
            realPnlUsd = -actualSolSpent * solPriceAtExit; // Full loss in USD
            logger.error(`🔮 [Hybrid Shadow] ${trade.symbol}: Cannot sell tokens (exception) - marking as 100% loss: -${actualSolSpent.toFixed(6)} SOL = -$${realPnlUsd.toFixed(2)}`);
          } else {
            realPnlPct = -100; // Full loss
            realPnlUsd = null; // Can't calculate without SOL spent
          }
        }
      }

      // SHADOW/ANALYTICS P&L (Codex/price_history based, used for backtest comparison)
      // CRITICAL: Paper trading exit price must ALWAYS come from Codex, never from real trading
      // If Codex failed and we don't have a valid exitPrice, use entry_price (0% return before fees)
      if (!exitPrice || exitPrice <= 0 || isNaN(exitPrice)) {
        logger.warn(
          `🔮 [Hybrid Shadow] ${trade.symbol}: Invalid exit price (${exitPrice}), using entry price for paper P&L`,
        );
        exitPrice = trade.entry_price;
        if (!exitReason.includes('no_codex_exit')) {
          exitReason = `${exitReason}_no_codex_exit`;
        }
      }
      
      const rawReturnPct = ((exitPrice - trade.entry_price) / trade.entry_price) * 100;
      const feesPct = 3.0;  // 1.5% entry + 1.5% exit (calibrated from real trades Mar-May 2026)
      const pnlPct = rawReturnPct - feesPct;
      const pnlUsd = trade.position_usd * (pnlPct / 100);

      // REAL EXECUTION P&L (simplified: based on actual prices and position size)
      // Uses real_entry_price and real_exit_price which already account for actual execution
      // ATA rent status is tracked in exit_reason, no need to handle it here
      if ((this.useRealTrading || hasRealTokens) && realExitPrice !== null && realExitPrice > 0) {
        const realEntryPrice = parseFloat(trade.real_entry_price?.toString() || '0');
        const realPositionUsd = parseFloat(trade.real_position_usd?.toString() || '0');
        
        if (realEntryPrice > 0 && realPositionUsd > 0) {
          // Calculate PnL based on price movement
          // Real prices already include all fees and slippage from actual transactions
          realPnlPct = ((realExitPrice - realEntryPrice) / realEntryPrice) * 100;
          realPnlUsd = realPositionUsd * (realPnlPct / 100);
          
          logger.debug(`🔮 [Hybrid Shadow] ${trade.symbol}: REAL PnL (price-based): $${realEntryPrice.toFixed(8)} → $${realExitPrice.toFixed(8)} (${realPnlPct >= 0 ? '+' : ''}${realPnlPct.toFixed(2)}%, $${realPnlUsd >= 0 ? '+' : ''}${realPnlUsd.toFixed(2)})`);
        } else if (realExitPrice > 0 && (realEntryPrice === 0 || realPositionUsd === 0)) {
          logger.warn(`🔮 [Hybrid Shadow] ${trade.symbol}: Cannot calculate real PnL - missing real_entry_price (${realEntryPrice}) or real_position_usd (${realPositionUsd})`);
        }
      }

      // Update simulated balance (always compound so paper positions scale with cumulative P&L)
      this.simulatedBalance += pnlUsd;
      
      // Update trade in database
      await query(`
        UPDATE hybrid_shadow_trades
        SET 
          exit_price = $1,
          exit_timestamp = NOW(),
          exit_minutes = $2,
          exit_reason = $3,
          extended = FALSE,
          pnl_pct = $4,
          pnl_usd = $5,
          exit_tx_hash = $6,
          actual_tokens_sold = $7,
          actual_sol_received = $8,
          exit_ata_rent_refunded_sol = $9,
          real_exit_price = $10,
          real_pnl_pct = $11,
          real_pnl_usd = $12,
          status = 'closed'
        WHERE id = $13
      `, [
        exitPrice,
        this.config.exitMinutes,
        exitReason,
        pnlPct,
        pnlUsd,
        exitTxHash,
        actualTokensSold,
        actualSolReceived,
        exitAtaRentRefundedSol,
        realExitPrice,
        realPnlPct,
        realPnlUsd,
        trade.id,
      ]);
      
      const emoji = pnlPct >= 0 ? '✅' : '🔴';
      const mode = this.useRealTrading ? 'REAL' : 'Shadow';
      
      // Log balance (fetch real wallet balance if real trading)
      let balanceStr = '';
      if (this.useRealTrading) {
        try {
          const swapService = getSwapService();
          const solBalance = await swapService.getSolBalance();
          const solPrice = await this.getSOLPrice() || 100;
          const walletBalanceUsd = solBalance * solPrice;
          balanceStr = `Balance: ${solBalance.toFixed(4)} SOL ($${walletBalanceUsd.toFixed(2)})`;
        } catch (error) {
          balanceStr = 'Balance: N/A';
        }
      } else {
        balanceStr = `Balance: $${this.simulatedBalance.toFixed(2)}`;
      }
      
      logger.info(`   🔮 ${trade.symbol}: ${mode} exit ${emoji} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)}) | ${balanceStr}`);
      
    } catch (error) {
      logger.error(`[Hybrid Shadow] Error exiting trade ${trade.id}: ${error}`);
    }
  }
  
  /**
   * Get shadow trading statistics
   */
  async getStats(): Promise<{
    totalTrades: number;
    activeTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlUsd: number;
    totalReturnPct: number;
    avgReturnPct: number;
    profitFactor: number;
    tradingDays: number;
    tradesPerScan: number;
    totalScansWithTrades: number;
    // Real execution aggregates (only populated when real trading is enabled and exits executed)
    realTotalPnlUsd?: number;
    realTotalReturnPct?: number;
    realAvgReturnPct?: number;
    realProfitFactor?: number;
  }> {
    try {
      const result = await query(`
        SELECT 
          COUNT(*) as total_trades,
          COUNT(*) FILTER (WHERE pnl_pct > 0) as wins,
          COUNT(*) FILTER (WHERE pnl_pct <= 0) as losses,
          COALESCE(SUM(pnl_usd), 0) as total_pnl_usd,
          COALESCE(SUM(pnl_pct), 0) as total_return_pct,
          COALESCE(AVG(pnl_pct), 0) as avg_return_pct,
          COALESCE(SUM(CASE WHEN pnl_usd > 0 THEN pnl_usd ELSE 0 END), 0) as gross_profit,
          COALESCE(ABS(SUM(CASE WHEN pnl_usd < 0 THEN pnl_usd ELSE 0 END)), 0.01) as gross_loss,
          -- Real execution aggregates (only counting trades where real_pnl_usd is not null)
          COALESCE(SUM(real_pnl_usd), 0) as real_total_pnl_usd,
          COALESCE(SUM(real_pnl_pct), 0) as real_total_return_pct,
          COALESCE(AVG(NULLIF(real_pnl_pct, 0)), 0) as real_avg_return_pct,
          COALESCE(SUM(CASE WHEN real_pnl_usd > 0 THEN real_pnl_usd ELSE 0 END), 0) as real_gross_profit,
          COALESCE(ABS(SUM(CASE WHEN real_pnl_usd < 0 THEN real_pnl_usd ELSE 0 END)), 0.01) as real_gross_loss,
          COUNT(DISTINCT DATE(entry_timestamp)) as trading_days
        FROM hybrid_shadow_trades
        WHERE status = 'closed'
      `);
      
      // Get count of active (open) trades
      const activeResult = await query(`
        SELECT COUNT(*) as active_trades
        FROM hybrid_shadow_trades
        WHERE status = 'open'
      `);
      
      // Get count of distinct scans that have trades
      const scansResult = await query(`
        SELECT COUNT(DISTINCT hsd.scan_id) as total_scans_with_trades
        FROM hybrid_shadow_trades hst
        JOIN hybrid_shadow_decisions hsd ON hsd.id = hst.decision_id
        WHERE hst.status = 'closed'
      `);

      const row = result.rows[0];
      const activeRow = activeResult.rows[0];
      const scansRow = scansResult.rows[0];
      const totalTrades = parseInt(row.total_trades);
      const activeTrades = parseInt(activeRow.active_trades);
      const wins = parseInt(row.wins);
      const losses = parseInt(row.losses);
      const totalScansWithTrades = parseInt(scansRow.total_scans_with_trades);
      const tradesPerScan = totalScansWithTrades > 0 ? totalTrades / totalScansWithTrades : 0;
      
      return {
        totalTrades,
        activeTrades,
        wins,
        losses,
        winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
        totalPnlUsd: parseFloat(row.total_pnl_usd),
        totalReturnPct: parseFloat(row.total_return_pct),
        avgReturnPct: parseFloat(row.avg_return_pct),
        profitFactor: parseFloat(row.gross_profit) / parseFloat(row.gross_loss),
        tradingDays: parseInt(row.trading_days),
        tradesPerScan,
        totalScansWithTrades,
        realTotalPnlUsd: parseFloat(row.real_total_pnl_usd),
        realTotalReturnPct: parseFloat(row.real_total_return_pct),
        realAvgReturnPct: parseFloat(row.real_avg_return_pct),
        realProfitFactor: parseFloat(row.real_gross_profit) / parseFloat(row.real_gross_loss),
      };
    } catch (error) {
      logger.error(`[Hybrid Shadow] Error getting stats: ${error}`);
      return {
        totalTrades: 0,
        activeTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalPnlUsd: 0,
        totalReturnPct: 0,
        avgReturnPct: 0,
        profitFactor: 0,
        tradingDays: 0,
        tradesPerScan: 0,
        totalScansWithTrades: 0,
      };
    }
  }
  
  /**
   * Get daily stats
   */
  async getDailyStats(days: number = 7): Promise<Array<{
    date: string;
    trades: number;
    wins: number;
    winRate: number;
    pnlUsd: number;
    pnlPct: number;
  }>> {
    try {
      const result = await query(`
        SELECT 
          DATE(entry_timestamp) as date,
          COUNT(*) as trades,
          COUNT(*) FILTER (WHERE pnl_pct > 0) as wins,
          SUM(pnl_usd) as pnl_usd,
          SUM(pnl_pct) as pnl_pct
        FROM hybrid_shadow_trades
        WHERE status = 'closed'
        AND entry_timestamp >= NOW() - INTERVAL '${days} days'
        GROUP BY DATE(entry_timestamp)
        ORDER BY date DESC
      `);
      
      return result.rows.map(row => ({
        date: row.date,
        trades: parseInt(row.trades),
        wins: parseInt(row.wins),
        winRate: parseInt(row.trades) > 0 ? (parseInt(row.wins) / parseInt(row.trades)) * 100 : 0,
        pnlUsd: parseFloat(row.pnl_usd) || 0,
        pnlPct: parseFloat(row.pnl_pct) || 0,
      }));
    } catch (error) {
      logger.error(`[Hybrid Shadow] Error getting daily stats: ${error}`);
      return [];
    }
  }
  
  /**
   * Get individual trades (not grouped by day)
   */
  async getTrades(days: number = 7): Promise<Array<{
    id: number;
    symbol: string;
    tokenAddress: string;
    entryTimestamp: string;
    exitTimestamp: string | null;
    entryPrice: number;
    exitPrice: number | null;
    positionUsd: number;
    // Real position in USD based on actual execution (when available)
    realPositionUsd?: number | null;
    entryAtaRentPaidSol?: number | null;
    exitAtaRentRefundedSol?: number | null;
    pnlPct: number | null;
    pnlUsd: number | null;
    // Real execution fields (when available)
    realEntryPrice?: number | null;
    realExitPrice?: number | null;
    realPnlPct?: number | null;
    realPnlUsd?: number | null;
    pTail?: number | null;
    exitReason: string | null;
    scanId: string | null;
    entryProb: number | null;
    crashPred: number | null;
    upsidePred: number | null;
    regimeProb: number | null;
    holdDurationMinutes: number | null;
    status: string;
    txHash?: string | null;
    exitTxHash?: string | null;
    // Quote data (from jupiter_quotes where used_for_swap = true)
    quoteEntryPrice?: number | null;
    quoteExitPrice?: number | null;
    quoteEntryInAmount?: string | null;
    quoteEntryOutAmount?: string | null;
    quoteEntryInputDecimals?: number | null;
    quoteEntryOutputDecimals?: number | null;
    quoteExitInAmount?: string | null;
    quoteExitOutAmount?: string | null;
    quoteExitInputDecimals?: number | null;
    quoteExitOutputDecimals?: number | null;
    marketIndex?: number | null;
    entryModelVersion?: string | null;
  }>> {
    try {
      const result = await query(`
        SELECT
          hst.id,
          hst.symbol,
          hst.token_address,
          hst.entry_timestamp,
          hst.exit_timestamp,
          hst.entry_price,
          hst.exit_price,
          hst.position_usd,
          hst.real_position_usd,
          hst.entry_ata_rent_paid_sol,
          hst.exit_ata_rent_refunded_sol,
          hst.pnl_pct,
          hst.pnl_usd,
          hst.real_entry_price,
          hst.real_exit_price,
          hst.real_pnl_pct,
          hst.real_pnl_usd,
          hst.p_tail,
          hst.exit_reason,
          hst.status,
          hst.entry_prob,
          hst.crash_pred,
          hst.upside_pred,
          hst.regime_prob,
          hsd.scan_id,
          hsd.entry_model_version,
          hst.tx_hash,
          hst.exit_tx_hash,
          s.sol_price as market_index,
          CASE 
            WHEN hst.exit_timestamp IS NOT NULL THEN
              EXTRACT(EPOCH FROM (hst.exit_timestamp - hst.entry_timestamp)) / 60
            ELSE NULL
          END as hold_duration_minutes,
          -- Quote entry/exit amounts and decimals for accurate price calculation
          jq_entry.in_amount as quote_entry_in_amount,
          jq_entry.out_amount as quote_entry_out_amount,
          jq_entry.input_decimals as quote_entry_input_decimals,
          jq_entry.output_decimals as quote_entry_output_decimals,
          jq_exit.in_amount as quote_exit_in_amount,
          jq_exit.out_amount as quote_exit_out_amount,
          jq_exit.input_decimals as quote_exit_input_decimals,
          jq_exit.output_decimals as quote_exit_output_decimals
        FROM hybrid_shadow_trades hst
        LEFT JOIN hybrid_shadow_decisions hsd ON hsd.id = hst.decision_id
        LEFT JOIN scans s ON s.id = hsd.scan_id
        LEFT JOIN jupiter_quotes jq_entry ON jq_entry.decision_id = hst.decision_id
          AND jq_entry.used_for_swap = true
          AND jq_entry.quote_type = 'entry'
          AND jq_entry.token_address = hst.token_address
        LEFT JOIN LATERAL (
          SELECT * FROM jupiter_quotes
          WHERE trade_id = hst.id
            AND used_for_swap = true
            AND quote_type = 'exit'
            AND token_address = hst.token_address
          ORDER BY created_at DESC
          LIMIT 1
        ) jq_exit ON true
        WHERE hst.entry_timestamp >= NOW() - INTERVAL '${days} days'
        ORDER BY hst.entry_timestamp DESC
      `);
      
      return result.rows.map(row => {
        // Calculate quote entry price if we have quote data
        let quoteEntryPrice: number | null = null;
        if (row.quote_entry_in_amount && row.quote_entry_out_amount) {
          try {
            // Quote: in_amount (lamports), out_amount (token with decimals)
            // Implied price = (SOL in) / (tokens out)
            // We need SOL price to convert to USD, but for now calculate relative to entry price
            // Actually, we can't compute USD price without SOL price, so we'll compute in frontend
            // For now, pass the raw amounts and let frontend compute
            quoteEntryPrice = null; // Will compute in frontend with SOL price
          } catch (e) {
            quoteEntryPrice = null;
          }
        }

        return {
          id: row.id,
          symbol: row.symbol || 'N/A',
          tokenAddress: row.token_address,
          entryTimestamp: row.entry_timestamp,
          exitTimestamp: row.exit_timestamp,
          entryPrice: row.entry_price ? parseFloat(row.entry_price) : 0,
          exitPrice: row.exit_price ? parseFloat(row.exit_price) : null,
          positionUsd: row.position_usd ? parseFloat(row.position_usd) : 0,
          realPositionUsd: row.real_position_usd ? parseFloat(row.real_position_usd) : null,
          entryAtaRentPaidSol: row.entry_ata_rent_paid_sol ? parseFloat(row.entry_ata_rent_paid_sol) : null,
          exitAtaRentRefundedSol: row.exit_ata_rent_refunded_sol ? parseFloat(row.exit_ata_rent_refunded_sol) : null,
          pnlPct: row.pnl_pct ? parseFloat(row.pnl_pct) : null,
          pnlUsd: row.pnl_usd ? parseFloat(row.pnl_usd) : null,
          realEntryPrice: row.real_entry_price ? parseFloat(row.real_entry_price) : null,
          realExitPrice: row.real_exit_price ? parseFloat(row.real_exit_price) : null,
          realPnlPct: row.real_pnl_pct ? parseFloat(row.real_pnl_pct) : null,
          realPnlUsd: row.real_pnl_usd ? parseFloat(row.real_pnl_usd) : null,
          pTail: row.p_tail ? parseFloat(row.p_tail) : null,
          exitReason: row.exit_reason,
          scanId: row.scan_id,
          entryProb: row.entry_prob ? parseFloat(row.entry_prob) : null,
          crashPred: row.crash_pred ? parseFloat(row.crash_pred) : null,
          upsidePred: row.upside_pred ? parseFloat(row.upside_pred) : null,
          regimeProb: row.regime_prob ? parseFloat(row.regime_prob) : null,
          holdDurationMinutes: row.hold_duration_minutes ? parseFloat(row.hold_duration_minutes) : null,
          status: row.status,
          txHash: row.tx_hash || null,
          exitTxHash: row.exit_tx_hash || null,
          quoteEntryPrice: quoteEntryPrice,
          quoteExitPrice: null, // Will compute in frontend
          // Pass raw quote data for frontend calculation
          quoteEntryInAmount: row.quote_entry_in_amount ? row.quote_entry_in_amount : null,
          quoteEntryOutAmount: row.quote_entry_out_amount ? row.quote_entry_out_amount : null,
          quoteEntryInputDecimals: row.quote_entry_input_decimals != null ? parseInt(row.quote_entry_input_decimals) : null,
          quoteEntryOutputDecimals: row.quote_entry_output_decimals != null ? parseInt(row.quote_entry_output_decimals) : null,
          quoteExitInAmount: row.quote_exit_in_amount ? row.quote_exit_in_amount : null,
          quoteExitOutAmount: row.quote_exit_out_amount ? row.quote_exit_out_amount : null,
          quoteExitInputDecimals: row.quote_exit_input_decimals != null ? parseInt(row.quote_exit_input_decimals) : null,
          quoteExitOutputDecimals: row.quote_exit_output_decimals != null ? parseInt(row.quote_exit_output_decimals) : null,
          marketIndex: row.market_index ? parseFloat(row.market_index) : null,
          entryModelVersion: row.entry_model_version || null,
        };
      });
    } catch (error) {
      logger.error(`[Hybrid Shadow] Error getting trades: ${error}`);
      return [];
    }
  }
  
  /**
   * Get decision funnel stats (how many tokens pass each filter)
   */
  async getDecisionFunnel(days: number = 7): Promise<{
    totalDecisions: number;
    passedEntry: number;
    passedCrash: number;
    passedRR: number;
    shouldTrade: number;
    tradeRate: number;
  }> {
    try {
      const result = await query(`
        SELECT 
          COUNT(*) as total_decisions,
          COUNT(*) FILTER (WHERE passed_entry_filter) as passed_entry,
          COUNT(*) FILTER (WHERE passed_crash_filter) as passed_crash,
          COUNT(*) FILTER (WHERE passed_rr_filter) as passed_rr,
          COUNT(*) FILTER (WHERE should_trade) as should_trade
        FROM hybrid_shadow_decisions
        WHERE decision_timestamp >= NOW() - INTERVAL '${days} days'
      `);
      
      const row = result.rows[0];
      const total = parseInt(row.total_decisions);
      
      return {
        totalDecisions: total,
        passedEntry: parseInt(row.passed_entry),
        passedCrash: parseInt(row.passed_crash),
        passedRR: parseInt(row.passed_rr),
        shouldTrade: parseInt(row.should_trade),
        tradeRate: total > 0 ? (parseInt(row.should_trade) / total) * 100 : 0,
      };
    } catch (error) {
      logger.error(`[Hybrid Shadow] Error getting decision funnel: ${error}`);
      return {
        totalDecisions: 0,
        passedEntry: 0,
        passedCrash: 0,
        passedRR: 0,
        shouldTrade: 0,
        tradeRate: 0,
      };
    }
  }
}

// Shared instance (enabled by default)
export const hybridShadowTracker = new HybridShadowTracker({
  enabled: true,  // Enabled by default - shadow mode active
  exitMinutes: 15,
  initialBalance: 1000,  // Base initial balance (actual balance = initial + sum of closed trades P&L)
  maxTradesPerScan: 5,
});

