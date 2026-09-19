/**
 * ML Prediction Service Client
 * 
 * Connects to the ML prediction microservice to get trading predictions
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

export interface TokenFeatures {
  // Identifiers
  scanned_token_id?: number;
  scan_price?: number;
  
  // Market data
  age_hours?: number;
  market_cap?: number;
  liquidity?: number;
  holders?: number;
  
  // Volume metrics (DexScreener)
  volume_5m?: number;
  volume_1h?: number;
  volume_6h?: number;
  volume_24h?: number;
  
  // Price changes (DexScreener)
  price_change_5m?: number;
  price_change_1h?: number;
  price_change_6h?: number;
  price_change_24h?: number;
  price_change_24h_dex?: number | null;
  
  // Transaction counts (DexScreener)
  txn_buys_5m?: number;
  txn_sells_5m?: number;
  txn_buys_1h?: number;
  txn_sells_1h?: number;
  txn_buys_6h?: number;
  txn_sells_6h?: number;
  txn_buys_24h?: number;
  txn_sells_24h?: number;
  
  // Activity metrics
  buy_sell_ratio?: number;
  bot_buys?: number;
  net_buys?: number;
  total_activity?: number;
  total_bots_count?: number;
  multi_bot_signal?: number;
  discovered_by_bots_count?: number;
  
  // Security metrics
  risk_score?: number;
  is_safe_int?: number;
  honeypot_int?: number;
  ownership_risk_int?: number;
  blacklist_int?: number;
  hidden_functions_int?: number;
  buy_tax?: number;
  sell_tax?: number;
  owner_percent?: number;
  top10_holder_percent?: number;
  can_take_back_ownership_int?: number;
  
  // Liquidity details (DexScreener)
  fdv?: number;
  liquidity_base?: number;
  liquidity_quote?: number;
  pair_created_at?: number | null;
  
  // Codex extended volumes
  volume_5m_codex?: number;
  volume_1h_codex?: number;
  volume_4h_codex?: number;
  volume_24h_codex?: number;
  
  // Codex transaction counts
  buy_count_5m_codex?: number | null;
  sell_count_5m_codex?: number | null;
  buy_count_1h_codex?: number | null;
  sell_count_1h_codex?: number | null;
  buy_count_4h_codex?: number | null;
  sell_count_4h_codex?: number | null;
  buy_count_24h_codex?: number | null;
  sell_count_24h_codex?: number | null;
  
  // Codex unique transactions
  unique_buys_5m_codex?: number | null;
  unique_sells_5m_codex?: number | null;
  unique_buys_1h_codex?: number | null;
  unique_sells_1h_codex?: number | null;
  unique_buys_24h_codex?: number | null;
  unique_sells_24h_codex?: number | null;
  unique_transactions_5m_codex?: number | null;
  unique_transactions_1h_codex?: number | null;
  unique_transactions_24h_codex?: number | null;
  
  // Codex wallet metrics
  swap_pct_1d_old_wallet?: number | null;
  swap_pct_7d_old_wallet?: number | null;
  wallet_age_avg?: number | null;
  wallet_age_std?: number | null;
  
  // Codex wallet type metrics (risk signals)
  bundler_count?: number | null;
  sniper_count?: number | null;
  insider_count?: number | null;
  bundler_held_percentage?: number | null;
  sniper_held_percentage?: number | null;
  insider_held_percentage?: number | null;
  dev_held_percentage?: number | null;
  
  // Codex scam flag
  is_scam_codex?: number;
  
  // Calculated quantitative metrics (volatility)
  volatility_5m?: number;
  volatility_1h?: number;
  volatility_24h?: number;
  
  // Calculated quantitative metrics (momentum)
  momentum_score?: number;
  momentum_direction?: number;
  
  // Calculated quantitative metrics (volume ratios)
  volume_ratio_5m_1h?: number | null;
  volume_ratio_1h_24h?: number | null;
  
  // Calculated quantitative metrics (volume velocity/acceleration)
  volume_velocity?: number | null;
  volume_acceleration?: number | null;
  
  // Price Action Features (OHLC-based, from candle_data)
  // 1m features (short-term microstructure)
  m1_ret_5m?: number | null;
  m1_ret_10m?: number | null;
  m1_ret_15m?: number | null;
  m1_vol_5m?: number | null;
  m1_vol_10m?: number | null;
  m1_rvol_5m?: number | null;
  m1_rvol_10m?: number | null;
  m1_vol_slope_5m?: number | null;
  m1_ret_slope_5m?: number | null;
  m1_body_avg_5m?: number | null;
  m1_range_avg_5m?: number | null;
  m1_upper_wick_ratio_5m?: number | null;
  m1_lower_wick_ratio_5m?: number | null;
  m1_last_bar_green_int?: number | null;  // boolean as int (0/1)
  m1_last_bar_long_upper_wick_int?: number | null;  // boolean as int (0/1)
  m1_last_bar_doji_int?: number | null;  // boolean as int (0/1)
  m1_consecutive_green?: number | null;
  m1_consecutive_red?: number | null;
  
  // 5m features (context/build-up)
  m5_ret_60m?: number | null;
  m5_ret_last_3?: number | null;
  m5_vol_60m?: number | null;
  m5_rvol_15m?: number | null;
  m5_price_slope_60m?: number | null;
  m5_volume_slope_60m?: number | null;
  m5_consecutive_green?: number | null;
  m5_pullback_depth?: number | null;
  
  // Cross-timeframe features
  pa_momo_alignment?: number | null;  // +1 (aligned), -1 (divergent), 0 (neutral)
  pa_vol_ratio_m1_m5?: number | null;
  pa_rvol_ratio_m1_m5?: number | null;
  
  // Microstructure features (calculated from price action)
  volume_squeeze?: number | null;      // m1_range_avg_5m / m5_range_avg_30m
  pullback_strength?: number | null;   // m5_pullback_depth / abs(m5_ret_60m)
  m5_range_avg_30m?: number | null;     // Average range over last 30 minutes (6 candles)
  
  // Order-flow imbalance (from Codex transaction data)
  imbalance_5m?: number | null;         // (txn_buys_5m - txn_sells_5m) / (txn_buys_5m + txn_sells_5m + 1)
  
  // Average trade sizes (from Codex)
  avg_buy_size_5m_codex?: number | null;
  avg_sell_size_5m_codex?: number | null;
  
  // Small wallet/trade buy ratios (from Codex)
  small_wallet_buy_ratio_5m?: number | null;
  small_trade_buy_ratio_5m?: number | null;
  
  // Small flow ratio (weighted combination)
  small_flow_ratio_5m?: number | null; // 0.7 * small_wallet_buy_ratio + 0.3 * small_trade_buy_ratio
  
  // Price impact coefficient
  price_impact_5m?: number | null;     // (price_change_5m / 100) / (volume_5m_codex + eps)
  
  // Jupiter quote data (pre-trade liquidity check - for realistic cost model)
  jupiter_buy_quote_success?: number | null;    // 0/1
  jupiter_buy_quote_price_impact?: number | null; // fraction (e.g. 0.05 = 5%)
  jupiter_buy_quote_routes_count?: number | null;
  jupiter_sell_quote_success?: number | null;    // 0/1
  jupiter_sell_quote_price_impact?: number | null; // fraction (e.g. 0.05 = 5%)
  jupiter_sell_quote_routes_count?: number | null;
  // Derived quote features (computed from raw quote data)
  jupiter_roundtrip_impact?: number | null;      // buy + sell impact (fraction)
  jupiter_impact_asymmetry?: number | null;      // sell/buy impact ratio
  jupiter_roundtrip_cost_pct?: number | null;    // roundtrip cost in % including fees
  jupiter_buy_impact_log?: number | null;        // log1p(buy_impact * 100)
  jupiter_sell_impact_log?: number | null;       // log1p(sell_impact * 100)
  impact_per_unit_liquidity?: number | null;     // roundtrip_impact / log1p(liquidity)
  
  // Cost columns (calculated from Jupiter quotes/liquidity - included as features)
  effective_entry_costs?: number | null;        // Entry cost % (calculated)
  effective_exit_costs?: number | null;          // Exit cost % (calculated)
  effective_total_costs?: number | null;        // Total cost % (entry + exit)
  
  // Metadata (for debugging/filtering)
  m1_candles_available?: number | null;
  m5_candles_available?: number | null;
  
  // Smart money metrics
  smart_money_wallet_count?: number;
  smart_money_buy_percentage?: number;
  smart_money_conviction_score?: number;
  
  // Regime features (macro market conditions - shared by all tokens in scan)
  sol_price?: number | null;
  sol_ret_5m?: number | null;
  sol_ret_15m?: number | null;
  sol_ret_1h?: number | null;
  sol_ret_6h?: number | null;
  sol_volatility_1h?: number | null;
  sol_volatility_24h?: number | null;
  sol_trend_strength?: number | null;
}

export interface MLPrediction {
  is_winner: boolean;
  confidence: number;          // win_prob from binary model (0-1)
  should_trade: boolean;       // confidence >= threshold
  risk_prob?: number;          // probability of big loss (from is_big_loss model), if available
  model_version: string;
  features_used: number;
  features_non_null?: number;  // Number of features that were non-null (before imputation)
  features_total?: number;     // Total number of features
  predicted_return?: number;   // Expected return from regression model (% conditional on winning)
  expected_value?: number;     // Calculated: confidence × max(predicted_return, 0)
  rank?: number;               // Rank among all predictions (1 = highest confidence)
  percentile?: number;         // Percentile (0-100, 100 = top confidence)
  confidence_threshold_used?: number;  // Effective threshold used (may be boosted when strategy is losing)
}

export interface ModelInfo {
  model_version: string;
  features: string[];
  binary_target?: string;
  regression_target?: string;
  metrics?: {
    accuracy?: number;
    auc?: number;
    rmse?: number;
    r2?: number;
  };
}

// ============================================================================
// HYBRID PREDICTION (Shadow Mode)
// ============================================================================
export interface HybridPrediction {
  // Model predictions
  entry_prob: number;           // Entry model probability (0-1)
  crash_pred: number;           // Crash model prediction (min_gain %)
  upside_pred: number;          // Upside model prediction (max_gain %)
  p_tail: number | null;        // Tail probability (0-1) for adaptive thresholds
  regime_prob: number | null;   // Regime model probability (0-1)
  
  // Calculated values
  risk_reward_ratio: number;    // upside / abs(crash)
  position_pct: number;         // Recommended position size %
  
  // Adaptive thresholds used (for debugging/logging)
  effective_entry_threshold?: number;  // Actual entry threshold used (may be relaxed by p_tail)
  effective_rr_threshold?: number;     // Actual RR threshold used (may be relaxed by p_tail)
  
  // Filters
  passed_entry_filter: boolean; // entry_prob >= effective_entry_threshold
  passed_crash_filter: boolean; // crash_pred >= -38.0
  passed_rr_filter: boolean;    // risk_reward >= effective_rr_threshold
  should_trade: boolean;        // All filters passed
  skip_reason: string | null;
  
  // Model versions
  entry_model_version: string;
  crash_model_version: string;
  upside_model_version: string;
  tail_model_version?: string | null;
  regime_model_version: string | null;
  
  // Feature info
  features_used: number;
  features_non_null: number;
  features_complete?: Record<string, any>;  // Raw input features (with nulls)
  features_model_input?: Record<string, number>;  // Actual values fed to model (after fillna/imputer)
}

export class MLPredictionClient {
  private client: AxiosInstance;
  private hybridClient: AxiosInstance; // Separate client with longer timeout for hybrid predictions
  private baseUrl: string;
  private confidenceThreshold: number; // Confidence threshold (0.0-1.0) from POINT_BASED_MIN_SCORE
  private enabled: boolean;
  private modelInfo: ModelInfo | null = null; // Cached model info
  private modelInfoCacheTime: number = 0; // Timestamp of last fetch
  private readonly MODEL_INFO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache
  
  // Hybrid model info cache (separate from old model)
  private hybridModelInfo: { feature_cols: string[] } | null = null;
  private hybridModelInfoCacheTime: number = 0;

  constructor() {
    this.enabled = process.env.USE_ML_FILTER === 'true';
    this.baseUrl = process.env.ML_PREDICTION_SERVICE_URL || 'http://localhost:8001';
    
    // Use POINT_BASED_MIN_SCORE directly (user sets this to desired Precision@K threshold)
    // Example: If Precision@20% threshold = 0.61, set POINT_BASED_MIN_SCORE=61
    const minScore = parseFloat(process.env.POINT_BASED_MIN_SCORE || '70');
    this.confidenceThreshold = minScore / 100; // e.g., 61 -> 0.61

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 300000, // 300 second timeout (5 minutes) - matches Cloud Run service timeout
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    // Separate client for hybrid predictions (can take longer during market data recalculation)
    this.hybridClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 300000, // 300 second timeout (5 minutes) - matches Cloud Run service timeout
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (this.enabled) {
      logger.info(`🤖 ML Prediction Service enabled: ${this.baseUrl}`);
      logger.info(`   Confidence threshold: ${this.confidenceThreshold.toFixed(4)} (from POINT_BASED_MIN_SCORE: ${minScore})`);
      logger.info(`   💡 Set POINT_BASED_MIN_SCORE to Precision@K threshold from training output`);
    } else {
      logger.info('🤖 ML Prediction Service disabled (USE_ML_FILTER=false)');
    }
  }

  /**
   * Predict if a token will be a winner
   */
  async predict(
    token: TokenFeatures,
    strategyPerformance?: {
      dailyPnlUsd: number;
      dailyPnlPct: number;  // Daily P&L as % of starting balance (e.g., -0.02 = -2%)
      recentWinRate: number | null;
      recentTradesCount: number;
    }
  ): Promise<MLPrediction> {
    if (!this.enabled) {
      // If ML is disabled, allow all trades (fallback)
      return {
        is_winner: true,
        confidence: 0.5,
        should_trade: true,
        model_version: 'disabled',
        features_used: 0,
        features_non_null: 0,
        features_total: 0,
      };
    }

    try {
      // Filter features to only include what the model supports
      const filteredToken = this.filterFeatures(token);
      
      const requestBody: any = {
        token: filteredToken,
        confidence_threshold: this.confidenceThreshold,
      };
      
      // Add strategy performance data if available (for reversible threshold decay)
      if (strategyPerformance) {
        requestBody.daily_pnl_usd = strategyPerformance.dailyPnlUsd;
        requestBody.daily_pnl_pct = strategyPerformance.dailyPnlPct;  // % of balance
        requestBody.recent_win_rate = strategyPerformance.recentWinRate;
        requestBody.recent_trades_count = strategyPerformance.recentTradesCount;
      }
      
      const response = await this.client.post<MLPrediction>('/predict', requestBody);

      // Calculate expected value if we have predicted_return
      const prediction = response.data;
      if (prediction.predicted_return !== undefined && prediction.predicted_return !== null) {
        // Expected value = P(win) × E[return | win]
        prediction.expected_value = prediction.confidence * Math.max(prediction.predicted_return, 0);
      }

      return prediction;
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const errorType = error?.code || error?.name || 'Unknown';
      logger.error(`ML prediction failed (${errorType}): ${errorMessage}`);
      
      // Fail-closed: block trade when ML service is unavailable
      logger.warn('⚠️  ML service unavailable, blocking trade (fail-closed mode)');
      return {
        is_winner: false,
        confidence: 0.0,
        should_trade: false,
        model_version: 'fallback-error',
        features_used: 0,
        features_non_null: 0,
        features_total: 0,
      };
    }
  }

  /**
   * Batch prediction for multiple tokens with threshold filtering
   * Returns predictions with should_trade set based on confidence threshold
   */
  async predictBatch(
    tokens: TokenFeatures[],
    scanTimestamp?: string,
    strategyPerformance?: {
      dailyPnlUsd: number;
      dailyPnlPct: number;  // Daily P&L as % of starting balance (e.g., -0.02 = -2%)
      recentWinRate: number | null;
      recentTradesCount: number;
    }
  ): Promise<MLPrediction[]> {
    if (!this.enabled) {
      return tokens.map(() => ({
        is_winner: true,
        confidence: 0.5,
        should_trade: true,
        model_version: 'disabled',
        features_used: 0,
        features_non_null: 0,
        features_total: 0,
      }));
    }

    try {
      // Filter features to only include what the model supports
      const filteredTokens = tokens.map(token => this.filterFeatures(token));
      
      // Use POINT_BASED_MIN_SCORE as threshold (user sets this to desired Precision@K threshold)
      // This implements global threshold ranking (Option A) instead of per-batch ranking (Option B)
      const requestBody: any = {
        tokens: filteredTokens,
        confidence_threshold: this.confidenceThreshold,  // Global threshold from POINT_BASED_MIN_SCORE
        scan_timestamp: scanTimestamp,  // Send scan timestamp for market features
      };
      
      // Add strategy performance data if available (for reversible threshold decay)
      if (strategyPerformance) {
        requestBody.daily_pnl_usd = strategyPerformance.dailyPnlUsd;
        requestBody.daily_pnl_pct = strategyPerformance.dailyPnlPct;  // % of balance
        requestBody.recent_win_rate = strategyPerformance.recentWinRate;
        requestBody.recent_trades_count = strategyPerformance.recentTradesCount;
      }
      
      const response = await this.client.post<{
        predictions: MLPrediction[];
        model_version: string;
        total_tokens: number;
        recommended_trades: number;
      }>('/predict/batch', requestBody);

      const predictions = response.data.predictions;
      
      // Calculate expected_value for each prediction
      for (const pred of predictions) {
        if (pred.predicted_return !== undefined && pred.predicted_return !== null) {
          // Expected value = P(win) × E[return | win]
          pred.expected_value = pred.confidence * Math.max(pred.predicted_return, 0);
        }
      }
      
      // Count how many passed threshold
      const passedCount = predictions.filter(p => p.should_trade).length;
      
      logger.debug(`🤖 ML Filtering: ${passedCount}/${predictions.length} tokens passed threshold (≥${this.confidenceThreshold.toFixed(4)})`);
      
      return predictions;
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const errorType = error?.code || error?.name || 'Unknown';
      logger.error(`ML batch prediction failed (${errorType}): ${errorMessage}`);
      
      // Fail-closed: block all trades when ML service is unavailable
      logger.warn('⚠️  ML service unavailable, blocking all trades (fail-closed mode)');
      return tokens.map(() => ({
        is_winner: false,
        confidence: 0.0,
        should_trade: false,
        model_version: 'fallback-error',
        features_used: 0,
        features_non_null: 0,
        features_total: 0,
      }));
    }
  }

  /**
   * Get confidence threshold (0.0-1.0)
   */
  getConfidenceThreshold(): number {
    return this.confidenceThreshold;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    if (!this.enabled) {
      return true; // If disabled, consider it "healthy"
    }

    try {
      const response = await this.client.get('/health');
      return response.data.status === 'healthy';
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if ML filtering is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get model info (features list, version, etc.) with caching
   */
  async getModelInfo(): Promise<ModelInfo | null> {
    if (!this.enabled) {
      return null;
    }

    // Return cached info if still valid
    const now = Date.now();
    if (this.modelInfo && (now - this.modelInfoCacheTime) < this.MODEL_INFO_CACHE_TTL) {
      return this.modelInfo;
    }

    try {
      const response = await this.client.get<ModelInfo>('/model-info');
      this.modelInfo = response.data;
      this.modelInfoCacheTime = now;
      logger.debug(`🤖 Model info cached: ${this.modelInfo.model_version}, ${this.modelInfo.features.length} features`);
      return this.modelInfo;
    } catch (error: any) {
      // Extract detailed error information
      const statusCode = error.response?.status || 'unknown';
      const errorDetail = error.response?.data?.detail || error.message || 'Unknown error';
      const errorMessage = `Failed to fetch model info (HTTP ${statusCode}): ${errorDetail}`;
      
      logger.warn(`⚠️  ${errorMessage}`);
      
      // Log full error details in debug mode
      if (error.response?.data) {
        logger.debug(`   Full error response: ${JSON.stringify(error.response.data)}`);
      }
      
      return this.modelInfo; // Return cached version if available, even if expired
    }
  }

  // ============================================================================
  // HYBRID PREDICTION (Shadow Mode)
  // ============================================================================
  
  /**
   * Get hybrid prediction for shadow mode testing.
   * Uses 4 models: entry, crash, upside, regime.
   * Does NOT affect the normal predict/predictBatch endpoints.
   */
  async predictHybrid(
    token: TokenFeatures,
    solFeatures?: {
      sol_price?: number;
      sol_ret_5m?: number;
      sol_ret_15m?: number;
      sol_ret_1h?: number;
      sol_ret_6h?: number;
      sol_volatility_1h?: number;
      sol_volatility_24h?: number;
      sol_trend_strength?: number;
      market_winrate_1h?: number;
    },
    scanTimestamp?: Date | string
  ): Promise<HybridPrediction | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      // Filter features using hybrid model's feature list (not old model's list)
      // This ensures we send exactly what hybrid models expect
      const filteredToken = await this.filterFeaturesForHybrid(token);
      
      const requestBody: any = {
        token: filteredToken,
        scan_timestamp: scanTimestamp 
          ? (typeof scanTimestamp === 'string' ? scanTimestamp : scanTimestamp.toISOString())
          : new Date().toISOString(),
      };
      
      // Add SOL features if available (all sol_* features for regime model)
      if (solFeatures) {
        if (solFeatures.sol_price !== undefined) requestBody.sol_price = solFeatures.sol_price;
        if (solFeatures.sol_ret_5m !== undefined) requestBody.sol_ret_5m = solFeatures.sol_ret_5m;
        if (solFeatures.sol_ret_15m !== undefined) requestBody.sol_ret_15m = solFeatures.sol_ret_15m;
        if (solFeatures.sol_ret_1h !== undefined) requestBody.sol_ret_1h = solFeatures.sol_ret_1h;
        if (solFeatures.sol_ret_6h !== undefined) requestBody.sol_ret_6h = solFeatures.sol_ret_6h;
        if (solFeatures.sol_volatility_1h !== undefined) requestBody.sol_volatility_1h = solFeatures.sol_volatility_1h;
        if (solFeatures.sol_volatility_24h !== undefined) requestBody.sol_volatility_24h = solFeatures.sol_volatility_24h;
        if (solFeatures.sol_trend_strength !== undefined) requestBody.sol_trend_strength = solFeatures.sol_trend_strength;
        if (solFeatures.market_winrate_1h !== undefined) requestBody.market_winrate_1h = solFeatures.market_winrate_1h;
      }
      
      // Use hybridClient with longer timeout (market data recalculation can take 30-60s)
      const response = await this.hybridClient.post<HybridPrediction>('/predict/hybrid', requestBody);
      
      logger.debug(`🔮 [Hybrid] Prediction for token ${token.scanned_token_id}: ` +
        `entry=${response.data.entry_prob.toFixed(3)}, ` +
        `crash=${response.data.crash_pred.toFixed(1)}%, ` +
        `upside=${response.data.upside_pred.toFixed(1)}%, ` +
        `should_trade=${response.data.should_trade}`
      );
      
      return response.data;
    } catch (error: any) {
      // Log error but don't block - shadow mode should be non-disruptive
      const errorMessage = error?.message || String(error);
      const errorType = error?.code || error?.name || 'Unknown';
      
      if (errorType === 'ECONNABORTED' || errorMessage.includes('timeout')) {
        logger.warn(`⚠️  Hybrid prediction timed out (ML service may be recalculating market data): ${errorMessage}`);
      } else {
        logger.warn(`⚠️  Hybrid prediction failed (${errorType}): ${errorMessage}`);
      }
      
      return null;
    }
  }

  /**
   * Get hybrid model info (features list) from /health/hybrid endpoint
   */
  async getHybridModelInfo(): Promise<{ feature_cols: string[] } | null> {
    if (!this.enabled) {
      return null;
    }

    // Return cached info if still valid
    const now = Date.now();
    if (this.hybridModelInfo && (now - this.hybridModelInfoCacheTime) < this.MODEL_INFO_CACHE_TTL) {
      return this.hybridModelInfo;
    }

    try {
      const response = await this.hybridClient.get<{
        status: string;
        models: {
          entry?: { feature_cols?: string[] };
          crash?: { feature_cols?: string[] };
        };
      }>('/health/hybrid');
      
      // Use entry model's feature_cols (all hybrid models use same features)
      const entryModel = response.data.models?.entry;
      if (entryModel?.feature_cols && entryModel.feature_cols.length > 0) {
        this.hybridModelInfo = { feature_cols: entryModel.feature_cols };
        this.hybridModelInfoCacheTime = now;
        logger.debug(`🤖 Hybrid model info cached: ${this.hybridModelInfo.feature_cols.length} features`);
        return this.hybridModelInfo;
      }
      
      return null;
    } catch (error: any) {
      logger.warn(`⚠️  Failed to fetch hybrid model info: ${error?.message || String(error)}`);
      return this.hybridModelInfo; // Return cached version if available
    }
  }

  /**
   * Filter features to only include those supported by the model
   */
  private filterFeatures(token: TokenFeatures): TokenFeatures {
    // If we don't have model info, send all features (model will handle it)
    if (!this.modelInfo || !this.modelInfo.features || this.modelInfo.features.length === 0) {
      return token;
    }

    const supportedFeatures = new Set(this.modelInfo.features);
    const filtered: TokenFeatures = {};

    // Only include features that the model expects
    for (const key in token) {
      if (supportedFeatures.has(key)) {
        (filtered as any)[key] = (token as any)[key];
      }
    }

    return filtered;
  }

  /**
   * Filter features for hybrid models using hybrid model feature list
   */
  private async filterFeaturesForHybrid(token: TokenFeatures): Promise<TokenFeatures> {
    // Get hybrid model info (with caching)
    const hybridInfo = await this.getHybridModelInfo();
    
    // If we don't have hybrid model info, send all features (model will handle it)
    if (!hybridInfo || !hybridInfo.feature_cols || hybridInfo.feature_cols.length === 0) {
      return token;
    }

    const supportedFeatures = new Set(hybridInfo.feature_cols);
    const filtered: TokenFeatures = {};

    // Only include features that hybrid models expect
    for (const key in token) {
      if (supportedFeatures.has(key)) {
        (filtered as any)[key] = (token as any)[key];
      }
    }

    return filtered;
  }
}

