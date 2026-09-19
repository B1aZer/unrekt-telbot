/**
 * Point-Based Token Analyzer V3 (SIGNAL-FOCUSED)
 * 
 * Strategy: v2.9-volume-age-momentum
 * Based on comprehensive 10K+ token correlation analysis
 * 
 * KEY INSIGHT: Only 3-4 features have real predictive power. Focus on those.
 * 
 * Top Signal Combinations:
 * 1. Volume $20K + Age <1h = 98.2% avg gain (51.3% big winner rate)
 * 2. Volume $20K + Multi-Bot (2+) = 84.6% avg gain (47.5% big winner rate)
 * 3. Volume $20K alone = 57.5% avg gain (30.0% big winner rate)
 * 
 * Removed Features (no predictive power):
 * - Buy/Sell Ratio: r=-0.0037 (zero correlation)
 * - Market Cap sweet spots: r=0.053 (weak correlation)
 * - Volume decay complex calculations
 * - Liquidity/Holders (minimal impact)
 * 
 * New Distribution:
 * - Volume: 50 points (5m volume 40pts + Volume Ratio 10pts)
 * - Freshness: 30 points (Age <1h prioritized)
 * - Multi-Bot: 15 points (2+ bots explicit scoring)
 * - Safety: 5 points (Basic checks)
 * 
 * Total: 0-100 points
 * Threshold: 70+ = BUY
 */

import { logger } from '../utils/logger';
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
  price_change_24h: number;
  age_hours: number;
  total_bots_count: number;
  risk_score: number;
  is_honeypot: boolean;
  has_freeze_authority: boolean;
}

export interface TokenScore {
  totalScore: number;  // 0-100
  breakdown: {
    volume: number;      // 0-50
    freshness: number;   // 0-30
    multiBotSignal: number; // 0-15
    safety: number;      // 0-5
  };
  decision: 'BUY' | 'SKIP';
  confidence: number;
  reasoning: string;
  details: {
    volume5m: number;
    volumeRatio: number;
    ageHours: number;
    totalBots: number;
    volumeScore: number;
    volumeRatioScore: number;
    freshnessScore: number;
    multiBotScore: number;
    safetyScore: number;
  };
}

export class PointBasedAnalyzerV3 {
  private minScoreThreshold: number;

  constructor() {
    this.minScoreThreshold = parseFloat(process.env.POINT_BASED_MIN_SCORE || '70');
    const strategyInfo = getStrategyInfo();
    logger.info(`📊 Point-Based Analyzer V3 initialized (strategy: ${strategyInfo.version}, min score: ${this.minScoreThreshold})`);
    logger.info(`   Focus: Volume (50pts) + Freshness (30pts) + Multi-Bot (15pts) + Safety (5pts)`);
  }

  /**
   * Analyze token and return score with decision
   */
  analyze(token: ScannedToken): TokenScore {
    // Calculate scores
    const volumeScore = this.scoreVolume(token);        // 50 pts max
    const freshnessScore = this.scoreFreshness(token);  // 30 pts max
    const multiBotScore = this.scoreMultiBot(token);    // 15 pts max
    const safetyScore = this.scoreSafety(token);        // 5 pts max

    const totalScore = volumeScore.total + freshnessScore.total + multiBotScore.total + safetyScore.total;
    const decision = totalScore >= this.minScoreThreshold ? 'BUY' : 'SKIP';

    // Log detailed scoring breakdown
    this.logScoringBreakdown(token, {
      volume: volumeScore,
      freshness: freshnessScore,
      multiBot: multiBotScore,
      safety: safetyScore,
      totalScore,
      decision,
    });

    return {
      totalScore,
      breakdown: {
        volume: volumeScore.total,
        freshness: freshnessScore.total,
        multiBotSignal: multiBotScore.total,
        safety: safetyScore.total,
      },
      decision,
      confidence: totalScore,
      reasoning: this.generateReasoning(token, {
        volume: volumeScore.total,
        freshness: freshnessScore.total,
        multiBotSignal: multiBotScore.total,
        safety: safetyScore.total,
      }, totalScore),
      details: {
        volume5m: token.volume_5m || 0,
        volumeRatio: volumeScore.volumeRatio,
        ageHours: token.age_hours || 0,
        totalBots: token.total_bots_count || 0,
        volumeScore: volumeScore.volume5m,
        volumeRatioScore: volumeScore.volumeRatioPoints,
        freshnessScore: freshnessScore.total,
        multiBotScore: multiBotScore.total,
        safetyScore: safetyScore.total,
      },
    };
  }

  /**
   * Score volume (50 points max) - PRIMARY SIGNAL
   * Volume >$20K is the foundation of all top-performing combinations
   * Volume Ratio (5m/24h * 288) captures momentum
   */
  private scoreVolume(token: ScannedToken): {
    total: number;
    volume5m: number;
    volumeRatioPoints: number;
    volumeRatio: number;
  } {
    let volume5mScore = 0;
    let volumeRatioScore = 0;

    // 5min Volume (40 points) - Core signal
    const vol5m = token.volume_5m || 0;
    if (vol5m >= 50000) {
      volume5mScore = 40;   // $50K+ = excellent (98%+ avg gain potential)
    } else if (vol5m >= 30000) {
      volume5mScore = 35;   // $30K+ = very good
    } else if (vol5m >= 20000) {
      volume5mScore = 30;   // $20K+ = good (57.5% avg gain baseline)
    } else if (vol5m >= 10000) {
      volume5mScore = 20;   // $10K+ = below target
    } else if (vol5m >= 5000) {
      volume5mScore = 10;   // $5K+ = weak signal
    } else {
      volume5mScore = 0;    // <$5K = no signal
    }

    // Volume Ratio (10 points) - Momentum indicator
    // Ratio = (volume_5m / volume_24h) * 288
    // This shows if volume is accelerating (>1.0) or decelerating (<1.0)
    // 288 = number of 5-minute periods in 24 hours
    const vol24h = token.volume_24h || 0;
    let volumeRatio = 0;
    
    if (vol24h > 0 && vol5m > 0) {
      volumeRatio = (vol5m / vol24h) * 288;
      
      if (volumeRatio >= 5.0) {
        volumeRatioScore = 10;   // 5X+ = extreme momentum
      } else if (volumeRatio >= 3.0) {
        volumeRatioScore = 8;    // 3X+ = strong momentum
      } else if (volumeRatio >= 2.0) {
        volumeRatioScore = 6;    // 2X+ = good momentum (correlation r=0.124)
      } else if (volumeRatio >= 1.5) {
        volumeRatioScore = 4;    // 1.5X+ = moderate momentum
      } else if (volumeRatio >= 1.0) {
        volumeRatioScore = 2;    // 1X = maintaining volume
      } else {
        volumeRatioScore = 0;    // <1X = declining volume
      }
    }

    const total = volume5mScore + volumeRatioScore;  // Max 50 pts (40+10)

    return { 
      total, 
      volume5m: volume5mScore, 
      volumeRatioPoints: volumeRatioScore,
      volumeRatio 
    };
  }

  /**
   * Score freshness (30 points max) - CRITICAL TIMING SIGNAL
   * Age <1h is the strongest timing predictor
   * Volume $20K + Age <1h = 98.2% avg gain (51.3% big winner rate)
   */
  private scoreFreshness(token: ScannedToken): {
    total: number;
  } {
    let score = 0;

    const ageHours = token.age_hours || 0;
    
    if (ageHours < 1) {
      score = 30;      // <1h = ULTRA FRESH (98.2% avg gain with vol >$20K)
    } else if (ageHours < 3) {
      score = 20;      // 1-3h = very fresh (still strong signal)
    } else if (ageHours < 6) {
      score = 12;      // 3-6h = fresh (decent signal)
    } else if (ageHours < 12) {
      score = 6;       // 6-12h = older (weaker signal)
    } else if (ageHours < 24) {
      score = 3;       // 12-24h = old (weak signal)
    } else {
      score = 0;       // >24h = too old (no signal)
    }

    return { total: score };
  }

  /**
   * Score multi-bot signal (15 points max) - CONSENSUS INDICATOR
   * Multi-bot (2+) = 35.7% avg gain vs single bot = 15.9%
   * More bots = more consensus among tracking bots
   */
  private scoreMultiBot(token: ScannedToken): {
    total: number;
  } {
    let score = 0;

    const totalBots = token.total_bots_count || 0;
    
    if (totalBots >= 3) {
      score = 15;      // 3+ bots = strong consensus
    } else if (totalBots >= 2) {
      score = 12;      // 2 bots = good consensus (35.7% avg gain)
    } else if (totalBots >= 1) {
      score = 5;       // 1 bot = single signal (15.9% avg gain)
    } else {
      score = 0;       // 0 bots = no bot signal
    }

    return { total: score };
  }

  /**
   * Score safety (5 points max) - BASIC PROTECTION
   * Simple binary check: safe or not safe
   */
  private scoreSafety(token: ScannedToken): {
    total: number;
  } {
    let score = 5;  // Start with full points

    // Remove points for red flags
    if (token.is_honeypot) {
      score = 0;  // Honeypot = instant fail
    } else if (token.has_freeze_authority) {
      score = 0;  // Freeze authority = instant fail
    }

    return { total: score };
  }

  /**
   * Log detailed scoring breakdown
   */
  private logScoringBreakdown(
    token: ScannedToken,
    scores: {
      volume: { total: number; volume5m: number; volumeRatioPoints: number; volumeRatio: number };
      freshness: { total: number };
      multiBot: { total: number };
      safety: { total: number };
      totalScore: number;
      decision: 'BUY' | 'SKIP';
    }
  ): void {
    const symbol = token.symbol || 'Unknown';
    const vol5m = token.volume_5m || 0;
    const vol24h = token.volume_24h || 0;
    const ageHours = token.age_hours || 0;
    const totalBots = token.total_bots_count || 0;

    logger.debug(`📊 [Point-Based V3] ${symbol} (${token.token_address}) - Signal-Focused Scoring:`);
    logger.debug(`   Volume (${scores.volume.total.toFixed(1)}/50):`);
    logger.debug(`     5m Volume: ${scores.volume.volume5m.toFixed(1)}/40 ($${vol5m.toLocaleString()})`);
    logger.debug(`     Volume Ratio: ${scores.volume.volumeRatioPoints.toFixed(1)}/10 (${scores.volume.volumeRatio.toFixed(2)}x - momentum indicator)`);
    logger.debug(`   Freshness (${scores.freshness.total.toFixed(1)}/30):`);
    logger.debug(`     Age: ${ageHours.toFixed(2)}h ${ageHours < 1 ? '(ULTRA FRESH!)' : ageHours < 3 ? '(very fresh)' : ageHours < 6 ? '(fresh)' : '(older)'}`);
    logger.debug(`   Multi-Bot Signal (${scores.multiBot.total.toFixed(1)}/15):`);
    logger.debug(`     Total Bots: ${totalBots} ${totalBots >= 3 ? '(strong consensus)' : totalBots >= 2 ? '(good consensus)' : totalBots >= 1 ? '(single signal)' : '(no signal)'}`);
    logger.debug(`   Safety (${scores.safety.total.toFixed(1)}/5):`);
    logger.debug(`     Honeypot: ${token.is_honeypot ? 'YES (FAIL)' : 'No'}`);
    logger.debug(`     Freeze Authority: ${token.has_freeze_authority ? 'YES (FAIL)' : 'No'}`);
    logger.debug(`   Total Score: ${scores.totalScore.toFixed(1)}/100 → ${scores.decision} (threshold: ${this.minScoreThreshold})`);
    
    // Highlight signal combinations
    if (vol5m >= 20000 && ageHours < 1) {
      logger.info(`   🎯 BEST COMBO: Volume >$20K + Age <1h (98.2% avg gain expected)`);
    } else if (vol5m >= 20000 && totalBots >= 2) {
      logger.info(`   🎯 STRONG COMBO: Volume >$20K + Multi-Bot (84.6% avg gain expected)`);
    } else if (vol5m >= 20000) {
      logger.info(`   ✅ GOOD SIGNAL: Volume >$20K (57.5% avg gain expected)`);
    }
  }

  /**
   * Generate human-readable reasoning
   */
  private generateReasoning(
    token: ScannedToken,
    breakdown: { volume: number; freshness: number; multiBotSignal: number; safety: number },
    totalScore: number
  ): string {
    const reasons: string[] = [];

    // Overall assessment
    if (totalScore >= 85) {
      reasons.push('Excellent signal combination');
    } else if (totalScore >= 75) {
      reasons.push('Strong signals');
    } else if (totalScore >= 70) {
      reasons.push('Above threshold');
    } else if (totalScore >= 60) {
      reasons.push('Below threshold');
    } else {
      reasons.push('Weak signals');
    }

    // Volume assessment
    const vol5m = token.volume_5m || 0;
    if (vol5m >= 50000) {
      reasons.push('exceptional volume ($50K+)');
    } else if (vol5m >= 30000) {
      reasons.push('very high volume ($30K+)');
    } else if (vol5m >= 20000) {
      reasons.push('strong volume ($20K+)');
    } else if (vol5m >= 10000) {
      reasons.push('moderate volume ($10K+)');
    } else {
      reasons.push('low volume (<$10K)');
    }

    // Volume ratio assessment
    const vol24h = token.volume_24h || 0;
    if (vol24h > 0) {
      const volumeRatio = (vol5m / vol24h) * 288;
      if (volumeRatio >= 3.0) {
        reasons.push('accelerating momentum (3X+)');
      } else if (volumeRatio >= 2.0) {
        reasons.push('strong momentum (2X+)');
      } else if (volumeRatio >= 1.5) {
        reasons.push('moderate momentum');
      } else if (volumeRatio < 1.0) {
        reasons.push('declining momentum');
      }
    }

    // Age assessment
    const ageHours = token.age_hours || 0;
    if (ageHours < 1) {
      reasons.push('ULTRA FRESH (<1h)');
    } else if (ageHours < 3) {
      reasons.push('very fresh (<3h)');
    } else if (ageHours < 6) {
      reasons.push('fresh (<6h)');
    } else if (ageHours < 12) {
      reasons.push('older token (6-12h)');
    } else {
      reasons.push('mature token (>12h)');
    }

    // Multi-bot assessment
    const totalBots = token.total_bots_count || 0;
    if (totalBots >= 3) {
      reasons.push('strong multi-bot consensus (3+)');
    } else if (totalBots >= 2) {
      reasons.push('multi-bot signal (2+)');
    } else if (totalBots >= 1) {
      reasons.push('single bot signal');
    } else {
      reasons.push('no bot signal');
    }

    // Safety
    if (token.is_honeypot) {
      reasons.push('HONEYPOT DETECTED');
    }
    if (token.has_freeze_authority) {
      reasons.push('FREEZE AUTHORITY PRESENT');
    }

    // Best combinations
    if (vol5m >= 20000 && ageHours < 1) {
      reasons.push('⭐ OPTIMAL COMBO (Vol >$20K + Age <1h)');
    } else if (vol5m >= 20000 && totalBots >= 2) {
      reasons.push('⭐ STRONG COMBO (Vol >$20K + Multi-Bot)');
    }

    return reasons.join('. ') + '.';
  }

  /**
   * Calculate position size based on score
   * Returns percentage of portfolio (1-5%)
   */
  calculatePositionSize(score: number): number {
    // Map score to position percentage
    if (score >= 90) return 5.0;  // Excellent: 5% of portfolio
    if (score >= 85) return 4.0;  // Very good: 4%
    if (score >= 80) return 3.0;  // Good: 3%
    if (score >= 75) return 2.0;  // Above threshold: 2%
    if (score >= 70) return 1.0;  // Min threshold: 1%
    return 0.5; // Below threshold (shouldn't happen for BUY decisions)
  }

  /**
   * Get suggested risk params (fixed for v2.8+ timed exit strategy)
   * 
   * With v2.8-timed-exit and now v2.9-volume-age-momentum:
   * - 10-minute timed exit (primary exit)
   * - Stop loss -10% (emergency only)
   * - No take profits (disabled)
   * - No trailing stop (disabled)
   */
  getSuggestedRiskParams(): {
    stopLoss: number;
    takeProfitLevels: Array<{ percentage: number; sellPercent: number }>;
  } {
    // Fixed risk params for timed exit strategy
    return {
      stopLoss: -10,  // Emergency stop loss only
      takeProfitLevels: [], // Disabled (timed exit handles all exits)
    };
  }
}

