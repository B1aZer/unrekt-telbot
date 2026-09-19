/**
 * Scoring Configuration
 * 
 * Centralized configuration for all scoring systems.
 * Allows experimentation in backtest and production via environment variables.
 * Every default here is a neutral 1; set your own weights through the environment.
 */

export interface SelectionScoreWeights {
  botCount: number;
  volume24h: number;
  buyVsSellRatio: number;
  riskScore: number;
  uniqueUsers: number;
  ageHours: number;
}

export interface PointBasedScoreWeights {
  // Category totals (these are the main weights to experiment with)
  fundamentals: number;   // Age + Buy/Sell
  marketData: number;   // Market cap + Liquidity + Holders
  activity: number;   // Bot activity
  safety: number;   // Risk
  timing: number;   // Momentum
  
  // DEPRECATED: Internal breakdowns - NOT USED in new scoring structure
  // New scoring functions return points directly without scaling
  // Kept for backwards compatibility only - can be safely ignored
  fundamentals_marketCap: number;   // DEPRECATED - not used
  fundamentals_age: number;         // DEPRECATED - not used
  fundamentals_liquidity: number;  // DEPRECATED - not used
  fundamentals_holders: number;    // DEPRECATED - not used
  
  activity_botBuys: number;        // DEPRECATED - not used
  activity_volume: number;         // DEPRECATED - not used
  activity_uniqueBuyers: number;   // DEPRECATED - not used
  activity_buyRatio: number;       // DEPRECATED - not used
  
  safety_riskScore: number;        // DEPRECATED - not used
  safety_security: number;         // DEPRECATED - not used
  
  timing_volumeVelocity: number;   // DEPRECATED - not used
}

/**
 * Load selection score weights from environment or use defaults
 */
export function getSelectionScoreWeights(): SelectionScoreWeights {
  return {
    botCount: parseFloat(process.env.SELECTION_WEIGHT_BOT_COUNT || '1'),
    volume24h: parseFloat(process.env.SELECTION_WEIGHT_VOLUME_24H || '1'),
    buyVsSellRatio: parseFloat(process.env.SELECTION_WEIGHT_BUY_SELL_RATIO || '1'),
    riskScore: parseFloat(process.env.SELECTION_WEIGHT_RISK_SCORE || '1'),
    uniqueUsers: parseFloat(process.env.SELECTION_WEIGHT_UNIQUE_USERS || '1'),
    ageHours: parseFloat(process.env.SELECTION_WEIGHT_AGE_HOURS || '1'),
  };
}

/**
 * Load point-based score weights from environment or use defaults
 */
export function getPointBasedScoreWeights(): PointBasedScoreWeights {
  return {
    // Category totals
    fundamentals: parseFloat(process.env.POINT_WEIGHT_FUNDAMENTALS || '1'),
    marketData: parseFloat(process.env.POINT_WEIGHT_MARKET_DATA || '1'),
    activity: parseFloat(process.env.POINT_WEIGHT_ACTIVITY || '1'),
    safety: parseFloat(process.env.POINT_WEIGHT_SAFETY || '1'),
    timing: parseFloat(process.env.POINT_WEIGHT_TIMING || '1'),
    
    // Fundamentals breakdown
    fundamentals_marketCap: parseFloat(process.env.POINT_WEIGHT_MARKET_CAP || '1'),
    fundamentals_age: parseFloat(process.env.POINT_WEIGHT_AGE || '1'),
    fundamentals_liquidity: parseFloat(process.env.POINT_WEIGHT_LIQUIDITY || '1'),
    fundamentals_holders: parseFloat(process.env.POINT_WEIGHT_HOLDERS || '1'),
    
    // Activity breakdown
    activity_botBuys: parseFloat(process.env.POINT_WEIGHT_BOT_BUYS || '1'),
    activity_volume: parseFloat(process.env.POINT_WEIGHT_VOLUME || '1'),
    activity_uniqueBuyers: parseFloat(process.env.POINT_WEIGHT_UNIQUE_BUYERS || '1'),
    activity_buyRatio: parseFloat(process.env.POINT_WEIGHT_BUY_RATIO || '1'),
    
    // Safety breakdown
    safety_riskScore: parseFloat(process.env.POINT_WEIGHT_RISK_SCORE || '1'),
    safety_security: parseFloat(process.env.POINT_WEIGHT_SECURITY || '1'),
    
    // Timing breakdown
    timing_volumeVelocity: parseFloat(process.env.POINT_WEIGHT_VOLUME_VELOCITY || '1'),
  };
}

/**
 * Calculate token selection score with configurable weights
 */
export function calculateTokenSelectionScore(
  params: {
    botCount: number;
    volume24h: number;
    buyVsSellRatio: number;
    riskScore: number;
    uniqueUsers: number;
    ageHours: number;
  },
  weights?: SelectionScoreWeights
): number {
  const w = weights || getSelectionScoreWeights();
  const { botCount, volume24h, buyVsSellRatio, riskScore, uniqueUsers, ageHours } = params;
  
  const score = (
    (botCount * w.botCount) +
    (Math.log10(volume24h + 1) * w.volume24h) +
    (buyVsSellRatio * w.buyVsSellRatio) +
    ((100 - riskScore) * w.riskScore) +
    (uniqueUsers * w.uniqueUsers) +
    (Math.log10(ageHours + 1) * w.ageHours)  // Logarithmic scaling (like volume) to prevent age from dominating
  );
  
  // Round to 2 decimal places to avoid floating point precision issues (e.g., 37.800000000000004 -> 37.80)
  return Math.round(score * 100) / 100;
}

