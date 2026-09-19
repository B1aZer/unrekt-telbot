/**
 * Decision Logger
 * 
 * Tracks ALL AI decisions (BUY and SKIP) to PostgreSQL database
 * Enables performance analysis and learning over time
 */

import { query } from '../infra/database';
import { logger } from '../utils/logger';
import { getChainConfig } from '../config/chain';

// ============================================================================
// Types
// ============================================================================

export interface DecisionLog {
  // Token Info
  tokenAddress: string;
  symbol: string;
  name: string;
  
  // AI Decision
  shouldBuy: boolean;
  confidence: number;
  reasoning: string;
  
  // ML Prediction Metrics (separate columns for analytics)
  mlPredictedReturn?: number;   // E[R|win] - predicted return if trade wins (%)
  mlExpectedValue?: number;     // P(win) × E[R|win] - expected value used for position sizing (%)
  
  // AI Metrics
  freshnessScore: number;
  
  // Position Details (if shouldBuy)
  positionSizePercent?: number;
  positionSizeUsd?: number;
  stopLossPercent?: number;
  takeProfitLevels?: number[];
  timeBasedExitSeconds?: number;
  
  // AI Analysis Details (for Telegram messages)
  opportunities?: string[];  // Array of opportunities
  risks?: string[];          // Array of risks
  warnings?: string[];       // Array of warnings
  
  // Strategy Tracking
  strategyId?: number;       // Foreign key to strategies table
  
  // Metadata
  scanId?: string;
  
  // Legacy fields (kept for backwards compatibility, but not stored in decisions table)
  // These are now in scanned_tokens table - use JOIN to access
  ageHours?: number | null;
  marketCap?: number;
  liquidity?: number;
  volume5m?: number;
  volumeAcceleration?: number;
  uniqueUsers?: number;
  totalTrades?: number;
  riskScore?: number;
  priceUsd?: number;
  priceChange1m?: number;
  priceChange5m?: number;
  trend?: string;
  discoveredByBots?: string[];
  botActivityJson?: Record<string, { buys: number; sells: number }>;
  multiBotSignal?: boolean;
  totalBotsCount?: number;
  txnBuys5m?: number;
  txnSells5m?: number;
  buySellRatio?: number;
  scannerData?: any;
}

export interface PerformanceStats {
  // Decision Stats
  totalDecisions: number;
  buyDecisions: number;
  skipDecisions: number;
  buyPercentage: number;
  
  // Buy Characteristics
  avgRiskScore: number;
  avgMarketCap: number;
  avgAgeHours: number;
  avgFreshnessScore: number;
  avgConfidence: number;
  
  // Trade Stats
  totalTrades: number;
  completedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  
  // PnL Stats
  avgPnlPercent: number;
  totalPnlUsd: number;
  bestTradePnl: number;
  worstTradePnl: number;
}

// ============================================================================
// Decision Logger Service
// ============================================================================

export class DecisionLogger {
  constructor() {
    logger.info('📊 Decision Logger initialized (PostgreSQL)');
  }
  
  /**
   * Log a decision to database
   */
  async logDecision(decision: DecisionLog): Promise<number> {
    try {
      const tp = decision.takeProfitLevels || [];
      const chainConfig = getChainConfig();
      
      const result = await query(`
        INSERT INTO decisions (
          chain, token_address, symbol, name,
          should_buy, confidence, reasoning,
          freshness_score,
          position_size_percent, stop_loss_percent,
          take_profit_1_percent, take_profit_2_percent, take_profit_3_percent,
          ml_predicted_return, ml_expected_value,
          opportunities, risks, warnings,
          scan_id,
          strategy_id
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8,
          $9, $10,
          $11, $12, $13,
          $14, $15,
          $16, $17, $18,
          $19,
          $20
        )
        RETURNING id
      `, [
        chainConfig.chain,
        decision.tokenAddress || '',  // NOT NULL in DB
        decision.symbol || 'UNKNOWN',  // NOT NULL in DB
        decision.name || null,          // Can be NULL
        decision.shouldBuy,
        Math.round(decision.confidence || 0),  // INTEGER in DB
        decision.reasoning || '',       // TEXT can be empty
        decision.freshnessScore != null ? Math.round(decision.freshnessScore) : null,  // INTEGER in DB
        decision.positionSizePercent || null,
        decision.stopLossPercent || null,
        tp[0] != null ? tp[0] : null,
        tp[1] != null ? tp[1] : null,
        tp[2] != null ? tp[2] : null,
        decision.mlPredictedReturn != null ? decision.mlPredictedReturn : null,  // DOUBLE PRECISION
        decision.mlExpectedValue != null ? decision.mlExpectedValue : null,      // DOUBLE PRECISION
        (decision.opportunities && decision.opportunities.length > 0) ? decision.opportunities : null,
        (decision.risks && decision.risks.length > 0) ? decision.risks : null,
        (decision.warnings && decision.warnings.length > 0) ? decision.warnings : null,
        decision.scanId || null,
        decision.strategyId || null  // Foreign key to strategies table
      ]);
      
      const decisionId = result.rows[0].id;
      
      const botInfo = decision.discoveredByBots 
        ? ` [Bots: ${decision.discoveredByBots.join(', ')}${decision.multiBotSignal ? ' 🔥' : ''}]`
        : '';
      logger.debug(`📝 Logged decision #${decisionId}: ${decision.symbol} - ${decision.shouldBuy ? 'BUY' : 'SKIP'} (confidence: ${decision.confidence})${botInfo}`);
      
      return decisionId;
      
    } catch (error) {
      logger.error('Failed to log decision:', error);
      throw error;
    }
  }
  
  /**
   * Get recent decisions
   */
  async getRecentDecisions(hours: number = 24, onlyBuys: boolean = false): Promise<any[]> {
    const result = await query(`
      SELECT * FROM decisions 
      WHERE timestamp >= NOW() - INTERVAL '${hours} hours'
      ${onlyBuys ? 'AND should_buy = TRUE' : ''}
      ORDER BY timestamp DESC
    `);
    
    return result.rows;
  }
  
  /**
   * Get performance stats for a time period
   */
  async getPerformanceStats(hours: number = 24): Promise<PerformanceStats> {
    const statsResult = await query(`
      SELECT 
        COUNT(*) as total_decisions,
        SUM(CASE WHEN d.should_buy = TRUE THEN 1 ELSE 0 END) as buy_decisions,
        SUM(CASE WHEN d.should_buy = FALSE THEN 1 ELSE 0 END) as skip_decisions,
        AVG(CASE WHEN d.should_buy = TRUE THEN st.risk_score END) as avg_risk_score,
        AVG(CASE WHEN d.should_buy = TRUE THEN st.market_cap END) as avg_market_cap,
        AVG(CASE WHEN d.should_buy = TRUE THEN st.age_hours END) as avg_age_hours,
        AVG(CASE WHEN d.should_buy = TRUE THEN d.freshness_score END) as avg_freshness_score,
        AVG(CASE WHEN d.should_buy = TRUE THEN d.confidence END) as avg_confidence
      FROM decisions d
      LEFT JOIN scanned_tokens st ON st.token_address = d.token_address AND st.scan_id = d.scan_id
      WHERE d.timestamp >= NOW() - INTERVAL '${hours} hours'
    `);
    
    const stats = statsResult.rows[0];
    
    const tradeStatsResult = await query(`
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as completed_trades,
        SUM(CASE WHEN status = 'closed' AND pnl_percent > 0 THEN 1 ELSE 0 END) as winning_trades,
        SUM(CASE WHEN status = 'closed' AND pnl_percent < 0 THEN 1 ELSE 0 END) as losing_trades,
        AVG(CASE WHEN status = 'closed' THEN pnl_percent END) as avg_pnl_percent,
        SUM(CASE WHEN status = 'closed' THEN net_pnl_usd ELSE 0 END) as total_pnl_usd,
        MAX(CASE WHEN status = 'closed' THEN pnl_percent END) as best_trade_pnl,
        MIN(CASE WHEN status = 'closed' THEN pnl_percent END) as worst_trade_pnl
      FROM trades
      WHERE entry_timestamp >= NOW() - INTERVAL '${hours} hours'
    `);
    
    const tradeStats = tradeStatsResult.rows[0];
    
    const winRate = tradeStats.completed_trades > 0 
      ? (tradeStats.winning_trades / tradeStats.completed_trades) * 100 
      : 0;
    
    const buyPercentage = stats.total_decisions > 0
      ? (stats.buy_decisions / stats.total_decisions) * 100
      : 0;
    
    return {
      totalDecisions: parseInt(stats.total_decisions) || 0,
      buyDecisions: parseInt(stats.buy_decisions) || 0,
      skipDecisions: parseInt(stats.skip_decisions) || 0,
      buyPercentage: Number(buyPercentage.toFixed(2)),
      avgRiskScore: Number((parseFloat(stats.avg_risk_score) || 0).toFixed(2)),
      avgMarketCap: Number((parseFloat(stats.avg_market_cap) || 0).toFixed(0)),
      avgAgeHours: Number((parseFloat(stats.avg_age_hours) || 0).toFixed(2)),
      avgFreshnessScore: Number((parseFloat(stats.avg_freshness_score) || 0).toFixed(0)),
      avgConfidence: Number((parseFloat(stats.avg_confidence) || 0).toFixed(2)),
      totalTrades: parseInt(tradeStats.total_trades) || 0,
      completedTrades: parseInt(tradeStats.completed_trades) || 0,
      winningTrades: parseInt(tradeStats.winning_trades) || 0,
      losingTrades: parseInt(tradeStats.losing_trades) || 0,
      winRate: Number(winRate.toFixed(2)),
      avgPnlPercent: Number((parseFloat(tradeStats.avg_pnl_percent) || 0).toFixed(2)),
      totalPnlUsd: Number((parseFloat(tradeStats.total_pnl_usd) || 0).toFixed(2)),
      bestTradePnl: Number((parseFloat(tradeStats.best_trade_pnl) || 0).toFixed(2)),
      worstTradePnl: Number((parseFloat(tradeStats.worst_trade_pnl) || 0).toFixed(2)),
    };
  }
  
  /**
   * Mark decision as executed with trade ID
   */
  async markAsExecuted(decisionId: number, tradeId: number): Promise<void> {
    await query(`
      UPDATE decisions 
      SET executed = TRUE, trade_id = $1
      WHERE id = $2
    `, [tradeId, decisionId]);
  }
  
  /**
   * Update daily stats (run at end of day or periodically)
   * Note: daily_stats table not yet implemented in schema
   */
  async updateDailyStats(date?: string): Promise<void> {
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    // Calculate stats for the day
    const statsResult = await query(`
      SELECT 
        COUNT(*) as total_decisions,
        SUM(CASE WHEN d.should_buy = TRUE THEN 1 ELSE 0 END) as buy_decisions,
        AVG(CASE WHEN d.should_buy = TRUE THEN st.risk_score END) as avg_risk_score,
        AVG(CASE WHEN d.should_buy = TRUE THEN st.market_cap END) as avg_market_cap,
        AVG(CASE WHEN d.should_buy = TRUE THEN st.age_hours END) as avg_age_hours,
        AVG(CASE WHEN d.should_buy = TRUE THEN d.freshness_score END) as avg_freshness_score,
        AVG(CASE WHEN d.should_buy = TRUE THEN d.confidence END) as avg_confidence,
        AVG(CASE WHEN d.should_buy = TRUE THEN st.liquidity END) as avg_liquidity,
        AVG(CASE WHEN d.should_buy = TRUE THEN st.volume_24h END) as avg_volume_24h
      FROM decisions d
      LEFT JOIN scanned_tokens st ON st.token_address = d.token_address AND st.scan_id = d.scan_id
      WHERE DATE(d.timestamp) = $1
    `, [targetDate]);
    
    const stats = statsResult.rows[0];
    
    // TODO: Implement daily_stats table if needed
    // For now, just log
    logger.debug(`📊 Daily stats for ${targetDate}:`, stats);
  }
}

