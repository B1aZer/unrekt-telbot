/**
 * Point-Based Token Analyzer (REBALANCED - CORRELATION-DRIVEN)
 * 
 * Strategy C (Hybrid): Balanced between correlation strength and range effects
 * Based on 9,259 tokens with peak gain correlation analysis
 * 
 * VERSION: v2.5-fundamentals-market-focus
 * 
 * Key Findings:
 * - Volume Decay (6h→24h): +0.2132 correlation (BEST PREDICTOR!)
 * - Age: -0.0252 correlation (weak) BUT range effect 4X (<6h vs 48-72h)
 * - Buy/Sell: -0.0037 correlation (zero) BUT range effect 3X (1.5-2.0 vs <0.5)
 * - Market Cap: Moved from hard stop to scoring preference (allows tracking all tokens)
 * 
 * Rebalanced Distribution (v2.5):
 * - Fundamentals: 35 points (age 15 + buy/sell 20 - range effects validated) - INCREASED from 25
 * - Market Data: 35 points (market cap 30 pts for 100-200k target, liquidity 3 pts, holders 2 pts) - INCREASED from 25
 * - Timing: 15 points (volume decay focused - BEST predictor) - REDUCED from 25
 * - Activity: 10 points (bot buys 10 - unique_buyers removed, 98% correlated) - REDUCED from 15
 * - Safety: 5 points (risk 30-50 = +50% gain sweet spot) - REDUCED from 10
 * 
 * Market Cap Strategy:
 * - Target range: $100K-$200K (30 points max - highest weight)
 * - No hard stop: All tokens tracked for peak gain analysis
 * - Strong preference signal: Market cap now 30% of total score
 * 
 * Total: 0-100 points
 * Threshold: 65+ = BUY (reduced from 70 to account for rebalancing)
 */

import { logger } from '../utils/logger';
import { getPointBasedScoreWeights, type PointBasedScoreWeights } from '../utils/scoring-config';
import { getStrategyInfo } from '../config/strategy';

// Define a simplified token interface for scoring
interface ScannedToken {
  token_address: string;
  symbol: string;
  name: string;
  chain: string;
  price_usd: number;
  market_cap: number;
  liquidity_usd: number;
  volume_5m: number;
  volume_24h: number;
  volume_1h?: number;  // For volume decay calculation
  volume_6h?: number;  // For volume decay calculation
  price_change_24h: number;
  holders: number;
  age_hours: number;
  bot_buys: number;
  bot_sells: number;
  buy_sell_ratio: number;
  unique_buyers: number;
  risk_score: number;
  is_honeypot: boolean;
  has_mint_authority: boolean;
  has_freeze_authority: boolean;
}

export interface TokenScore {
  totalScore: number;  // 0-100
      breakdown: {
        fundamentals: number;  // 0-35
        marketData: number;     // 0-35
        activity: number;      // 0-10
        safety: number;        // 0-5
        timing: number;        // 0-15
      };
  decision: 'BUY' | 'SKIP';
  confidence: number;
  reasoning: string;
  details: {
    marketCapScore: number;
    ageScore: number;
    liquidityScore: number;
    holderScore: number;
    botBuysScore: number;
    buyRatioScore: number;
    volumeScore: number;
    uniqueBuyersScore: number;
    riskScore: number;
    securityScore: number;
    timingScore: number;
  };
}

export class PointBasedAnalyzer {
  private minScoreThreshold: number;
  private weights: PointBasedScoreWeights;

  constructor(weights?: PointBasedScoreWeights) {
    this.minScoreThreshold = parseFloat(process.env.POINT_BASED_MIN_SCORE || '65');
    this.weights = weights || getPointBasedScoreWeights();
    const strategyInfo = getStrategyInfo();
    logger.info(`📊 Point-Based Analyzer initialized (strategy: ${strategyInfo.version}, min score: ${this.minScoreThreshold})`);
  }

  /**
   * Analyze token and return score with decision
   */
  analyze(token: ScannedToken): TokenScore {
    // Log data availability and missing fields
    this.logDataAvailability(token);

    // REBALANCED STRATEGY C (Hybrid): Correlation + Range Effects
    // Fundamentals (35): Age 15 + Buy/Sell 20 (range effects 3-4X) - INCREASED from 25
    // Market Data (35): Market cap 30 pts (100-200k target) + liquidity 3 pts + holders 2 pts - INCREASED from 25
    // Timing (15): Volume decay (BEST predictor +0.2132) - REDUCED from 25
    // Activity (10): Bot buys 10 (unique_buyers removed - 98% correlated) - REDUCED from 15
    // Safety (5): Risk 30-50 = sweet spot (+50% gain) - REDUCED from 10
    const fundamentals = this.scoreFundamentals(token);      // 35 pts max
    const marketData = this.scoreMarketData(token);          // 35 pts max
    const activity = this.scoreActivity(token);              // 10 pts max
    const safety = this.scoreSafety(token);                  // 5 pts max
    const timing = this.scoreTiming(token);                  // 15 pts max

    // No scaling needed - functions return points directly based on configured weights
    const totalScore = fundamentals.total + marketData.total + activity.total + safety.total + timing.total;
    const decision = totalScore >= this.minScoreThreshold ? 'BUY' : 'SKIP';

    // Log detailed scoring breakdown
    this.logScoringBreakdown(token, {
      fundamentals,
      marketData,
      activity,
      safety,
      timing,
      totalScore,
      decision,
    });

    return {
      totalScore,
      breakdown: {
        fundamentals: fundamentals.total,
        marketData: marketData.total,
        activity: activity.total,
        safety: safety.total,
        timing: timing.total,
      },
      decision,
      confidence: totalScore,
      reasoning: this.generateReasoning(token, {
        fundamentals: fundamentals.total,
        marketData: marketData.total,
        activity: activity.total,
        safety: safety.total,
        timing: timing.total,
      }, totalScore),
      details: {
        marketCapScore: marketData.marketCap,
        ageScore: fundamentals.age,
        liquidityScore: marketData.liquidity,
        holderScore: marketData.holders,
        botBuysScore: activity.total,
        buyRatioScore: fundamentals.buyRatio,
        volumeScore: 0,
        uniqueBuyersScore: 0,
        riskScore: safety.total,
        securityScore: 0,
        timingScore: timing.total,
      },
    };
  }

  /**
   * Score fundamentals (35 points max) - INCREASED from 25 pts
   * Age correlation: -0.0252 (weak) BUT <6h = +51% vs 48-72h = +12% (4X!)
   * Buy/Sell correlation: -0.0037 (zero) BUT 1.5-2.0 = +47% vs <0.5 = +16% (3X!)
   */
  private scoreFundamentals(token: ScannedToken): {
    total: number;
    age: number;
    buyRatio: number;
    marketCap: number;
    liquidity: number;
    holders: number;
  } {
    let age = 0;
    let buyRatio = 0;

    // Age (up to 15 pts) - Round numbers
    const ageHours = token.age_hours || 0;
    if (ageHours < 6) {
      age = 15;    // <6h = MAX (ultra fresh)
    } else if (ageHours < 24) {
      age = 12;    // 6-24h = very good
    } else if (ageHours < 48) {
      age = 8;     // 24-48h = decent
    } else if (ageHours < 72) {
      age = 3;     // 48-72h = WORST range
    } else if (ageHours < 168) {
      age = 6;     // 72h-7d = below average
    } else {
      age = 10;    // ≥7 days = established
    }

    // Buy/Sell Ratio (up to 20 pts) - Round numbers
    const ratio = token.buy_sell_ratio || 0;
    if (ratio >= 1.5 && ratio <= 2.0) {
      buyRatio = 20;   // 1.5-2.0 = OPTIMAL
    } else if (ratio >= 1.0 && ratio < 1.5) {
      buyRatio = 18;   // 1.0-1.5 = very good
    } else if (ratio >= 2.0 && ratio < 2.5) {
      buyRatio = 16;   // 2.0-2.5 = still very good
    } else if (ratio >= 2.5 && ratio < 3.0) {
      buyRatio = 12;   // 2.5-3.0 = decent
    } else if (ratio >= 3.0) {
      buyRatio = 6;    // >3.0 = lower win rate
    } else if (ratio >= 0.8 && ratio < 1.0) {
      buyRatio = 10;   // 0.8-1.0 = below sweet spot
    } else if (ratio >= 0.5 && ratio < 0.8) {
      buyRatio = 6;    // 0.5-0.8 = below average
    } else {
      buyRatio = 0;    // <0.5 = very low win rate
    }

    const total = age + buyRatio;  // Max 35 pts (15+20)

    return { total, age, buyRatio, marketCap: 0, liquidity: 0, holders: 0 };
  }

  /**
   * Score market data (35 points max) - INCREASED from 25 pts
   * Market cap now has highest weight (30 pts) as preference signal (not hard stop)
   * Target range: $100K-$200K market cap (sweet spot)
   * Sweet spots validated: $50K-$100K mcap = +38%, $10K-$20K liq = +37%
   */
  private scoreMarketData(token: ScannedToken): {
    total: number;
    marketCap: number;
    liquidity: number;
    holders: number;
  } {
    let marketCap = 0;
    let liquidity = 0;
    let holders = 0;

    // Market cap (30 points max) - INCREASED from 28 pts
    // Target range: $100K-$200K (sweet spot), extended good range $50K-$250K
    // This allows tracking all tokens for peak gain analysis while strongly preferring optimal range
    const mc = token.market_cap || 0;
    if (mc >= 100000 && mc <= 200000) {
      marketCap = 30;   // $100K-$200K = SWEET SPOT (max points)
    } else if (mc >= 50000 && mc < 100000) {
      marketCap = 22;   // $50K-$100K = good
    } else if (mc >= 200000 && mc < 250000) {
      marketCap = 22;   // $200K-$250K = good (extended range)
    } else if (mc >= 250000 && mc < 500000) {
      marketCap = 18;   // $250K-$500K = acceptable
    } else if (mc >= 20000 && mc < 50000) {
      marketCap = 12;   // $20K-$50K = below target
    } else if (mc >= 500000 && mc < 1000000) {
      marketCap = 6;    // $500K-$1M = below average
    } else if (mc >= 1000000) {
      marketCap = 3;    // $1M+ = lower gains
    } else {
      marketCap = 6;    // <$20K = too small but still tracked
    }

    // Liquidity (3 points max) - REDUCED from 4 pts
    // Sweet spot: $10K-$20K = +36.78%
    const liq = token.liquidity_usd || 0;
    if (liq >= 10000 && liq <= 20000) {
      liquidity = 3;    // $10K-$20K = SWEET SPOT (max points)
    } else if (liq >= 20000 && liq < 50000) {
      liquidity = 2;    // $20K-$50K = good
    } else if (liq >= 50000 && liq < 100000) {
      liquidity = 1;    // $50K-$100K = below average
    } else if (liq >= 100000) {
      liquidity = 1;    // $100K+ = lower gains
    } else if (liq >= 10000) {
      liquidity = 2;    // Just above hard stop
    }

    // Holders (2 points max) - REDUCED from 3 pts
    const holderCount = token.holders || 0;
    if (holderCount >= 500) {
      holders = 2;    // 500+ = max
    } else if (holderCount >= 200) {
      holders = 1;    // 200+
    } else if (holderCount >= 100) {
      holders = 1;    // 100+
    } else if (holderCount >= 50) {
      holders = 0;    // 50+ (no points)
    }

    const total = marketCap + liquidity + holders;  // Max 35 pts (30+3+2)

    return { total, marketCap, liquidity, holders };
  }

  /**
   * Score activity (10 points max) - REDUCED from 15 pts
   * Bot Buys correlation: +0.0678 (weak but positive)
   * NOTE: unique_buyers removed - it's 98% correlated with bot_buys (84% exactly equal)
   * Analysis shows winners: bot_buys 21.25, unique_users 21.15 (diff 0.1)
   * Losers: bot_buys 37.24, unique_users 36.69 (diff 0.55) - essentially the same metric
   */
  private scoreActivity(token: ScannedToken): {
    total: number;
    botBuys: number;
    buyRatio: number;
    volume: number;
    uniqueBuyers: number;
  } {
    let botBuys = 0;

    // Bot buys (10 points max) - INCREASED from 6 pts (removed unique_buyers redundancy)
    // Analysis shows bot_buys and unique_buyers are 98% correlated, so we use only bot_buys
    const bots = token.bot_buys || 0;
    if (bots >= 20) {
      botBuys = 10;   // 20+ bots = max
    } else if (bots >= 15) {
      botBuys = 8;    // 15-20
    } else if (bots >= 10) {
      botBuys = 6;    // 10-15
    } else if (bots >= 7) {
      botBuys = 5;    // 7-10
    } else if (bots >= 5) {
      botBuys = 4;    // 5-7
    } else if (bots >= 3) {
      botBuys = 2;    // 3-5
    } else {
      botBuys = 1;    // <3
    }

    const total = botBuys;  // Max 10 pts (consolidated from 6+4)

    return { total, botBuys, buyRatio: 0, volume: 0, uniqueBuyers: 0 };
  }

  /**
   * Score safety (5 points max) - REDUCED from 10 pts
   * Risk correlation: +0.0652 (weak but positive - risk/reward exists!)
   * Sweet spot validated: Risk 30-50 = +50.07% vs <20 = +25.80% (2X!)
   * This is INVERTED from typical risk scoring - moderate risk = BEST
   */
  private scoreSafety(token: ScannedToken): {
    total: number;
    risk: number;
    security: number;
  } {
    let score = 0;

    // Award points based on risk score (INVERTED - moderate risk = best)
    // Round numbers for 5 points max
    const riskScore = token.risk_score || 0;
    if (riskScore >= 30 && riskScore <= 50) {
      score = 5;   // SWEET SPOT: Moderate risk = +50.07% avg gain (MAX!)
    } else if (riskScore >= 20 && riskScore < 30) {
      score = 3;   // Low risk = +26.62% avg gain (below average)
    } else if (riskScore >= 50 && riskScore < 70) {
      score = 3;   // Risky = +30.16% avg gain (decent)
    } else if (riskScore < 20) {
      score = 2;   // Very safe = +25.80% avg gain (lowest!)
    } else if (riskScore >= 70) {
      score = 1;   // Very risky = +26.24% avg gain (filter some)
    }

    return { total: score, risk: score, security: 0 };
  }

  /**
   * Score timing (15 points max) - REDUCED from 25 pts
   * Volume decay (6h→24h) correlation: +0.2132 (BEST PREDICTOR!)
   * Volume 5m→1h decay: +0.1434
   * Volume 1h: +0.1272
   * Volume 5m: +0.1155
   * Volume 24h: -0.0513 (NEGATIVE - penalize high volume)
   */
  private scoreTiming(token: ScannedToken): {
    total: number;
  } {
    let score = 0;

    // Volume Decay 6h→24h (8 points max) - BEST PREDICTOR! (scaled from 12.5 to 15/25 ratio)
    // Higher ratio = more recent activity = better gains
    if (token.volume_6h && token.volume_24h && token.volume_24h > 0) {
      const decayRatio = token.volume_6h / token.volume_24h;
      // Normalize: 6h = 25% of 24h if evenly distributed (6/24 = 0.25)
      // Higher = more recent activity = GOOD
      if (decayRatio >= 0.5) {
        score += 8;     // 50%+ of 24h volume in last 6h = EXCELLENT
      } else if (decayRatio >= 0.35) {
        score += 6;     // 35-50% = very good
      } else if (decayRatio >= 0.25) {
        score += 5;     // 25-35% = good (normal distribution)
      } else if (decayRatio >= 0.15) {
        score += 3;     // 15-25% = moderate
      } else if (decayRatio >= 0.1) {
        score += 1;     // 10-15% = low
      }
      // <0.1 = very low recent activity, no points
    }

    // Volume Decay 5m→1h (3 points max) - Secondary decay metric
    if (token.volume_5m && token.volume_1h && token.volume_1h > 0) {
      const decayRatio = token.volume_5m / token.volume_1h;
      // Normalize: 5m = ~8.3% of 1h if evenly distributed (5/60 = 0.083)
      // Higher = more recent activity = GOOD
      if (decayRatio >= 0.15) {
        score += 3;     // 15%+ of 1h volume in last 5m = excellent
      } else if (decayRatio >= 0.12) {
        score += 2;     // 12-15% = very good
      } else if (decayRatio >= 0.08) {
        score += 2;     // 8-12% = good (normal)
      } else if (decayRatio >= 0.05) {
        score += 1;     // 5-8% = moderate
      }
    }

    // Volume 5m (2 points max) - Direct volume
    const vol5m = token.volume_5m || 0;
    if (vol5m >= 20000) {
      score += 2;     // $20K+ = max
    } else if (vol5m >= 10000) {
      score += 2;     // $10K+
    } else if (vol5m >= 5000) {
      score += 1;     // $5K+
    } else if (vol5m >= 2000) {
      score += 1;     // $2K+
    }

    // Volume 1h (2 points max) - Trend context
    const vol1h = token.volume_1h || 0;
    if (vol1h >= 100000) {
      score += 2;     // $100K+ = max
    } else if (vol1h >= 50000) {
      score += 2;     // $50K+
    } else if (vol1h >= 20000) {
      score += 1;     // $20K+
    }

    // PENALIZE HIGH 24H VOLUME (2 points max penalty) - NEGATIVE correlation
    // Very high 24h volume = established token with lower gains
    const vol24h = token.volume_24h || 0;
    if (vol24h >= 1000000) {
      score -= 2;     // $1M+ = strong penalty
    } else if (vol24h >= 500000) {
      score -= 2;     // $500K+ = moderate penalty
    } else if (vol24h >= 200000) {
      score -= 1;     // $200K+ = small penalty
    }

    // Cap at reasonable range (0 to 15)
    score = Math.max(0, Math.min(score, 15));

    return { total: score };
  }

  /**
   * OLD ACTIVITY SCORING - Kept for reference but not used
   */
  private scoreActivityOld(token: ScannedToken): {
    total: number;
    botBuys: number;
    buyRatio: number;
    volume: number;
    uniqueBuyers: number;
  } {
    let botBuys = 0;
    let buyRatio = 0;
    let volume = 0;
    let uniqueBuyers = 0;

    // Bot buys (15 points) - INCREASED! Strongest predictor (+43% correlation, 60.5% win rate at 15+)
    const bots = token.bot_buys || 0;
    if (bots >= 15) {
      botBuys = 15; // 15+ bots = 60.5% win rate, 46.4% avg gain!
    } else if (bots >= 10) {
      botBuys = 12; // 10-15 = 43.3% win rate
    } else if (bots >= 7) {
      botBuys = 9;  // 7-10 = decent activity
    } else if (bots >= 5) {
      botBuys = 6;  // 5-10 = 48.4% win rate
    } else if (bots >= 3) {
      botBuys = 3;  // 3-5 = 35.1% win rate (low)
    }

    // Volume 5m (15 points) - INCREASED! Data shows $20K+ = 59.3% win rate, 45.4% avg gain
    const vol = token.volume_5m || 0;
    if (vol >= 20000) {
      volume = 15; // $20K+ = 59.3% win rate, 45.4% avg gain!
    } else if (vol >= 10000) {
      volume = 12; // $10K-$20K = 50.2% win rate, 34.3% avg gain
    } else if (vol >= 5000) {
      volume = 9;  // $5K-$10K = 54.7% win rate, 30.2% avg gain
    } else if (vol >= 1000) {
      volume = 6;  // $1K-$5K = 47.2% win rate
    } else if (vol >= 500) {
      volume = 3;  // $500-$1K = lower win rate
    }

    // Unique users (10 points) - INCREASED! +43.9% correlation with profitability
    const users = token.unique_buyers || 0;
    if (users >= 50) {
      uniqueBuyers = 10; // 50+ users = strong community signal
    } else if (users >= 30) {
      uniqueBuyers = 8;  // 30+ = good
    } else if (users >= 20) {
      uniqueBuyers = 6;  // 20+ = decent
    } else if (users >= 10) {
      uniqueBuyers = 4;  // 10+ = minimal
    } else if (users >= 5) {
      uniqueBuyers = 2;  // 5+ = weak
    }

    // Buy/Sell ratio (5 points) - REDUCED! Data shows -19.8% correlation (inverse predictor!)
    // Higher ratio doesn't mean more profit. 1.2-2.0 range is best (55% win rate)
    const ratio = token.buy_sell_ratio || 0;
    if (ratio >= 1.2 && ratio <= 2.0) {
      buyRatio = 5; // 1.2-2.0 = sweet spot (55% win rate)
    } else if (ratio >= 1.5 && ratio <= 3.0) {
      buyRatio = 4; // Wider range, still decent
    } else if (ratio >= 1.1) {
      buyRatio = 3; // Slightly positive
    } else if (ratio >= 1.0) {
      buyRatio = 2; // Neutral
    }

    const total = botBuys + volume + uniqueBuyers + buyRatio;

    return { total, botBuys, buyRatio, volume, uniqueBuyers };
  }

  /**
   * Log data availability and missing fields
   */
  private logDataAvailability(token: ScannedToken): void {
    const missing: string[] = [];
    const warnings: string[] = [];

    // Check critical fields
    if (!token.market_cap || token.market_cap === 0) {
      missing.push('market_cap');
    }
    if (token.age_hours === null || token.age_hours === undefined) {
      missing.push('age_hours');
    }
    if (!token.liquidity_usd || token.liquidity_usd === 0) {
      warnings.push('liquidity_usd (0 or missing)');
    }
    if (!token.volume_5m || token.volume_5m === 0) {
      warnings.push('volume_5m (0 or missing)');
    }
    if (token.bot_buys === null || token.bot_buys === undefined) {
      warnings.push('bot_buys (missing)');
    }
    if (token.risk_score === null || token.risk_score === undefined) {
      missing.push('risk_score');
    }
    if (token.buy_sell_ratio === null || token.buy_sell_ratio === undefined || token.buy_sell_ratio === 0) {
      warnings.push('buy_sell_ratio (missing or 0)');
    }

    if (missing.length > 0) {
      logger.warn(`⚠️  [Point-Based] ${token.symbol || token.token_address}: Missing critical fields: ${missing.join(', ')}`);
    }
    if (warnings.length > 0) {
      logger.debug(`   [Point-Based] ${token.symbol || token.token_address}: Data warnings: ${warnings.join(', ')}`);
    }
  }

  /**
   * Log detailed scoring breakdown
   */
  private logScoringBreakdown(
    token: ScannedToken,
    scores: {
      fundamentals: { total: number; age: number; buyRatio: number; marketCap: number; liquidity: number; holders: number };
      marketData: { total: number; marketCap: number; liquidity: number; holders: number };
      activity: { total: number; botBuys: number; buyRatio: number; volume: number; uniqueBuyers: number };
      safety: { total: number; risk: number; security: number };
      timing: { total: number };
      totalScore: number;
      decision: 'BUY' | 'SKIP';
    }
  ): void {
    logger.debug(`📊 [Point-Based] ${token.symbol || 'Unknown'} (${token.token_address}) - Detailed Scoring:`);
    logger.debug(`   Fundamentals (${scores.fundamentals.total.toFixed(1)}/35):`);
    logger.debug(`     Age: ${scores.fundamentals.age.toFixed(1)}/15 (${token.age_hours?.toFixed(1) || 'N/A'}h)`);
    logger.debug(`     Buy/Sell Ratio: ${scores.fundamentals.buyRatio.toFixed(1)}/20 (${token.buy_sell_ratio?.toFixed(2) || 'N/A'})`);
    logger.debug(`   Market Data (${scores.marketData.total.toFixed(1)}/35):`);
    logger.debug(`     Market Cap: ${scores.marketData.marketCap.toFixed(1)}/30 ($${token.market_cap?.toLocaleString() || 'N/A'})`);
    logger.debug(`     Liquidity: ${scores.marketData.liquidity.toFixed(1)}/3 ($${token.liquidity_usd?.toLocaleString() || 'N/A'})`);
    logger.debug(`     Holders: ${scores.marketData.holders.toFixed(1)}/2 (${token.holders || 'N/A'})`);
    logger.debug(`   Activity (${scores.activity.total.toFixed(1)}/10):`);
    logger.debug(`     Bot Buys: ${scores.activity.botBuys.toFixed(1)}/10 (${token.bot_buys || 0})`);
    logger.debug(`   Safety (${scores.safety.total.toFixed(1)}/5):`);
    logger.debug(`     Risk Score: ${scores.safety.risk.toFixed(1)}/5 (${token.risk_score || 'N/A'}/100 - sweet spot: 30-50)`);
    logger.debug(`   Timing (${scores.timing.total.toFixed(1)}/15):`);
    logger.debug(`     Volume 5m: ${token.volume_5m ? `$${token.volume_5m.toLocaleString()}` : 'N/A'}`);
    if (token.volume_6h && token.volume_24h && token.volume_24h > 0) {
      const decayRatio = (token.volume_6h / token.volume_24h).toFixed(3);
      logger.debug(`     Volume Decay (6h→24h): ${decayRatio} (${token.volume_6h > 0 ? `$${token.volume_6h.toLocaleString()}` : 'N/A'} / $${token.volume_24h.toLocaleString()})`);
    }
    if (token.volume_5m && token.volume_1h && token.volume_1h > 0) {
      const decayRatio = (token.volume_5m / token.volume_1h).toFixed(3);
      logger.debug(`     Volume Decay (5m→1h): ${decayRatio} ($${token.volume_5m.toLocaleString()} / $${token.volume_1h.toLocaleString()})`);
    }
    if (token.volume_24h >= 200000) {
      logger.debug(`     High 24h Volume Penalty: -${token.volume_24h >= 1000000 ? '5' : token.volume_24h >= 500000 ? '3' : '2'} ($${token.volume_24h.toLocaleString()})`);
    }
    logger.debug(`   Total Score: ${scores.totalScore.toFixed(1)}/100 → ${scores.decision} (threshold: ${this.minScoreThreshold})`);
  }

  /**
   * Generate human-readable reasoning
   */
  private generateReasoning(
    token: ScannedToken,
    breakdown: { fundamentals: number; marketData: number; activity: number; safety: number; timing: number },
    totalScore: number
  ): string {
    const reasons: string[] = [];

    // Overall assessment
    if (totalScore >= 85) {
      reasons.push('Excellent overall score');
    } else if (totalScore >= 75) {
      reasons.push('Strong overall score');
    } else if (totalScore >= 70) {
      reasons.push('Above threshold');
    } else if (totalScore >= 60) {
      reasons.push('Below threshold');
    } else {
      reasons.push('Weak overall score');
    }

    // Fundamentals
    if (breakdown.fundamentals >= 30) {
      reasons.push(`strong fundamentals (${breakdown.fundamentals}/35)`);
    } else if (breakdown.fundamentals >= 20) {
      reasons.push(`decent fundamentals (${breakdown.fundamentals}/35)`);
    } else {
      reasons.push(`weak fundamentals (${breakdown.fundamentals}/35)`);
    }

    // Market Data
    if (breakdown.marketData >= 30) {
      reasons.push(`strong market data (${breakdown.marketData}/35)`);
    } else if (breakdown.marketData >= 20) {
      reasons.push(`decent market data (${breakdown.marketData}/35)`);
    } else {
      reasons.push(`weak market data (${breakdown.marketData}/35)`);
    }

    // Activity
    if (breakdown.activity >= 8) {
      reasons.push(`high activity (${breakdown.activity}/10)`);
    } else if (breakdown.activity >= 5) {
      reasons.push(`moderate activity (${breakdown.activity}/10)`);
    } else {
      reasons.push(`low activity (${breakdown.activity}/10)`);
    }

    // Safety
    if (breakdown.safety >= 4) {
      reasons.push(`safe (${breakdown.safety}/5)`);
    } else if (breakdown.safety >= 3) {
      reasons.push(`moderate risk (${breakdown.safety}/5)`);
    } else {
      reasons.push(`higher risk (${breakdown.safety}/5)`);
    }

    // Timing
    if (breakdown.timing >= 12) {
      reasons.push(`good timing (${breakdown.timing}/15)`);
    } else if (breakdown.timing >= 8) {
      reasons.push(`decent timing (${breakdown.timing}/15)`);
    }

    // Key highlights
    const mc = token.market_cap || 0;
    const age = token.age_hours || 0;
    const bots = token.bot_buys || 0;
    const ratio = token.buy_sell_ratio || 0;

    if (mc >= 50000 && mc <= 200000) {
      reasons.push('ideal market cap');
    }
    if (age < 6) {
      reasons.push('ultra fresh token');
    } else if (age < 24) {
      reasons.push('fresh token');
    }
    if (bots >= 10) {
      reasons.push('strong bot activity');
    }
    if (ratio >= 2.0) {
      reasons.push('bullish buy/sell ratio');
    }

    return reasons.join('. ') + '.';
  }

  /**
   * Calculate position size based on score
   * Returns percentage of portfolio (1-5%)
   */
  calculatePositionSize(score: number): number {
    // Map score to position percentage (1-5% of portfolio, same as AI)
    if (score >= 90) return 5.0;  // Excellent: 5% of portfolio
    if (score >= 85) return 4.0;  // Very good: 4%
    if (score >= 80) return 3.0;  // Good: 3%
    if (score >= 75) return 2.0;  // Above threshold: 2%
    if (score >= 70) return 1.0;  // Min threshold: 1%
    return 0.5; // Below threshold (shouldn't happen for BUY decisions)
  }

  /**
   * Get suggested SL/TP based on score and token characteristics
   */
  getSuggestedRiskParams(token: ScannedToken, score: number): {
    stopLoss: number;
    takeProfitLevels: Array<{ percentage: number; sellPercent: number }>;
  } {
    // Calculate volatility proxy from 24h price change
    const priceChange24h = Math.abs(token.price_change_24h || 0);
    
    // Volatility adjustment factor
    let volatilityMultiplier = 1.0;
    if (priceChange24h > 200) {
      volatilityMultiplier = 1.5;      // Extreme volatility: wider stops
    } else if (priceChange24h > 100) {
      volatilityMultiplier = 1.3;      // High volatility: wider stops
    } else if (priceChange24h > 50) {
      volatilityMultiplier = 1.15;     // Moderate volatility: slightly wider
    } else if (priceChange24h < 20) {
      volatilityMultiplier = 0.85;     // Low volatility: tighter stops
    }
    
    // Age-based adjustment (newer tokens = more volatile)
    const ageHours = token.age_hours || 0;
    let ageMultiplier = 1.0;
    if (ageHours < 6) {
      ageMultiplier = 1.2;       // Very new: 20% wider stops
    } else if (ageHours < 24) {
      ageMultiplier = 1.1;       // New: 10% wider stops
    } else if (ageHours > 168) {  // 1 week+
      ageMultiplier = 0.9;       // Established: 10% tighter stops
    }
    
    // Combined multiplier (but cap it)
    const combinedMultiplier = Math.min(
      Math.max(volatilityMultiplier * ageMultiplier, 0.75),  // Min: 0.75x
      1.8  // Max: 1.8x
    );
    
    // Base Stop Loss: Match AI guidelines with user's adjustments
    let baseStopLoss;
    if (score >= 85) {
      baseStopLoss = -25;  // High conviction: wider stop (user adjusted)
    } else if (score >= 75) {
      baseStopLoss = -20;  // Standard stop (user adjusted)
    } else {
      baseStopLoss = -15;  // Min threshold: conservative
    }
    
    // Apply volatility adjustment to stop loss
    const adjustedStopLoss = Math.round(baseStopLoss * combinedMultiplier);
    
    // Take Profits: Base values + volatility adjustment
    let baseTp1, baseTp2, baseTp3;
    if (score >= 85) {
      baseTp1 = 15;
      baseTp2 = 30;
      baseTp3 = 50;
    } else if (score >= 80) {
      baseTp1 = 12;
      baseTp2 = 25;
      baseTp3 = 40;
    } else if (score >= 75) {
      baseTp1 = 10;
      baseTp2 = 20;
      baseTp3 = 35;
    } else {
      baseTp1 = 8;
      baseTp2 = 15;
      baseTp3 = 25;
    }
    
    // Apply volatility adjustment to TPs (higher volatility = higher targets)
    const tp1 = Math.round(baseTp1 * combinedMultiplier);
    const tp2 = Math.round(baseTp2 * combinedMultiplier);
    const tp3 = Math.round(baseTp3 * combinedMultiplier);

    return {
      stopLoss: adjustedStopLoss,
      takeProfitLevels: [
        { percentage: tp1, sellPercent: 40 },  // AI guideline: 40%
        { percentage: tp2, sellPercent: 35 },  // AI guideline: 35%
        { percentage: tp3, sellPercent: 25 },  // AI guideline: 25%
      ],
    };
  }
}

