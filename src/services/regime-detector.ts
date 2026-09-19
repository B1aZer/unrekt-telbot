/**
 * Market Regime Detection Service
 * 
 * Combines 4 regime types to provide comprehensive market state analysis:
 * 1. Trend Regime (SOL-driven) - real-time
 * 2. Activity/Liquidity Regime (bot activity) - real-time
 * 3. Risk Regime (token win-rate environment) - lagged (uses finalized peak_gain)
 * 4. Microstructure Regime (entry timing) - real-time
 * 
 * Uses z-score normalization with rolling statistics for dynamic thresholds.
 * 
 * IMPORTANT: Risk regime uses data from (TOKEN_TRACKING_MINUTES + 60) minutes ago
 * to ensure peak_gain values are finalized. Other regimes use real-time data.
 */

import { logger } from '../utils/logger';
import { query } from '../infra/database';

/**
 * EWMA (Exponential Weighted Moving Average) state for regime smoothing
 * Prevents flip-flopping between regimes by smoothing scores over time
 * Tracks both raw values (for microstructure price change) and scores separately
 */
interface EWMAState {
  trend_score: number;
  liquidity_score: number;
  micro_score: number;
  ewma_price_change_5m: number; // Separate EWMA for raw price_change_5m (not mixed with micro_score)
  last_update: Date;
}

// Global EWMA state (in-memory cache, resets on restart)
let ewmaState: EWMAState | null = null;
const EWMA_ALPHA = 0.3; // Smoothing factor (0.3 = 30% new value, 70% old value)

// Cache for rolling stats (PERCENTILE_CONT is expensive, 24h window changes slowly)
let rollingStatsCache: { data: any; fetchedAt: number } | null = null;
const ROLLING_STATS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Reset EWMA state (useful for backfilling historical data)
 * Call this before processing historical scans in chronological order
 */
export function resetEWMAState(): void {
  ewmaState = null;
  rollingStatsCache = null;
}

export interface RegimeScores {
  trend_score: number;
  liquidity_score: number;
  risk_score: number;
  micro_score: number;
}

export interface RegimeClassifications {
  trend_regime: string;
  liquidity_regime: string;
  risk_regime: string;
  micro_regime: string;
  global_regime: string;
}

export interface RegimeData {
  scores: RegimeScores;
  classifications: RegimeClassifications;
  global_regime_score?: number; // Weighted numeric score for global regime
  trading_parameters?: {
    position_size_multiplier: number;
    tp_levels: number[];
    sl_percent: number;
    entry_threshold_adjustment: number;
  };
  metadata: {
    sol_ret_1h: number;
    sol_ret_6h: number;
    sol_volatility_1h: number;
    sol_trend_strength: number;
    total_transactions: number;
    tokens_found: number;
    market_winrate_1h?: number;
    market_ev_1h?: number;
    median_peak_gain?: number; // Robust metric for risk regime
    trimmed_mean_peak_gain?: number; // Robust metric for research
  };
  timestamp: Date;
}

/**
 * Calculate robust z-score using median and MAD (Median Absolute Deviation)
 * More robust to outliers than mean/std, especially with small samples
 * Gracefully handles edge cases (zero MAD) with fallback to small epsilon
 */
function calculateRobustZScore(
  value: number,
  median: number,
  mad: number
): number {
  // If mad is tiny/zero, fallback to small epsilon to avoid division by zero
  // This can happen when all values in the window are identical
  const safeMad = (isNaN(mad) || mad <= 0) ? 1e-6 : mad;
  const safeMedian = isNaN(median) ? 0 : median;
  
  // MAD to std conversion: std ≈ 1.4826 * MAD (for normal distribution)
  const robustStd = safeMad * 1.4826;
  const zScore = (value - safeMedian) / robustStd;
  
  // Cap z-scores at [-4, 4] for more dynamic range while still bounded
  return Math.max(-4, Math.min(4, zScore));
}

/**
 * Get rolling statistics from recent scans (last 24 hours)
 * Used for dynamic z-score calculation with robust statistics (median/MAD only)
 * Requires minimum 30 samples for reliable statistics
 */
async function getRollingStats(): Promise<any> {
  // Return cached stats if fresh (avoids expensive PERCENTILE_CONT every scan cycle)
  if (rollingStatsCache && (Date.now() - rollingStatsCache.fetchedAt) < ROLLING_STATS_CACHE_TTL_MS) {
    return rollingStatsCache.data;
  }

  const MIN_SAMPLES = 30;

  // Get robust statistics (median/MAD) only
  const robustResult = await query(`
    WITH medians AS (
      SELECT 
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sol_ret_5m)::double precision as median_ret_5m,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sol_ret_15m)::double precision as median_ret_15m,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sol_ret_1h)::double precision as median_ret_1h,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sol_trend_strength)::double precision as median_trend_strength,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_transactions)::double precision as median_total_tx,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tokens_found)::double precision as median_tokens_found
      FROM scans
      WHERE timestamp >= NOW() - INTERVAL '24 hours'
        AND sol_price IS NOT NULL
    )
    SELECT 
      COUNT(*)::integer as sample_count,
      COALESCE(m.median_ret_5m, 0) as median_ret_5m,
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(s.sol_ret_5m - m.median_ret_5m))::double precision, 0) as mad_ret_5m,
      COALESCE(m.median_ret_15m, 0) as median_ret_15m,
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(s.sol_ret_15m - m.median_ret_15m))::double precision, 0) as mad_ret_15m,
      COALESCE(m.median_ret_1h, 0) as median_ret_1h,
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(s.sol_ret_1h - m.median_ret_1h))::double precision, 0) as mad_ret_1h,
      COALESCE(m.median_trend_strength, 0) as median_trend_strength,
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(s.sol_trend_strength - m.median_trend_strength))::double precision, 0) as mad_trend_strength,
      COALESCE(m.median_total_tx, 0) as median_total_tx,
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(s.total_transactions - m.median_total_tx))::double precision, 0) as mad_total_tx,
      COALESCE(m.median_tokens_found, 0) as median_tokens_found,
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(s.tokens_found - m.median_tokens_found))::double precision, 0) as mad_tokens_found
    FROM scans s
    CROSS JOIN medians m
    WHERE s.timestamp >= NOW() - INTERVAL '24 hours'
      AND s.sol_price IS NOT NULL
    GROUP BY m.median_ret_5m, m.median_ret_15m, m.median_ret_1h, m.median_trend_strength, m.median_total_tx, m.median_tokens_found
  `);

  const robustRow = robustResult.rows[0] || {};
  const sampleCount = parseFloat(robustRow.sample_count || 0);
  
  // If insufficient samples, fallback gracefully instead of throwing
  // This prevents the whole regime detection from failing during low-volume hours
  if (sampleCount < MIN_SAMPLES) {
    logger.warn(`Insufficient samples for regime detection (${sampleCount}/${MIN_SAMPLES}). Using neutral fallback stats.`);
    
    // Return neutral medians (0) with small MAD (1e-6) for graceful degradation
    // This allows regime detection to continue with reduced confidence
    const fallbackStats = {
      sample_count: sampleCount,
      median_ret_5m: 0,
      mad_ret_5m: 1e-6,
      median_ret_15m: 0,
      mad_ret_15m: 1e-6,
      median_ret_1h: 0,
      mad_ret_1h: 1e-6,
      median_trend_strength: 0,
      mad_trend_strength: 1e-6,
      median_total_tx: 0,
      mad_total_tx: 1e-6,
      median_tokens_found: 0,
      mad_tokens_found: 1e-6,
    };
    // Cache even fallback stats to avoid repeated queries during low-volume hours
    rollingStatsCache = { data: fallbackStats, fetchedAt: Date.now() };
    return fallbackStats;
  }

  // Return robust statistics with safe parsing
  const stats = {
    sample_count: sampleCount,
    median_ret_5m: parseFloat(robustRow.median_ret_5m) || 0,
    mad_ret_5m: Math.max(1e-6, parseFloat(robustRow.mad_ret_5m) || 1e-6),
    median_ret_15m: parseFloat(robustRow.median_ret_15m) || 0,
    mad_ret_15m: Math.max(1e-6, parseFloat(robustRow.mad_ret_15m) || 1e-6),
    median_ret_1h: parseFloat(robustRow.median_ret_1h) || 0,
    mad_ret_1h: Math.max(1e-6, parseFloat(robustRow.mad_ret_1h) || 1e-6),
    median_trend_strength: parseFloat(robustRow.median_trend_strength) || 0,
    mad_trend_strength: Math.max(1e-6, parseFloat(robustRow.mad_trend_strength) || 1e-6),
    median_total_tx: parseFloat(robustRow.median_total_tx) || 0,
    mad_total_tx: Math.max(1e-6, parseFloat(robustRow.mad_total_tx) || 1e-6),
    median_tokens_found: parseFloat(robustRow.median_tokens_found) || 0,
    mad_tokens_found: Math.max(1e-6, parseFloat(robustRow.mad_tokens_found) || 1e-6),
  };
  rollingStatsCache = { data: stats, fetchedAt: Date.now() };
  return stats;
}

/**
 * Calculate market win rate and EV from recent scanned tokens
 * This is the "Risk Regime" - how favorable is the overall market for memecoin pumps?
 * 
 * IMPORTANT: Only uses scans where the forward tracking window has completed
 * to avoid data leakage (peak_gain is a future value calculated after scan).
 * Tracking window duration comes from TOKEN_TRACKING_MINUTES env variable.
 * 
 * Uses robust metrics: median_peak_gain for classification, trimmed_mean for research
 */
async function calculateMarketRiskMetrics(): Promise<{ 
  winrate: number; 
  ev: number;
  median_peak_gain: number;
  trimmed_mean_peak_gain: number;
}> {
  // Get tracking window duration from environment (defaults to 60 minutes)
  const trackingMinutes = parseInt(process.env.TOKEN_TRACKING_MINUTES || '60', 10);
  
  // Validate tracking minutes is a positive number
  if (isNaN(trackingMinutes) || trackingMinutes <= 0) {
    logger.warn(`Invalid TOKEN_TRACKING_MINUTES value: ${process.env.TOKEN_TRACKING_MINUTES}, using default 60`);
    const defaultTrackingMinutes = 60;
    const tpLevelsStr = process.env.PAPER_DEFAULT_TP_LEVELS || '15,100,500';
    const tpLevels = tpLevelsStr.split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x) && x > 0);
    const winThreshold = tpLevels[0] || 15;
    return await calculateMarketRiskMetricsWithWindow(defaultTrackingMinutes, winThreshold);
  }
  
  // Get win threshold safely
  const tpLevelsStr = process.env.PAPER_DEFAULT_TP_LEVELS || '15,100,500';
  const tpLevels = tpLevelsStr.split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x) && x > 0);
  const winThreshold = tpLevels[0] || 15;
  
  return await calculateMarketRiskMetricsWithWindow(trackingMinutes, winThreshold);
}

/**
 * Helper function to calculate market risk metrics with a specific tracking window
 * Returns robust metrics: median and trimmed mean (drop top 1%) in addition to mean
 * 
 * @param trackingMinutes Tracking window duration
 * @param winThreshold Win threshold (TP1 level) - must be a safe number
 */
async function calculateMarketRiskMetricsWithWindow(
  trackingMinutes: number,
  winThreshold: number
): Promise<{ 
  winrate: number; 
  ev: number;
  median_peak_gain: number;
  trimmed_mean_peak_gain: number;
}> {
  // Only use scans old enough that their tracking window has completed
  // This ensures peak_gain values are finalized and not still being calculated
  // We look at scans from (trackingMinutes + 1 hour) ago to (trackingMinutes) ago
  // This gives us a 1-hour window of scans whose peak_gain has been finalized
  const windowStartMinutes = trackingMinutes + 60; // tracking window + 1 hour
  const windowEndMinutes = trackingMinutes;
  
  // Validate and sanitize inputs to prevent SQL injection
  // winThreshold is already passed as parameter (from calculateMarketRiskMetrics)
  const safeWinThreshold = Number.isFinite(winThreshold) && winThreshold > 0 && winThreshold <= 1000
    ? winThreshold
    : 15;
  const safeWindowStart = Number.isFinite(windowStartMinutes) && windowStartMinutes > 0 && windowStartMinutes < 100000
    ? Math.floor(windowStartMinutes)
    : trackingMinutes + 60;
  const safeWindowEnd = Number.isFinite(windowEndMinutes) && windowEndMinutes >= 0 && windowEndMinutes < 100000
    ? Math.floor(windowEndMinutes)
    : trackingMinutes;
  
  // Use parameterized query to prevent SQL injection
  // Note: INTERVAL values must be interpolated (PostgreSQL limitation), but we validate inputs above
  const result = await query(`
    WITH p99 AS (
      SELECT PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY st.peak_gain)::double precision as p99_value
      FROM scanned_tokens st
      INNER JOIN scans s ON s.id = st.scan_id
      WHERE s.timestamp >= NOW() - INTERVAL '${safeWindowStart} minutes'
        AND s.timestamp <= NOW() - INTERVAL '${safeWindowEnd} minutes'
        AND st.peak_gain IS NOT NULL
        AND st.chain = 'SOLANA'
    )
    SELECT 
      COUNT(*)::integer as total_tokens,
      COUNT(CASE WHEN st.peak_gain >= $1 THEN 1 END)::integer as winning_tokens,
      COALESCE(AVG(st.peak_gain)::double precision, 0) as avg_peak_gain,
      -- Robust statistics: median (for classification) and trimmed mean (drop top 1%)
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY st.peak_gain)::double precision, 0) as median_peak_gain,
      -- Trimmed mean: exclude top 1% outliers (99th percentile)
      COALESCE(
        AVG(st.peak_gain) FILTER (WHERE st.peak_gain <= p.p99_value)::double precision,
        AVG(st.peak_gain)::double precision
      ) as trimmed_mean_peak_gain
    FROM scanned_tokens st
    INNER JOIN scans s ON s.id = st.scan_id
    CROSS JOIN p99 p
    WHERE s.timestamp >= NOW() - INTERVAL '${safeWindowStart} minutes'
      AND s.timestamp <= NOW() - INTERVAL '${safeWindowEnd} minutes'
      AND st.peak_gain IS NOT NULL
      AND st.chain = 'SOLANA'
  `, [safeWinThreshold]);

  const row = result.rows[0];
  
  if (!row || !row.total_tokens || parseFloat(row.total_tokens) === 0) {
    return { winrate: 0.5, ev: 0, median_peak_gain: 0, trimmed_mean_peak_gain: 0 }; // neutral defaults
  }

  const totalTokens = parseFloat(row.total_tokens);
  const winningTokens = parseFloat(row.winning_tokens);
  const winrate = winningTokens / totalTokens;
  
  // Market EV = average peak_gain across all tokens (winners and losers)
  // Use trimmed mean for EV (more robust to outliers) but keep avg for backward compatibility
  const ev = parseFloat(row.trimmed_mean_peak_gain || row.avg_peak_gain || 0);
  const median_peak_gain = parseFloat(row.median_peak_gain || 0);
  const trimmed_mean_peak_gain = parseFloat(row.trimmed_mean_peak_gain || row.avg_peak_gain || 0);

  return { winrate, ev, median_peak_gain, trimmed_mean_peak_gain };
}

/**
 * Get rolling statistics for bot activity (last 24 hours)
 * Used for liquidity regime calculation
 * 
 * Uses bot_tx_breakdown (transaction counts per bot), NOT bot_tokens_breakdown
 * We measure activity (tx volume), not discovery (unique tokens)
 * 
 * Normalizes bot activity to baseline: premium_bot_activity / total_transactions
 * This prevents large token count growth from masquerading as activity
 */
async function getBotActivityStats(): Promise<{ mean: number; std: number }> {
  const MIN_SAMPLES = 30;
  
  const result = await query(`
    SELECT 
      COUNT(*)::integer as sample_count,
      -- Normalize bot activity: premium_bot_activity / total_transactions
      -- This prevents large token count growth from masquerading as activity
      COALESCE(
        AVG(
          CASE 
            WHEN total_transactions > 0 THEN 
              (COALESCE((bot_tx_breakdown->>'photon')::numeric, 0) + COALESCE((bot_tx_breakdown->>'trojan')::numeric, 0))::double precision / NULLIF(total_transactions, 0)
            ELSE 0
          END
        )::double precision,
        0
      ) as mean_premium_bots_ratio,
      COALESCE(
        STDDEV(
          CASE 
            WHEN total_transactions > 0 THEN 
              (COALESCE((bot_tx_breakdown->>'photon')::numeric, 0) + COALESCE((bot_tx_breakdown->>'trojan')::numeric, 0))::double precision / NULLIF(total_transactions, 0)
            ELSE 0
          END
        )::double precision,
        1
      ) as std_premium_bots_ratio
    FROM scans
    WHERE timestamp >= NOW() - INTERVAL '24 hours'
      AND bot_tx_breakdown IS NOT NULL
      AND total_transactions IS NOT NULL
  `);

  const row = result.rows[0] || {};
  const sampleCount = parseFloat(row.sample_count || 0);
  
  // Fallback gracefully instead of throwing
  if (sampleCount < MIN_SAMPLES) {
    logger.warn(`Insufficient samples for bot activity stats (${sampleCount}/${MIN_SAMPLES}). Using neutral fallback.`);
    return {
      mean: 0, // Neutral ratio
      std: 0.01, // Small std to avoid division issues
    };
  }
  
  return {
    mean: parseFloat(row.mean_premium_bots_ratio || 0),
    std: Math.max(0.01, parseFloat(row.std_premium_bots_ratio || 1)), // ensure std > 0
  };
}

/**
 * Get rolling statistics for microstructure metrics (last 24 hours)
 * Used for microstructure regime calculation
 * Uses log1p(buy_sell_ratio - 1) = ln(buy_sell_ratio) for better interpretation
 * Neutral ratio (1.0) maps to 0, making interpretation easier
 */
async function getMicrostructureStats(): Promise<{ 
  mean_price_change: number; 
  std_price_change: number;
  mean_log1p_buy_sell_ratio: number;
  std_log1p_buy_sell_ratio: number;
}> {
  const MIN_SAMPLES = 30;
  
  const result = await query(`
    SELECT 
      COUNT(*)::integer as sample_count,
      COALESCE(AVG(price_change_5m)::double precision, 0) as mean_price_change,
      COALESCE(STDDEV(price_change_5m)::double precision, 1) as std_price_change,
      -- Use log1p: ln(1 + (buy_sell_ratio - 1)) = ln(buy_sell_ratio)
      -- This handles edge cases better and neutral (1.0) maps to 0
      COALESCE(AVG(LN(GREATEST(buy_sell_ratio, 0.01)))::double precision, 0) as mean_log1p_buy_sell_ratio,
      COALESCE(STDDEV(LN(GREATEST(buy_sell_ratio, 0.01)))::double precision, 1) as std_log1p_buy_sell_ratio
    FROM scanned_tokens st
    WHERE st.created_at >= NOW() - INTERVAL '24 hours'
      AND st.price_change_5m IS NOT NULL
      AND st.buy_sell_ratio IS NOT NULL
      AND st.buy_sell_ratio > 0
      AND st.chain = 'SOLANA'
  `);

  const row = result.rows[0] || {};
  const sampleCount = parseFloat(row.sample_count || 0);

  // Fallback gracefully instead of throwing
  if (sampleCount < MIN_SAMPLES) {
    logger.warn(`Insufficient samples for microstructure stats (${sampleCount}/${MIN_SAMPLES}). Using neutral fallback.`);
    return {
      mean_price_change: 0,
      std_price_change: 1,
      mean_log1p_buy_sell_ratio: 0, // log(1) = 0
      std_log1p_buy_sell_ratio: 1,
    };
  }
  
  return {
    mean_price_change: parseFloat(row.mean_price_change || 0),
    std_price_change: Math.max(0.01, parseFloat(row.std_price_change || 1)), // ensure std > 0
    mean_log1p_buy_sell_ratio: parseFloat(row.mean_log1p_buy_sell_ratio || 0),
    std_log1p_buy_sell_ratio: Math.max(0.01, parseFloat(row.std_log1p_buy_sell_ratio || 1)),
  };
}

/**
 * Calculate microstructure metrics from recent tokens
 * This shows whether breakout or mean-reversion strategies are working
 * Returns z-score normalized value with EWMA smoothing
 * Uses log1p(buy_sell_ratio - 1) for better interpretation
 * Applies short EWMA (α ≈ 0.3) to price_change_5m to reduce noise
 */
async function calculateMicrostructureMetrics(): Promise<number> {
  const result = await query(`
    SELECT 
      COALESCE(AVG(price_change_5m)::double precision, 0) as avg_first_5m_return,
      COALESCE(AVG(LN(GREATEST(buy_sell_ratio, 0.01)))::double precision, 0) as avg_log1p_buyer_imbalance
    FROM scanned_tokens st
    WHERE st.created_at >= NOW() - INTERVAL '1 hour'
      AND st.price_change_5m IS NOT NULL
      AND st.buy_sell_ratio IS NOT NULL
      AND st.buy_sell_ratio > 0
      AND st.chain = 'SOLANA'
  `);

  const row = result.rows[0];
  
  if (!row) {
    return 0; // neutral default
  }

  const first5mReturn = parseFloat(row.avg_first_5m_return || 0);
  const log1pBuyerImbalance = parseFloat(row.avg_log1p_buyer_imbalance || 0); // log(1) = 0
  
  // Get rolling statistics for proper z-score calculation
  const stats = await getMicrostructureStats();
  
  // Apply EWMA smoothing to raw price_change (reduce noise)
  // Track raw price change separately from micro_score to avoid mixing concerns
  let smoothedPriceChange = first5mReturn;
  if (ewmaState && ewmaState.ewma_price_change_5m !== undefined) {
    // Use separate EWMA for raw price change (not mixed with micro_score)
    smoothedPriceChange = EWMA_ALPHA * first5mReturn + (1 - EWMA_ALPHA) * ewmaState.ewma_price_change_5m;
  }
  
  // Calculate z-scores for both metrics (using mean/std for microstructure - could be improved with robust stats)
  const z_price_change = (smoothedPriceChange - stats.mean_price_change) / Math.max(0.01, stats.std_price_change);
  const z_price_change_capped = Math.max(-4, Math.min(4, z_price_change));
  const z_log_buyer_imbalance = (log1pBuyerImbalance - stats.mean_log1p_buy_sell_ratio) / Math.max(0.01, stats.std_log1p_buy_sell_ratio);
  const z_log_buyer_imbalance_capped = Math.max(-4, Math.min(4, z_log_buyer_imbalance));
  
  // Combine: positive = breakout regime, negative = mean reversion regime
  // Weight price change more heavily (70%) than buyer imbalance (30%)
  const rawScore = (z_price_change_capped * 0.7) + (z_log_buyer_imbalance_capped * 0.3);
  
  // Apply EWMA smoothing to final score (hysteresis to prevent flip-flopping)
  if (ewmaState) {
    return EWMA_ALPHA * rawScore + (1 - EWMA_ALPHA) * ewmaState.micro_score;
  }
  
  return rawScore;
}

/**
 * A. TREND REGIME
 * Is SOL trending up/down/choppy?
 * Uses robust z-scores (median/MAD only)
 */
function calculateTrendScore(
  sol_ret_5m: number,
  sol_ret_15m: number,
  sol_ret_1h: number,
  sol_trend_strength: number,
  stats: any
): number {
  const z_ret_5m = calculateRobustZScore(sol_ret_5m, stats.median_ret_5m, stats.mad_ret_5m);
  const z_ret_15m = calculateRobustZScore(sol_ret_15m, stats.median_ret_15m, stats.mad_ret_15m);
  const z_ret_1h = calculateRobustZScore(sol_ret_1h, stats.median_ret_1h, stats.mad_ret_1h);
  const z_trend = calculateRobustZScore(sol_trend_strength, stats.median_trend_strength, stats.mad_trend_strength);

  // Weighted combination
  return 0.4 * z_ret_5m + 0.3 * z_ret_15m + 0.2 * z_ret_1h + 0.1 * z_trend;
}

/**
 * Classify trend regime using fixed thresholds
 * 
 * Thresholds can be tuned based on historical data distribution.
 * For percentile-based classification, calculate percentiles from historical scores
 * and adjust thresholds accordingly.
 */
export function classifyTrendRegime(trend_score: number): string {
  if (trend_score > 0.7) return 'RISK_ON_TREND_UP';
  if (trend_score < -0.7) return 'RISK_OFF_TREND_DOWN';
  if (Math.abs(trend_score) < 0.3) return 'CHOPPY_RANGING';
  return 'NEUTRAL';
}

/**
 * B. ACTIVITY/LIQUIDITY REGIME
 * Is the bot-scalper environment active?
 * Uses proper z-score normalization with rolling statistics
 */
async function calculateLiquidityScore(
  total_transactions: number,
  tokens_found: number,
  bot_breakdown: any,
  stats: any
): Promise<number> {
  const z_total_tx = calculateRobustZScore(total_transactions, stats.median_total_tx, stats.mad_total_tx);
  const z_tokens_found = calculateRobustZScore(tokens_found, stats.median_tokens_found, stats.mad_tokens_found);

  // Extract premium bot activity (Photon + Trojan are most reliable)
  // Normalize to total_transactions to prevent large token count growth from masquerading as activity
  let premium_bot_activity_ratio = 0;
  if (bot_breakdown && total_transactions > 0) {
    const photon = bot_breakdown.photon || bot_breakdown.Photon || 0;
    const trojan = bot_breakdown.trojan || bot_breakdown.Trojan || 0;
    premium_bot_activity_ratio = (photon + trojan) / total_transactions;
  }

  // Get rolling statistics for normalized premium bot activity
  // Note: Using mean/std for bot activity ratio (0-1 range) rather than median/MAD
  // This is acceptable since ratios are bounded and less heavy-tailed than raw counts
  // If needed in future, can switch to robust stats for bot activity
  const botStats = await getBotActivityStats();
  const z_premium = (premium_bot_activity_ratio - botStats.mean) / Math.max(0.01, botStats.std);
  const z_premium_capped = Math.max(-4, Math.min(4, z_premium));

  // Weighted combination: total transactions (40%), tokens found (30%), premium bots (30%)
  return (z_total_tx * 0.4) + (z_tokens_found * 0.3) + (z_premium_capped * 0.3);
}

/**
 * Classify liquidity regime using fixed thresholds
 * 
 * Thresholds can be tuned based on historical data distribution.
 */
export function classifyLiquidityRegime(liquidity_score: number): string {
  if (liquidity_score > 0.7) return 'HIGH_ACTIVITY';
  if (liquidity_score < -0.7) return 'LOW_ACTIVITY';
  return 'NORMAL_ACTIVITY';
}

/**
 * C. RISK REGIME
 * What % of tokens are pumping vs dumping?
 * Uses median_peak_gain for classification (more robust to outliers)
 */
export function classifyRiskRegime(
  market_winrate: number, 
  market_ev: number,
  median_peak_gain?: number
): string {
  // Use median if available (more robust), otherwise fall back to EV
  const evMetric = median_peak_gain !== undefined ? median_peak_gain : market_ev;
  
  // Win rate threshold: 65% (most tokens hit TP1 at +15%)
  // EV threshold: 8% (median/trimmed_mean peak_gain across all tokens)
  if (market_winrate > 0.65 && evMetric > 8) {
    return 'FAVORABLE_PUMP_DAY';
  }
  // Risk-off: <30% win rate AND low EV (<3%)
  if (market_winrate < 0.30 && evMetric < 3) {
    return 'RISK_OFF_DUMP_DAY';
  }
  // Slight edge: >50% win rate (more winners than losers)
  if (market_winrate > 0.50) {
    return 'NORMAL_SLIGHT_EDGE';
  }
  return 'NORMAL_NEUTRAL';
}

/**
 * D. MICROSTRUCTURE REGIME
 * Are breakouts or pullbacks working better?
 */
export function classifyMicroRegime(micro_score: number): string {
  if (micro_score > 0.7) return 'BREAKOUT_FRIENDLY';
  if (micro_score < -0.7) return 'MEAN_REVERSION';
  return 'MIXED';
}

/**
 * Calculate global regime as a weighted numeric score
 * Returns a score that can be mapped to labels or used for continuous decision-making
 * @param trend_score Normalized trend score
 * @param liquidity_score Normalized liquidity score
 * @param risk_score Normalized risk score (0-1)
 * @param micro_score Normalized microstructure score
 * @param weights Optional weights for each component (default: equal weights)
 */
export function calculateGlobalRegimeScore(
  trend_score: number,
  liquidity_score: number,
  risk_score: number,
  micro_score: number,
  weights: { trend?: number; liquidity?: number; risk?: number; micro?: number } = {}
): number {
  // Default weights: trend and risk are most important
  const w_trend = weights.trend ?? 0.3;
  const w_liquidity = weights.liquidity ?? 0.2;
  const w_risk = weights.risk ?? 0.3;
  const w_micro = weights.micro ?? 0.2;
  
  // Normalize risk_score from [0,1] to [-1,1] range for consistency
  const risk_normalized = (risk_score - 0.5) * 2;
  
  // Calculate weighted score
  return (
    w_trend * trend_score +
    w_liquidity * liquidity_score +
    w_risk * risk_normalized +
    w_micro * micro_score
  );
}

/**
 * GLOBAL REGIME
 * Combine all 4 regimes into a single actionable state
 * 
 * This function is deterministic and can be calculated on-the-fly from the 4 individual regimes.
 * No need to store in database - calculate when needed.
 * 
 * Can use either rule-based classification (default) or weighted numeric score (see calculateGlobalRegimeScore)
 */
export function classifyGlobalRegime(
  trend_regime: string,
  liquidity_regime: string,
  risk_regime: string,
  micro_regime: string
): string {
  // Perfect storm - everything aligned for bull
  if (
    trend_regime.includes('RISK_ON') &&
    liquidity_regime === 'HIGH_ACTIVITY' &&
    risk_regime.includes('FAVORABLE')
  ) {
    return 'BULL_ACCELERATION';
  }

  // Strong bull but volatile
  if (
    trend_regime.includes('RISK_ON') &&
    risk_regime.includes('FAVORABLE')
  ) {
    return 'BULL_ACTIVE';
  }

  // Good risk environment but choppy
  if (
    risk_regime.includes('FAVORABLE') &&
    trend_regime === 'CHOPPY_RANGING'
  ) {
    return 'SELECTIVE_OPPORTUNITIES';
  }

  // Bear or risk-off
  if (
    trend_regime.includes('RISK_OFF') ||
    risk_regime.includes('RISK_OFF')
  ) {
    return 'AVOID_TRADES';
  }

  // Low activity
  if (liquidity_regime === 'LOW_ACTIVITY') {
    return 'LOW_ACTIVITY';
  }

  // Choppy with normal risk
  if (trend_regime === 'CHOPPY_RANGING') {
    return 'CHOPPY_MARKET';
  }

  // Default neutral
  return 'NEUTRAL_MARKET';
}

/**
 * Main function: Detect current market regime
 */
export async function detectRegime(scanData: {
  sol_ret_5m: number;
  sol_ret_15m: number;
  sol_ret_1h: number;
  sol_ret_6h: number;
  sol_volatility_1h: number;
  sol_volatility_24h: number;
  sol_trend_strength: number;
  total_transactions: number;
  tokens_found: number;
  bot_breakdown: any;
}): Promise<RegimeData> {
  try {
    // Get rolling statistics for z-score calculation
    const stats = await getRollingStats();

    // Calculate market risk metrics (with robust statistics)
    const riskMetrics = await calculateMarketRiskMetrics();

    // Calculate raw regime scores
    const raw_trend_score = calculateTrendScore(
      scanData.sol_ret_5m,
      scanData.sol_ret_15m,
      scanData.sol_ret_1h,
      scanData.sol_trend_strength,
      stats
    );

    const raw_liquidity_score = await calculateLiquidityScore(
      scanData.total_transactions,
      scanData.tokens_found,
      scanData.bot_breakdown,
      stats
    );

    // Calculate microstructure score (already applies EWMA internally)
    const raw_micro_score = await calculateMicrostructureMetrics();

    // Apply EWMA smoothing to trend and liquidity scores (hysteresis to prevent flip-flopping)
    let trend_score = raw_trend_score;
    let liquidity_score = raw_liquidity_score;
    let micro_score = raw_micro_score;
    
    if (ewmaState) {
      trend_score = EWMA_ALPHA * raw_trend_score + (1 - EWMA_ALPHA) * ewmaState.trend_score;
      liquidity_score = EWMA_ALPHA * raw_liquidity_score + (1 - EWMA_ALPHA) * ewmaState.liquidity_score;
      // micro_score already smoothed in calculateMicrostructureMetrics
    }
    
    // Update EWMA state for next iteration
    // Initialize ewma_price_change_5m on first run or update it
    const rawPriceChange = scanData.sol_ret_5m || 0; // Use 5m return as proxy for price change
    const ewmaPriceChange = ewmaState?.ewma_price_change_5m !== undefined
      ? EWMA_ALPHA * rawPriceChange + (1 - EWMA_ALPHA) * ewmaState.ewma_price_change_5m
      : rawPriceChange; // Initialize to raw value on first run
    
    ewmaState = {
      trend_score,
      liquidity_score,
      micro_score,
      ewma_price_change_5m: ewmaPriceChange,
      last_update: new Date(),
    };

    const risk_score = riskMetrics.winrate; // Already normalized 0-1

    // Classify each regime
    const trend_regime = classifyTrendRegime(trend_score);
    const liquidity_regime = classifyLiquidityRegime(liquidity_score);
    const risk_regime = classifyRiskRegime(
      riskMetrics.winrate, 
      riskMetrics.ev,
      riskMetrics.median_peak_gain
    );
    const micro_regime = classifyMicroRegime(micro_score);

    // Calculate global regime score (weighted numeric)
    const global_regime_score = calculateGlobalRegimeScore(
      trend_score,
      liquidity_score,
      risk_score,
      micro_score,
      {
        trend: 0.3,
        liquidity: 0.2,
        risk: 0.3,
        micro: 0.2,
      }
    );
    
    // Determine global regime (rule-based classification)
    const global_regime = classifyGlobalRegime(
      trend_regime,
      liquidity_regime,
      risk_regime,
      micro_regime
    );

    const regimeData: RegimeData = {
      scores: {
        trend_score: Number(trend_score.toFixed(2)),
        liquidity_score: Number(liquidity_score.toFixed(2)),
        risk_score: Number(risk_score.toFixed(2)),
        micro_score: Number(micro_score.toFixed(2)),
      },
      classifications: {
        trend_regime,
        liquidity_regime,
        risk_regime,
        micro_regime,
        global_regime,
      },
      global_regime_score: Number(global_regime_score.toFixed(2)),
      metadata: {
        sol_ret_1h: scanData.sol_ret_1h,
        sol_ret_6h: scanData.sol_ret_6h,
        sol_volatility_1h: scanData.sol_volatility_1h,
        sol_trend_strength: scanData.sol_trend_strength,
        total_transactions: scanData.total_transactions,
        tokens_found: scanData.tokens_found,
        market_winrate_1h: riskMetrics.winrate,
        market_ev_1h: riskMetrics.ev,
        median_peak_gain: riskMetrics.median_peak_gain,
        trimmed_mean_peak_gain: riskMetrics.trimmed_mean_peak_gain,
      },
      timestamp: new Date(),
    };

    // Debug logging removed for performance (can be enabled if needed)
    // logger.info(`🎯 Regime detected: ${global_regime} | Trend: ${trend_regime} | Liquidity: ${liquidity_regime} | Risk: ${risk_regime}`);

    return regimeData;
  } catch (error) {
    logger.error('Failed to detect regime:', error);
    
    // Return neutral regime on error
    return {
      scores: {
        trend_score: 0,
        liquidity_score: 0,
        risk_score: 0.5,
        micro_score: 0,
      },
      classifications: {
        trend_regime: 'NEUTRAL',
        liquidity_regime: 'NORMAL_ACTIVITY',
        risk_regime: 'NORMAL_NEUTRAL',
        micro_regime: 'MIXED',
        global_regime: 'NEUTRAL_MARKET',
      },
      metadata: {
        sol_ret_1h: scanData.sol_ret_1h,
        sol_ret_6h: scanData.sol_ret_6h,
        sol_volatility_1h: scanData.sol_volatility_1h,
        sol_trend_strength: scanData.sol_trend_strength,
        total_transactions: scanData.total_transactions,
        tokens_found: scanData.tokens_found,
      },
      timestamp: new Date(),
    };
  }
}

/**
 * Get regime-based trading parameters
 * Adjusts position size, TP/SL based on regime
 * 
 * ⚠️ DISPLAY ONLY - This function is for analytics/display purposes only.
 * These parameters are NOT used in actual trading logic.
 */
export function getRegimeAdjustedParameters(global_regime: string): {
  position_size_multiplier: number;
  tp_levels: number[];
  sl_percent: number;
  entry_threshold_adjustment: number;
} {
  // BULL_ACCELERATION - most aggressive
  if (global_regime.includes('BULL_ACCELERATION')) {
    return {
      position_size_multiplier: 1.5, // 1.5x normal position
      tp_levels: [20, 40, 60],
      sl_percent: -25,
      entry_threshold_adjustment: -5, // Lower threshold (more trades)
    };
  }

  // BULL_ACTIVE - normal aggressive
  if (global_regime.includes('BULL_ACTIVE')) {
    return {
      position_size_multiplier: 1.25,
      tp_levels: [15, 30, 45],
      sl_percent: -30,
      entry_threshold_adjustment: 0,
    };
  }

  // SELECTIVE_OPPORTUNITIES - cautious
  if (global_regime.includes('SELECTIVE')) {
    return {
      position_size_multiplier: 0.75,
      tp_levels: [15, 30, 45],
      sl_percent: -35,
      entry_threshold_adjustment: +5, // Higher threshold (fewer trades)
    };
  }

  // AVOID_TRADES - defensive
  if (global_regime.includes('AVOID')) {
    return {
      position_size_multiplier: 0.25, // Very small or skip
      tp_levels: [10, 20, 30],
      sl_percent: -10,
      entry_threshold_adjustment: +15, // Much higher threshold
    };
  }

  // CHOPPY_MARKET - scalp only strategy
  if (global_regime.includes('CHOPPY_MARKET')) {
    return {
      position_size_multiplier: 0.5,
      tp_levels: [10, 20, 30],
      sl_percent: -15,
      entry_threshold_adjustment: +10,
    };
  }

  // LOW_ACTIVITY - wait
  if (global_regime.includes('LOW_ACTIVITY')) {
    return {
      position_size_multiplier: 0.5,
      tp_levels: [15, 30, 45],
      sl_percent: -35,
      entry_threshold_adjustment: +10,
    };
  }

  // NEUTRAL_MARKET - standard strategy
  return {
    position_size_multiplier: 1.0,
    tp_levels: [15, 30, 45],
    sl_percent: -35,
    entry_threshold_adjustment: 0,
  };
}

/**
 * Format regime label for display (converts UPPER_SNAKE_CASE to readable format)
 */
export function formatRegimeLabel(label: string): string {
  return label
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/Risk On/g, 'Risk-On')
    .replace(/Risk Off/g, 'Risk-Off')
    .replace(/Breakout Friendly/g, 'Breakout-Friendly')
    .replace(/Mean Reversion/g, 'Mean-Reversion');
}

/**
 * Format regime for display (for analytics UI and Telegram)
 */
export function formatRegimeCard(regimeData: RegimeData): string {
  const { scores, classifications, metadata } = regimeData;
  const time = regimeData.timestamp.toISOString().substring(11, 16);

  return `
🎯 MARKET REGIME (${time} UTC)

Trend:          ${formatRegimeLabel(classifications.trend_regime)} (score ${scores.trend_score > 0 ? '+' : ''}${scores.trend_score.toFixed(2)})
Liquidity:      ${formatRegimeLabel(classifications.liquidity_regime)} (score ${scores.liquidity_score > 0 ? '+' : ''}${scores.liquidity_score.toFixed(2)})
Market Risk:    ${formatRegimeLabel(classifications.risk_regime)} (winrate ${(metadata.market_winrate_1h! * 100).toFixed(1)}%)
Microstructure: ${formatRegimeLabel(classifications.micro_regime)}

Global Regime:  ${formatRegimeLabel(classifications.global_regime)}

📊 SOL Context:
  • 1h Return: ${metadata.sol_ret_1h > 0 ? '+' : ''}${metadata.sol_ret_1h.toFixed(2)}%
  • 6h Return: ${metadata.sol_ret_6h > 0 ? '+' : ''}${metadata.sol_ret_6h.toFixed(2)}%
  • Volatility: ${metadata.sol_volatility_1h.toFixed(3)}%
  • Trend Strength: ${metadata.sol_trend_strength.toFixed(2)}

🔍 Activity:
  • Tokens Found: ${metadata.tokens_found}
  • Total Transactions: ${metadata.total_transactions}
  `.trim();
}

