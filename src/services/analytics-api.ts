/**
 * Analytics API Service
 * 
 * Provides data for token flow analytics UI
 */

import { query } from '../infra/database';
import { logger } from '../utils/logger';
import type { RegimeData } from './regime-detector';

export interface TokenFlowData {
  // From scanned_tokens
  scan_id: string;
  scan_timestamp: string;
  found_hours_ago: number | null;
  token_address: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  discovered_by_bots: string[] | null;
  
  // Market data
  price_usd: number | null;
  market_cap: number | null;
  liquidity: number | null;
  volume_24h: number | null;
  risk_score: number | null;
  is_safe: boolean | null;
  selection_score: number | null;  // NEW: AI selection quality score
  filter_stage: string | null;
  filter_reason: string | null;
  peak_gain: number | null;
  peak_drawdown: number | null;
  
  // Trading activity
  bot_buys: number | null;
  bot_sells: number | null;
  unique_users: number | null;
  txn_buys_5m: number | null;
  txn_sells_5m: number | null;
  txn_buys_1h: number | null;
  txn_sells_1h: number | null;
  txn_buys_6h: number | null;
  txn_sells_6h: number | null;
  buy_sell_ratio: number | null;
  volume_5m: number | null;
  volume_1h: number | null;
  volume_6h: number | null;
  age_hours: number | null;
  
  // Smart money metrics (only columns that exist after migrations 052 and 053)
  smart_money_wallet_count: number | null;
  smart_money_buy_count: number | null;
  smart_money_buy_percentage: number | null;
  smart_money_conviction_score: number | null;
  
  // Decision data (if exists)
  decision_id: number | null;
  decision_timestamp: string | null;
  should_buy: boolean | null;
  confidence: number | null;
  reasoning: string | null;
  ml_predicted_return: number | null;  // ML predicted return (E[R|win]) in %
  ml_expected_value: number | null;     // ML expected value (P(win) × E[R|win]) in %
  opportunities: string[] | null;
  risks: string[] | null;
  warnings: string[] | null;
  
  // Strategy data (if exists)
  strategy_version: string | null;
  
  // Watchlist data (if exists)
  watchlist_id: number | null;
  watchlist_status: string | null;
  signal_price: number | null;
  max_gain_percent: number | null;
  max_dump_percent: number | null;
  haiku_decision: string | null;
  skip_reason: string | null;
  
  // Trade data (if exists)
  trade_id: number | null;
  trade_status: string | null;
  entry_price: number | null;
  actual_entry_price: number | null;
  entry_amount_usd: number | null;
  exit_price: number | null;
  stop_loss_percent: number | null;
  take_profit_1: number | null;
  take_profit_1_sell_percent: number | null;
  take_profit_2: number | null;
  take_profit_2_sell_percent: number | null;
  take_profit_3: number | null;
  take_profit_3_sell_percent: number | null;
  pnl_percent: number | null;
  net_pnl_usd: number | null;
  exit_reason: string | null;
  max_gain_percent_trade: number | null;
  hold_duration_minutes: number | null;
  tp1_hit: boolean | null;
  tp2_hit: boolean | null;
  tp3_hit: boolean | null;
  sol_price_entry: number | null;
  sol_price_exit: number | null;
}

export class AnalyticsAPI {
  /**
   * Get token flow data for analytics UI
   * Shows full journey: scan → decision → watchlist → trade
   */
  async getTokenFlowData(options: {
    limit?: number;
    offset?: number;
    scanId?: string;
    tokenAddress?: string;
    chain?: string;
    dateFrom?: string;
    dateTo?: string;
    flowStage?: string;
    strategyVersion?: string;
  } = {}): Promise<{ data: TokenFlowData[]; total: number }> {
    try {
      const limit = options.limit || 100;
      const offset = options.offset || 0;
      
      // Determine if we should use the optimized strategy query path
      // Use optimized path when: strategy is set AND no flowStage filter
      const useStrategyOptimizedPath = options.strategyVersion && !options.flowStage;
      
      // Build WHERE clause - different structure for strategy-optimized vs normal path
      let whereClause = 'WHERE 1=1';
      const params: any[] = [];
      let paramIndex = 1;

      if (options.scanId) {
        whereClause += ` AND st.scan_id = $${paramIndex++}`;
        params.push(options.scanId);
      }

      if (options.tokenAddress) {
        whereClause += ` AND st.token_address = $${paramIndex++}`;
        params.push(options.tokenAddress);
      }

      if (options.chain) {
        whereClause += ` AND st.chain = $${paramIndex++}`;
        params.push(options.chain);
      }

      // Date filtering - use d.timestamp for strategy path, s.timestamp otherwise
      const dateColumn = useStrategyOptimizedPath ? 'd.timestamp' : 's.timestamp';
      if (options.dateFrom) {
        whereClause += ` AND ${dateColumn} >= $${paramIndex++}`;
        params.push(options.dateFrom);
      } else if (!options.scanId && !options.tokenAddress) {
        // Default to last 24 hours for performance (querying all 100K+ rows is slow)
        whereClause += ` AND ${dateColumn} >= NOW() - INTERVAL '24 hours'`;
      }

      if (options.dateTo) {
        whereClause += ` AND ${dateColumn} <= $${paramIndex++}`;
        params.push(options.dateTo);
      }

      // Strategy filtering
      if (options.strategyVersion) {
        whereClause += ` AND strat.version = $${paramIndex++}`;
        params.push(options.strategyVersion);
      }

      // Flow stage filtering
      // scanned = all tokens (no filter)
      // ai_ready = tokens that reached AI (filter_stage = 'ai_ready' OR has decision)
      // decision = tokens with entries in decisions table (d.id IS NOT NULL)
      // watchlist = tokens with entries in watchlist_entries table (w.id IS NOT NULL)
      // trade = tokens with entries in trades table (t.id IS NOT NULL)
      if (options.flowStage) {
        if (options.flowStage === 'ai_ready') {
          whereClause += ` AND (st.filter_stage = 'ai_ready' OR d.id IS NOT NULL)`;
        } else if (options.flowStage === 'decision') {
          whereClause += ` AND d.id IS NOT NULL`;
        } else if (options.flowStage === 'watchlist') {
          whereClause += ` AND w.id IS NOT NULL`;
        } else if (options.flowStage === 'trade') {
          whereClause += ` AND t.id IS NOT NULL`;
        }
      }

      logger.debug(`[AnalyticsAPI] Flow stage filter: ${options.flowStage || 'none (all scanned)'}`);
      logger.debug(`[AnalyticsAPI] Strategy optimized path: ${useStrategyOptimizedPath}`);
      logger.debug(`[AnalyticsAPI] WHERE clause: ${whereClause}`);

      // Get total count first (needed for pagination)
      // Three paths: fast (no joins), strategy-optimized (start from decisions), full (all joins)
      let total: number;
      const needsJoins = options.flowStage || options.strategyVersion;
      
      if (!needsJoins) {
        // Fast path: simple count without expensive JOINs
        const countResult = await query(`
          SELECT COUNT(*) as total
          FROM scanned_tokens st
          INNER JOIN scans s ON s.id = st.scan_id
          ${whereClause}
        `, params);
        total = parseInt(countResult.rows[0].total);
      } else if (useStrategyOptimizedPath) {
        // Strategy-optimized path: Start from decisions (much faster)
        // Uses d.timestamp in WHERE clause (already set above)
        const countResult = await query(`
          SELECT COUNT(DISTINCT d.id) as total
          FROM decisions d
          INNER JOIN strategies strat ON strat.id = d.strategy_id
          INNER JOIN scanned_tokens st ON st.token_address = d.token_address AND st.scan_id = d.scan_id
          ${whereClause}
        `, params);
        total = parseInt(countResult.rows[0].total);
      } else if (options.flowStage === 'ai_ready' || options.flowStage === 'decision') {
        // Optimized: only JOIN decisions (no need for watchlist/trades/strategies)
        const countResult = await query(`
          SELECT COUNT(DISTINCT st.id) as total
          FROM scanned_tokens st
          INNER JOIN scans s ON s.id = st.scan_id
          LEFT JOIN decisions d ON d.token_address = st.token_address AND d.scan_id = st.scan_id
          ${whereClause}
        `, params);
        total = parseInt(countResult.rows[0].total);
      } else {
        // Full path: flowStage is 'watchlist' or 'trade', need deeper JOINs
        const countResult = await query(`
          SELECT COUNT(DISTINCT st.id) as total
          FROM scanned_tokens st
          INNER JOIN scans s ON s.id = st.scan_id
          LEFT JOIN decisions d ON d.token_address = st.token_address AND d.scan_id = st.scan_id
          LEFT JOIN watchlist_entries w ON w.decision_id = d.id
          LEFT JOIN trades t ON t.decision_id = d.id
          ${whereClause}
        `, params);
        total = parseInt(countResult.rows[0].total);
      }

      // Get paginated data
      const dataResult = await query(`
        SELECT 
          -- Scan data
          st.scan_id,
          s.timestamp as scan_timestamp,
          EXTRACT(EPOCH FROM (NOW() - s.timestamp)) / 3600 as found_hours_ago,
          st.token_address,
          st.chain,
          st.symbol,
          st.name,
          st.discovered_by_bots,
          
          -- Market data
          st.price_usd,
          st.market_cap,
          st.liquidity,
          st.volume_24h,
          st.risk_score,
          st.is_safe,
          st.selection_score,
          st.filter_stage,
          st.filter_reason,
          st.peak_gain,
          st.peak_drawdown,
          
          -- Trading activity
          st.bot_buys,
          st.bot_sells,
          st.unique_users,
          st.txn_buys_5m,
          st.txn_sells_5m,
          st.txn_buys_1h,
          st.txn_sells_1h,
          st.txn_buys_6h,
          st.txn_sells_6h,
          st.buy_sell_ratio,
          st.volume_5m,
          st.volume_1h,
          st.volume_6h,
          st.age_hours,
          
          -- Smart money metrics (only columns that exist after migrations 052 and 053)
          st.smart_money_wallet_count,
          st.smart_money_buy_count,
          st.smart_money_buy_percentage,
          st.smart_money_conviction_score,
          
          -- Decision data
          d.id as decision_id,
          d.timestamp as decision_timestamp,
          d.should_buy,
          d.confidence,
          d.reasoning,
          d.ml_predicted_return,
          d.ml_expected_value,
          d.opportunities,
          d.risks,
          d.warnings,
          
          -- Strategy data
          strat.version as strategy_version,
          
          -- Watchlist data
          w.id as watchlist_id,
          w.status as watchlist_status,
          w.signal_price,
          w.max_gain_percent,
          w.max_dump_percent,
          w.haiku_decision,
          w.skip_reason,
          
          -- Trade data
          t.id as trade_id,
          t.status as trade_status,
          t.entry_price,
          t.actual_entry_price,
          t.entry_amount_usd,
          t.exit_price,
          t.stop_loss_percent,
          t.take_profit_1,
          t.take_profit_1_sell_percent,
          t.take_profit_2,
          t.take_profit_2_sell_percent,
          t.take_profit_3,
          t.take_profit_3_sell_percent,
          t.pnl_percent,
          t.net_pnl_usd,
          t.exit_reason,
          t.max_gain_percent as max_gain_percent_trade,
          t.hold_duration_minutes,
          t.tp1_hit,
          t.tp2_hit,
          t.tp3_hit,
          t.sol_price_entry,
          t.sol_price_exit
        FROM ${useStrategyOptimizedPath ? `
          -- Optimized: Start from decisions when filtering by strategy (much faster)
          decisions d
          INNER JOIN strategies strat ON strat.id = d.strategy_id
          INNER JOIN scanned_tokens st ON st.token_address = d.token_address AND st.scan_id = d.scan_id
          INNER JOIN scans s ON s.id = st.scan_id
          LEFT JOIN watchlist_entries w ON w.decision_id = d.id
          LEFT JOIN trades t ON t.decision_id = d.id
        ` : `
          scanned_tokens st
          INNER JOIN scans s ON s.id = st.scan_id
          LEFT JOIN decisions d ON d.token_address = st.token_address AND d.scan_id = st.scan_id
          LEFT JOIN strategies strat ON strat.id = d.strategy_id
          LEFT JOIN watchlist_entries w ON w.decision_id = d.id
          LEFT JOIN trades t ON t.decision_id = d.id
        `}
        ${whereClause}
        ORDER BY ${useStrategyOptimizedPath ? 'd.timestamp' : 's.timestamp'} DESC, st.token_address
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `, [...params, limit, offset]);

      return {
        data: dataResult.rows as TokenFlowData[],
        total: total
      };
    } catch (error) {
      logger.error('Failed to fetch token flow data:', error);
      throw error;
    }
  }

  /**
   * Get summary stats for analytics dashboard
   */
  /**
   * Get list of all strategies with deployment dates
   */
  async getStrategies(): Promise<Array<{ id: number; version: string; deployed_at: string; is_active: boolean }>> {
    try {
      const result = await query(`
        SELECT id, version, deployed_at, is_active
        FROM strategies
        ORDER BY deployed_at DESC
      `);
      return result.rows;
    } catch (error) {
      logger.error('Failed to fetch strategies:', error);
      throw error;
    }
  }

  async getSummaryStats(options: {
    hours?: number;
    dateFrom?: string;
    dateTo?: string;
    chain?: string;
    strategyVersion?: string;
  } = {}): Promise<any> {
    try {
      let whereClause = 'WHERE 1=1';
      const params: any[] = [];
      let paramIndex = 1;

      // Date filtering - prioritize dateFrom/dateTo over hours
      if (options.dateFrom) {
        whereClause += ` AND s.timestamp >= $${paramIndex++}`;
        params.push(options.dateFrom);
      } else if (options.hours) {
        whereClause += ` AND s.timestamp >= NOW() - INTERVAL '${options.hours} hours'`;
      } else {
        // Default to 24 hours if nothing specified
        whereClause += ` AND s.timestamp >= NOW() - INTERVAL '24 hours'`;
      }

      if (options.dateTo) {
        whereClause += ` AND s.timestamp <= $${paramIndex++}`;
        params.push(options.dateTo);
      }

      // Chain filtering
      if (options.chain) {
        whereClause += ` AND st.chain = $${paramIndex++}`;
        params.push(options.chain);
      }

      // Strategy filtering - add to whereClause, will be used with strategies JOIN below
      let strategyFilter = '';
      if (options.strategyVersion) {
        strategyFilter = ` AND strat.version = $${paramIndex++}`;
        params.push(options.strategyVersion);
      }

      const result = await query(`
        SELECT 
          COUNT(DISTINCT st.scan_id) as total_scans,
          COUNT(DISTINCT st.token_address) as unique_tokens_scanned,
          COUNT(DISTINCT d.id) as total_decisions,
          COUNT(DISTINCT CASE WHEN d.should_buy = true THEN d.id END) as buy_decisions,
          COUNT(DISTINCT w.id) as watchlist_entries,
          COUNT(DISTINCT t.id) as total_trades,
          COUNT(DISTINCT CASE WHEN t.status = 'closed' THEN t.id END) as closed_trades,
          SUM(CASE WHEN t.status = 'closed' AND t.net_pnl_usd > 0 THEN 1 ELSE 0 END) as winning_trades,
          SUM(CASE WHEN t.status = 'closed' AND t.net_pnl_usd < 0 THEN 1 ELSE 0 END) as losing_trades,
          AVG(CASE WHEN t.status = 'closed' THEN t.pnl_percent END) as avg_pnl_percent,
          SUM(CASE WHEN t.status = 'closed' THEN t.net_pnl_usd ELSE 0 END) as total_pnl_usd
        FROM scanned_tokens st
        INNER JOIN scans s ON s.id = st.scan_id
        LEFT JOIN decisions d ON d.token_address = st.token_address AND d.scan_id = st.scan_id
        LEFT JOIN strategies strat ON strat.id = d.strategy_id
        LEFT JOIN watchlist_entries w ON w.decision_id = d.id
        LEFT JOIN trades t ON t.decision_id = d.id
        ${whereClause}${strategyFilter}
      `, params);

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to fetch summary stats:', error);
      throw error;
    }
  }

  /**
   * Get funnel data for visualization
   */
  async getFunnelData(options: { hours?: number; dateFrom?: string; dateTo?: string } = {}): Promise<any> {
    try {
      let whereClause = 'WHERE 1=1';
      
      // Date filtering - prioritize dateFrom/dateTo over hours
      if (options.dateFrom) {
        whereClause += ` AND s.timestamp >= '${options.dateFrom}'::timestamp`;
      } else if (options.hours) {
        whereClause += ` AND s.timestamp >= NOW() - INTERVAL '${options.hours} hours'`;
      } else {
        whereClause += ` AND s.timestamp >= NOW() - INTERVAL '24 hours'`;
      }

      if (options.dateTo) {
        whereClause += ` AND s.timestamp <= '${options.dateTo}'::timestamp`;
      }

      const result = await query(`
        SELECT 
          COUNT(DISTINCT st.id) as scanned,
          COUNT(DISTINCT CASE WHEN st.is_safe = true THEN st.id END) as passed_security,
          COUNT(DISTINCT CASE WHEN st.is_safe = true AND st.unique_users >= 1 AND st.total_activity >= 3 THEN st.id END) as passed_activity,
          COUNT(DISTINCT CASE WHEN st.is_safe = true AND st.unique_users >= 1 AND st.total_activity >= 3 AND st.liquidity >= 8000 THEN st.id END) as passed_liquidity,
          COUNT(DISTINCT d.id) as decisions,
          COUNT(DISTINCT CASE WHEN d.should_buy = true THEN d.id END) as buy_decisions,
          COUNT(DISTINCT w.id) as watchlist_entries,
          COUNT(DISTINCT CASE WHEN w.status = 'executed' THEN w.id END) as watchlist_executed,
          COUNT(DISTINCT t.id) as trades,
          COUNT(DISTINCT CASE WHEN t.status = 'closed' THEN t.id END) as closed_trades,
          COUNT(DISTINCT CASE WHEN t.status = 'closed' AND t.net_pnl_usd > 0 THEN t.id END) as winning_trades
        FROM scanned_tokens st
        INNER JOIN scans s ON s.id = st.scan_id
        LEFT JOIN decisions d ON d.token_address = st.token_address AND d.scan_id = st.scan_id
        LEFT JOIN watchlist_entries w ON w.decision_id = d.id
        LEFT JOIN trades t ON t.decision_id = d.id
        ${whereClause}
      `);

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to fetch funnel data:', error);
      throw error;
    }
  }

  /**
   * Get bot performance data for comparison charts
   */
  async getBotPerformanceData(options: { hours?: number; dateFrom?: string; dateTo?: string } = {}): Promise<any[]> {
    try {
      let whereClause = 'WHERE 1=1';
      
      // Date filtering - prioritize dateFrom/dateTo over hours
      if (options.dateFrom) {
        whereClause += ` AND s.timestamp >= '${options.dateFrom}'::timestamp`;
      } else if (options.hours) {
        whereClause += ` AND s.timestamp >= NOW() - INTERVAL '${options.hours} hours'`;
      } else {
        whereClause += ` AND s.timestamp >= NOW() - INTERVAL '24 hours'`;
      }

      if (options.dateTo) {
        whereClause += ` AND s.timestamp <= '${options.dateTo}'::timestamp`;
      }

      const result = await query(`
        WITH bot_stats AS (
          SELECT 
            UNNEST(st.discovered_by_bots) as bot_name,
            COUNT(DISTINCT st.id) as tokens_scanned,
            COUNT(DISTINCT d.id) as tokens_decided,
            COUNT(DISTINCT CASE WHEN d.should_buy = true THEN d.id END) as tokens_buy,
            COUNT(DISTINCT w.id) as tokens_watchlist,
            COUNT(DISTINCT t.id) as tokens_traded,
            COUNT(DISTINCT CASE WHEN t.status = 'closed' AND t.net_pnl_usd > 0 THEN t.id END) as tokens_profitable,
            AVG(CASE WHEN t.status = 'closed' THEN t.pnl_percent END) as avg_pnl_percent,
            SUM(CASE WHEN t.status = 'closed' THEN t.net_pnl_usd ELSE 0 END) as total_pnl_usd
          FROM scanned_tokens st
          INNER JOIN scans s ON s.id = st.scan_id
          LEFT JOIN decisions d ON d.token_address = st.token_address AND d.scan_id = st.scan_id
          LEFT JOIN watchlist_entries w ON w.decision_id = d.id
          LEFT JOIN trades t ON t.decision_id = d.id
          ${whereClause}
            AND st.discovered_by_bots IS NOT NULL
            AND array_length(st.discovered_by_bots, 1) > 0
          GROUP BY bot_name
        )
        SELECT 
          bot_name,
          tokens_scanned,
          tokens_decided,
          tokens_buy,
          tokens_watchlist,
          tokens_traded,
          tokens_profitable,
          COALESCE(avg_pnl_percent, 0) as avg_pnl_percent,
          COALESCE(total_pnl_usd, 0) as total_pnl_usd,
          CASE WHEN tokens_scanned > 0 THEN (tokens_decided::float / tokens_scanned * 100) ELSE 0 END as decision_rate,
          CASE WHEN tokens_decided > 0 THEN (tokens_buy::float / tokens_decided * 100) ELSE 0 END as buy_rate,
          CASE WHEN tokens_buy > 0 THEN (tokens_traded::float / tokens_buy * 100) ELSE 0 END as trade_rate,
          CASE WHEN tokens_traded > 0 THEN (tokens_profitable::float / tokens_traded * 100) ELSE 0 END as win_rate
        FROM bot_stats
        ORDER BY tokens_scanned DESC
      `);

      return result.rows;
    } catch (error) {
      logger.error('Failed to fetch bot performance data:', error);
      throw error;
    }
  }

  /**
   * Get time series data for trends
   */
  async getTimeSeriesData(hours: number = 24, interval: string = '1 hour'): Promise<any[]> {
    try {
      const result = await query(`
        SELECT 
          DATE_TRUNC('${interval}', s.timestamp) as time_bucket,
          COUNT(DISTINCT st.id) as tokens_scanned,
          COUNT(DISTINCT d.id) as decisions,
          COUNT(DISTINCT CASE WHEN d.should_buy = true THEN d.id END) as buy_decisions,
          COUNT(DISTINCT t.id) as trades,
          COUNT(DISTINCT CASE WHEN t.status = 'closed' AND t.net_pnl_usd > 0 THEN t.id END) as winning_trades,
          AVG(CASE WHEN t.status = 'closed' THEN t.pnl_percent END) as avg_pnl_percent,
          SUM(CASE WHEN t.status = 'closed' THEN t.net_pnl_usd ELSE 0 END) as total_pnl_usd
        FROM scanned_tokens st
        INNER JOIN scans s ON s.id = st.scan_id
        LEFT JOIN decisions d ON d.token_address = st.token_address AND d.scan_id = st.scan_id
        LEFT JOIN trades t ON t.decision_id = d.id
        WHERE s.timestamp >= NOW() - INTERVAL '${hours} hours'
        GROUP BY time_bucket
        ORDER BY time_bucket ASC
      `);

      return result.rows;
    } catch (error) {
      logger.error('Failed to fetch time series data:', error);
      throw error;
    }
  }

  /**
   * Get hourly activity data grouped by hour of day (0-23)
   * Shows activity patterns throughout the day
   */
  async getHourlyActivityData(days: number = 7): Promise<any[]> {
    try {
      const result = await query(`
        SELECT 
          EXTRACT(HOUR FROM s.timestamp) as hour_of_day,
          COUNT(DISTINCT st.id) as tokens_scanned,
          COUNT(DISTINCT d.id) as decisions,
          COUNT(DISTINCT CASE WHEN d.should_buy = true THEN d.id END) as buy_decisions,
          COUNT(DISTINCT t.id) as trades,
          COUNT(DISTINCT CASE WHEN t.status = 'closed' AND t.net_pnl_usd > 0 THEN t.id END) as winning_trades,
          AVG(CASE WHEN t.status = 'closed' THEN t.pnl_percent END) as avg_pnl_percent,
          SUM(CASE WHEN t.status = 'closed' THEN t.net_pnl_usd ELSE 0 END) as total_pnl_usd
        FROM scanned_tokens st
        INNER JOIN scans s ON s.id = st.scan_id
        LEFT JOIN decisions d ON d.token_address = st.token_address AND d.scan_id = st.scan_id
        LEFT JOIN trades t ON t.decision_id = d.id
        WHERE s.timestamp >= NOW() - INTERVAL '${days} days'
        GROUP BY hour_of_day
        ORDER BY hour_of_day ASC
      `);

      // Ensure all 24 hours are represented (fill missing hours with 0)
      const hourMap = new Map(result.rows.map(row => [parseInt(row.hour_of_day), row]));
      const allHours = [];
      for (let hour = 0; hour < 24; hour++) {
        const data = hourMap.get(hour) || {
          hour_of_day: hour,
          tokens_scanned: 0,
          decisions: 0,
          buy_decisions: 0,
          trades: 0,
          winning_trades: 0,
          avg_pnl_percent: null,
          total_pnl_usd: 0
        };
        allHours.push(data);
      }

      return allHours;
    } catch (error) {
      logger.error('Failed to fetch hourly activity data:', error);
      throw error;
    }
  }

  /**
   * Get activity decay analysis data
   * Groups trades by decay 1h buckets and shows win rate / PnL correlation
   */
  async getActivityDecayAnalysis(hours: number = 24 * 7): Promise<any[]> {
    try {
      const result = await query(`
        WITH trade_decay AS (
          SELECT 
            t.id,
            t.symbol,
            t.pnl_percent,
            t.net_pnl_usd,
            t.status,
            st.txn_buys_5m,
            st.txn_sells_5m,
            st.txn_buys_1h,
            st.txn_sells_1h,
            -- Calculate decay: actual h1 / expected h1 (if m5 rate continued)
            CASE 
              WHEN (st.txn_buys_5m + st.txn_sells_5m) > 0 THEN
                (st.txn_buys_1h + st.txn_sells_1h)::float / 
                ((st.txn_buys_5m + st.txn_sells_5m) * 12)::float
              ELSE NULL
            END as decay_1h
          FROM trades t
          INNER JOIN decisions d ON t.decision_id = d.id
          INNER JOIN scanned_tokens st ON st.token_address = d.token_address 
            AND st.scan_id = d.scan_id
          WHERE t.entry_timestamp >= NOW() - INTERVAL '${hours} hours'
            AND t.status = 'closed'
            AND st.txn_buys_5m IS NOT NULL
            AND st.txn_sells_5m IS NOT NULL
            AND st.txn_buys_1h IS NOT NULL
            AND st.txn_sells_1h IS NOT NULL
        ),
        decay_buckets AS (
          SELECT 
            CASE 
              WHEN decay_1h IS NULL THEN 'No Data'
              WHEN decay_1h < 0.25 THEN '0-25%'
              WHEN decay_1h < 0.50 THEN '25-50%'
              WHEN decay_1h < 0.75 THEN '50-75%'
              WHEN decay_1h < 1.00 THEN '75-100%'
              ELSE '100%+'
            END as decay_bucket,
            COUNT(*) as total_trades,
            COUNT(CASE WHEN net_pnl_usd > 0 THEN 1 END) as winning_trades,
            COUNT(CASE WHEN net_pnl_usd <= 0 THEN 1 END) as losing_trades,
            AVG(pnl_percent) as avg_pnl_percent,
            SUM(net_pnl_usd) as total_pnl_usd,
            AVG(decay_1h) as avg_decay
          FROM trade_decay
          WHERE decay_1h IS NOT NULL
          GROUP BY decay_bucket
        )
        SELECT 
          decay_bucket,
          total_trades,
          winning_trades,
          losing_trades,
          CASE WHEN total_trades > 0 THEN (winning_trades::float / total_trades * 100) ELSE 0 END as win_rate,
          COALESCE(avg_pnl_percent, 0) as avg_pnl_percent,
          COALESCE(total_pnl_usd, 0) as total_pnl_usd,
          COALESCE(avg_decay, 0) as avg_decay
        FROM decay_buckets
        ORDER BY 
          CASE decay_bucket
            WHEN '0-25%' THEN 1
            WHEN '25-50%' THEN 2
            WHEN '50-75%' THEN 3
            WHEN '75-100%' THEN 4
            WHEN '100%+' THEN 5
            ELSE 6
          END
      `);

      return result.rows;
    } catch (error) {
      logger.error('Failed to fetch activity decay analysis:', error);
      throw error;
    }
  }

  /**
   * Get returns distribution data for histogram
   * Groups trades by PnL buckets and calculates distribution statistics
   */
  async getReturnsDistribution(options: { hours?: number; dateFrom?: string; dateTo?: string } = {}): Promise<any> {
    try {
      let whereClause = "WHERE t.status = 'closed' AND t.pnl_percent IS NOT NULL";
      
      // Date filtering - prioritize dateFrom/dateTo over hours
      if (options.dateFrom) {
        whereClause += ` AND t.entry_timestamp >= '${options.dateFrom}'::timestamp`;
      } else if (options.hours) {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '${options.hours} hours'`;
      } else {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '168 hours'`;
      }

      if (options.dateTo) {
        whereClause += ` AND t.entry_timestamp <= '${options.dateTo}'::timestamp`;
      }

      // Get all closed trades with PnL
      const tradesResult = await query(`
        SELECT 
          t.pnl_percent,
          t.net_pnl_usd
        FROM trades t
        ${whereClause}
        ORDER BY t.pnl_percent ASC
      `);

      if (tradesResult.rows.length === 0) {
        return {
          buckets: [],
          stats: null,
          trades: []
        };
      }

      const trades = tradesResult.rows.map(row => ({
        pnl_percent: parseFloat(row.pnl_percent),
        net_pnl_usd: parseFloat(row.net_pnl_usd || 0)
      }));

      // Calculate statistics
      const pnlValues = trades.map(t => t.pnl_percent);
      const sortedPnl = [...pnlValues].sort((a, b) => a - b);
      const mean = pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length;
      const variance = pnlValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / pnlValues.length;
      const stdDev = Math.sqrt(variance);
      
      // Calculate skewness (third moment)
      const skewness = stdDev > 0 && pnlValues.length > 0 
        ? pnlValues.reduce((sum, val) => sum + Math.pow((val - mean) / stdDev, 3), 0) / pnlValues.length
        : 0;
      
      // Calculate kurtosis (fourth moment, excess kurtosis = kurtosis - 3)
      const kurtosis = stdDev > 0 && pnlValues.length > 0
        ? pnlValues.reduce((sum, val) => sum + Math.pow((val - mean) / stdDev, 4), 0) / pnlValues.length - 3
        : 0;

      // Create buckets: -50% to +50% in 5% increments (21 buckets)
      const bucketSize = 5;
      const minBucket = -50;
      const maxBucket = 50;
      const buckets: any[] = [];
      
      for (let bucketStart = minBucket; bucketStart < maxBucket; bucketStart += bucketSize) {
        const bucketEnd = bucketStart + bucketSize;
        const bucketTrades = trades.filter(t => 
          t.pnl_percent >= bucketStart && t.pnl_percent < bucketEnd
        );
        
        // Calculate expected count for normal distribution
        const normalCount = trades.length * (
          this.normalCDF((bucketEnd - mean) / stdDev) - 
          this.normalCDF((bucketStart - mean) / stdDev)
        );
        
        buckets.push({
          bucket_start: bucketStart,
          bucket_end: bucketEnd,
          bucket_label: `${bucketStart}% to ${bucketEnd}%`,
          count: bucketTrades.length,
          expected_normal_count: normalCount,
          avg_pnl: bucketTrades.length > 0 
            ? bucketTrades.reduce((sum, t) => sum + t.pnl_percent, 0) / bucketTrades.length 
            : null,
          total_pnl_usd: bucketTrades.reduce((sum, t) => sum + t.net_pnl_usd, 0)
        });
      }

      // Handle outliers: < -50% and > +50%
      const outliersLow = trades.filter(t => t.pnl_percent < minBucket);
      const outliersHigh = trades.filter(t => t.pnl_percent >= maxBucket);
      
      if (outliersLow.length > 0) {
        buckets.unshift({
          bucket_start: -Infinity,
          bucket_end: minBucket,
          bucket_label: `< -50%`,
          count: outliersLow.length,
          expected_normal_count: 0,
          avg_pnl: outliersLow.reduce((sum, t) => sum + t.pnl_percent, 0) / outliersLow.length,
          total_pnl_usd: outliersLow.reduce((sum, t) => sum + t.net_pnl_usd, 0)
        });
      }
      
      if (outliersHigh.length > 0) {
        buckets.push({
          bucket_start: maxBucket,
          bucket_end: Infinity,
          bucket_label: `> +50%`,
          count: outliersHigh.length,
          expected_normal_count: 0,
          avg_pnl: outliersHigh.reduce((sum, t) => sum + t.pnl_percent, 0) / outliersHigh.length,
          total_pnl_usd: outliersHigh.reduce((sum, t) => sum + t.net_pnl_usd, 0)
        });
      }

      return {
        buckets,
        stats: {
          total_trades: trades.length,
          mean,
          std_dev: stdDev,
          skewness,
          kurtosis,
          min: Math.min(...pnlValues),
          max: Math.max(...pnlValues),
          median: sortedPnl.length > 0 
            ? sortedPnl[Math.floor(sortedPnl.length / 2)]
            : 0,
          q25: sortedPnl.length > 0
            ? sortedPnl[Math.floor(sortedPnl.length * 0.25)]
            : 0,
          q75: sortedPnl.length > 0
            ? sortedPnl[Math.floor(sortedPnl.length * 0.75)]
            : 0
        },
        trades: trades.slice(0, 100) // Return first 100 for reference
      };
    } catch (error) {
      logger.error('Failed to fetch returns distribution:', error);
      throw error;
    }
  }

  /**
   * Cumulative distribution function for standard normal distribution
   * Approximation using error function
   */
  private normalCDF(x: number): number {
    // Approximation: 0.5 * (1 + erf(x / sqrt(2)))
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2.0);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Get Sharpe ratio over time (rolling window)
   * Calculates rolling Sharpe ratio for each time period to show strategy performance trend
   */
  async getSharpeRatioOverTime(options: { 
    hours?: number; 
    dateFrom?: string; 
    dateTo?: string;
    windowSize?: number; // Number of trades per window (default: 30)
  } = {}): Promise<any[]> {
    try {
      const windowSize = options.windowSize || 30;
      const params: any[] = [];
      let paramIndex = 1;
      const conditions: string[] = ["t.status = 'closed'", "t.pnl_percent IS NOT NULL"];
      
      // Date filtering with parameterized queries
      if (options.dateFrom) {
        conditions.push(`t.entry_timestamp >= $${paramIndex}::timestamp`);
        params.push(options.dateFrom);
        paramIndex++;
      } else if (options.hours) {
        conditions.push(`t.entry_timestamp >= NOW() - INTERVAL '${options.hours} hours'`);
      } else {
        conditions.push(`t.entry_timestamp >= NOW() - INTERVAL '720 hours'`); // Default 30 days
      }

      if (options.dateTo) {
        conditions.push(`t.entry_timestamp <= $${paramIndex}::timestamp`);
        params.push(options.dateTo);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get all trades ordered by entry time
      const tradesResult = await query(`
        SELECT 
          t.id,
          t.entry_timestamp,
          t.pnl_percent,
          t.net_pnl_usd
        FROM trades t
        ${whereClause}
        ORDER BY t.entry_timestamp ASC
      `, params);

      if (tradesResult.rows.length < windowSize) {
        // Not enough trades for rolling window
        logger.debug(`Sharpe ratio: Not enough trades (${tradesResult.rows.length} < ${windowSize} required)`);
        return [];
      }

      const trades = tradesResult.rows.map(row => ({
        id: row.id,
        timestamp: new Date(row.entry_timestamp),
        pnl_percent: parseFloat(row.pnl_percent),
        net_pnl_usd: parseFloat(row.net_pnl_usd || 0)
      }));

      // Calculate rolling Sharpe ratio
      const sharpeData: any[] = [];
      const riskFreeRate = 0; // 0% for crypto (or could use SOL returns as benchmark)

      for (let i = windowSize - 1; i < trades.length; i++) {
        const window = trades.slice(i - windowSize + 1, i + 1);
        const returns = window.map(t => t.pnl_percent);
        
        // Calculate mean and std dev for this window
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);
        
        // Sharpe Ratio = (Mean Return - Risk-Free Rate) / Std Dev
        // If stdDev is 0, Sharpe is undefined (all returns are the same)
        const sharpeRatio = stdDev > 0 ? (mean - riskFreeRate) / stdDev : null;
        
        // Calculate additional metrics for this window
        const totalTrades = window.length;
        const winningTrades = window.filter(t => t.net_pnl_usd > 0).length;
        const winRate = (winningTrades / totalTrades) * 100;
        const totalPnl = window.reduce((sum, t) => sum + t.net_pnl_usd, 0);
        const avgPnl = mean;

        sharpeData.push({
          timestamp: window[window.length - 1].timestamp.toISOString(),
          sharpe_ratio: sharpeRatio,
          mean_return: mean,
          std_dev: stdDev,
          total_trades: totalTrades,
          win_rate: winRate,
          total_pnl_usd: totalPnl,
          avg_pnl_percent: avgPnl
        });
      }

      logger.debug(`Sharpe ratio: Calculated ${sharpeData.length} data points from ${tradesResult.rows.length} trades`);
      return sharpeData;
    } catch (error) {
      logger.error('Failed to fetch Sharpe ratio over time:', error);
      throw error;
    }
  }

  /**
   * Get drawdown data (cumulative PnL and drawdown from peak)
   * Shows risk and recovery periods
   */
  async getDrawdownData(options: { 
    hours?: number; 
    dateFrom?: string; 
    dateTo?: string;
  } = {}): Promise<any> {
    try {
      let whereClause = "WHERE t.status = 'closed' AND t.pnl_percent IS NOT NULL";
      
      // Date filtering
      if (options.dateFrom) {
        whereClause += ` AND t.entry_timestamp >= '${options.dateFrom}'::timestamp`;
      } else if (options.hours) {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '${options.hours} hours'`;
      } else {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '720 hours'`; // Default 30 days
      }

      if (options.dateTo) {
        whereClause += ` AND t.entry_timestamp <= '${options.dateTo}'::timestamp`;
      }

      // Get all trades ordered by entry time
      const tradesResult = await query(`
        SELECT 
          t.id,
          t.entry_timestamp,
          t.exit_timestamp,
          t.pnl_percent,
          t.net_pnl_usd
        FROM trades t
        ${whereClause}
        ORDER BY t.entry_timestamp ASC
      `);

      if (tradesResult.rows.length === 0) {
        return {
          data: [],
          maxDrawdown: null,
          maxDrawdownPercent: null,
          currentDrawdown: null,
          currentDrawdownPercent: null
        };
      }

      const trades = tradesResult.rows.map(row => ({
        id: row.id,
        entryTimestamp: new Date(row.entry_timestamp),
        exitTimestamp: row.exit_timestamp ? new Date(row.exit_timestamp) : null,
        pnlPercent: parseFloat(row.pnl_percent),
        netPnlUsd: parseFloat(row.net_pnl_usd || 0)
      }));

      // Calculate cumulative PnL and drawdown
      let cumulativePnl = 0;
      let peakPnl = 0;
      let maxDrawdown = 0;
      let maxDrawdownPercent = 0;
      let maxDrawdownStart: Date | null = null;
      let maxDrawdownEnd: Date | null = null;
      let currentDrawdownStart: Date | null = null;
      
      const drawdownData: any[] = [];

      for (const trade of trades) {
        cumulativePnl += trade.netPnlUsd;
        
        // Update peak if we hit a new high
        if (cumulativePnl > peakPnl) {
          peakPnl = cumulativePnl;
          // If we were in drawdown and recovered, mark end
          if (currentDrawdownStart) {
            currentDrawdownStart = null;
          }
        }
        
        // Calculate drawdown from peak
        const drawdown = peakPnl - cumulativePnl;
        // Drawdown %: if peak > 0, use peak as base. If peak <= 0 and we're negative, it's 100%. Otherwise 0%.
        let drawdownPercent = 0;
        if (peakPnl > 0) {
          drawdownPercent = (drawdown / peakPnl) * 100;
        } else if (peakPnl <= 0 && cumulativePnl < 0) {
          // We've never been positive, and we're losing - this is max drawdown
          drawdownPercent = 100;
        } else if (peakPnl <= 0 && cumulativePnl >= 0) {
          // We recovered from negative to positive
          drawdownPercent = 0;
        }
        
        // Track if we're in a drawdown
        if (drawdown > 0 && !currentDrawdownStart) {
          currentDrawdownStart = trade.exitTimestamp || trade.entryTimestamp;
        }
        
        // Track max drawdown
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown;
          maxDrawdownPercent = drawdownPercent;
          if (!maxDrawdownStart) {
            maxDrawdownStart = currentDrawdownStart || trade.entryTimestamp;
          }
          maxDrawdownEnd = trade.exitTimestamp || trade.entryTimestamp;
        }

        drawdownData.push({
          timestamp: (trade.exitTimestamp || trade.entryTimestamp).toISOString(),
          cumulative_pnl_usd: cumulativePnl,
          peak_pnl_usd: peakPnl,
          drawdown_usd: drawdown,
          drawdown_percent: drawdownPercent,
          trade_id: trade.id,
          trade_pnl_usd: trade.netPnlUsd,
          trade_pnl_percent: trade.pnlPercent
        });
      }

      // Calculate current drawdown
      const lastData = drawdownData[drawdownData.length - 1];
      const currentDrawdown = lastData ? lastData.drawdown_usd : 0;
      const currentDrawdownPercent = lastData ? lastData.drawdown_percent : 0;

      return {
        data: drawdownData,
        maxDrawdown: maxDrawdown,
        maxDrawdownPercent: maxDrawdownPercent,
        maxDrawdownStart: maxDrawdownStart?.toISOString() || null,
        maxDrawdownEnd: maxDrawdownEnd?.toISOString() || null,
        currentDrawdown: currentDrawdown,
        currentDrawdownPercent: currentDrawdownPercent,
        totalTrades: trades.length,
        finalCumulativePnl: cumulativePnl
      };
    } catch (error) {
      logger.error('Failed to fetch drawdown data:', error);
      throw error;
    }
  }

  /**
   * Get position size vs PnL data for scatterplot
   * Shows correlation between position size and trade outcomes
   */
  async getPositionSizeVsPnL(options: { 
    hours?: number; 
    dateFrom?: string; 
    dateTo?: string;
  } = {}): Promise<{ trades: any[]; maxPositionUsd: number }> {
    try {
      let whereClause = "WHERE t.status = 'closed' AND t.pnl_percent IS NOT NULL AND t.entry_amount_usd IS NOT NULL";
      
      // Date filtering
      if (options.dateFrom) {
        whereClause += ` AND t.entry_timestamp >= '${options.dateFrom}'::timestamp`;
      } else if (options.hours) {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '${options.hours} hours'`;
      } else {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '720 hours'`; // Default 30 days
      }

      if (options.dateTo) {
        whereClause += ` AND t.entry_timestamp <= '${options.dateTo}'::timestamp`;
      }

      // Get max position size from config
      const maxPositionUsd = parseFloat(process.env.PAPER_MAX_POSITION_USD || '100');

      // Get all trades with position size and PnL
      const tradesResult = await query(`
        SELECT 
          t.id,
          t.symbol,
          t.entry_timestamp,
          t.entry_amount_usd,
          t.pnl_percent,
          t.net_pnl_usd,
          d.confidence
        FROM trades t
        LEFT JOIN decisions d ON t.decision_id = d.id
        ${whereClause}
        ORDER BY t.entry_amount_usd ASC
      `);

      if (tradesResult.rows.length === 0) {
        return {
          trades: [],
          maxPositionUsd
        };
      }

      const trades = tradesResult.rows.map(row => ({
        id: row.id,
        symbol: row.symbol,
        entryTimestamp: new Date(row.entry_timestamp),
        positionSizeUsd: parseFloat(row.entry_amount_usd || 0),
        pnlPercent: parseFloat(row.pnl_percent),
        netPnlUsd: parseFloat(row.net_pnl_usd || 0),
        confidence: row.confidence ? parseInt(row.confidence) : null,
        isWinner: parseFloat(row.net_pnl_usd || 0) > 0
      }));

      return {
        trades,
        maxPositionUsd
      };
    } catch (error) {
      logger.error('Failed to fetch position size vs PnL data:', error);
      throw error;
    }
  }

  /**
   * Calculate correlation matrix between trading metrics and outcomes
   * Returns Pearson correlation coefficients (-1 to +1)
   */
  async getCorrelationMatrix(options: { 
    hours?: number; 
    dateFrom?: string; 
    dateTo?: string;
  } = {}): Promise<any> {
    try {
      let whereClause = "WHERE t.status = 'closed' AND t.pnl_percent IS NOT NULL";
      
      // Date filtering
      if (options.dateFrom) {
        whereClause += ` AND t.entry_timestamp >= '${options.dateFrom}'::timestamp`;
      } else if (options.hours) {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '${options.hours} hours'`;
      } else {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '720 hours'`; // Default 30 days
      }

      if (options.dateTo) {
        whereClause += ` AND t.entry_timestamp <= '${options.dateTo}'::timestamp`;
      }

      // Get all trades with metrics
      const tradesResult = await query(`
        SELECT 
          t.pnl_percent,
          t.net_pnl_usd,
          t.entry_amount_usd,
          d.confidence,
          st.volume_5m,
          st.volume_1h,
          st.age_hours,
          st.buy_sell_ratio,
          st.market_cap,
          st.liquidity,
          st.risk_score,
          st.total_bots_count,
          st.bot_buys,
          st.unique_users
        FROM trades t
        LEFT JOIN decisions d ON t.decision_id = d.id
        LEFT JOIN scanned_tokens st ON st.token_address = d.token_address 
          AND st.scan_id = d.scan_id
        ${whereClause}
      `);

      if (tradesResult.rows.length < 10) {
        return {
          matrix: [],
          metrics: [],
          sampleSize: tradesResult.rows.length
        };
      }

      // Extract numeric arrays for each metric
      const metrics: { [key: string]: number[] } = {
        'PnL %': [],
        'PnL $': [],
        'Position Size': [],
        'Confidence': [],
        'Volume 5m': [],
        'Volume 1h': [],
        'Age (hours)': [],
        'Buy/Sell Ratio': [],
        'Market Cap': [],
        'Liquidity': [],
        'Risk Score': [],
        'Bot Count': [],
        'Bot Buys': [],
        'Unique Users': []
      };

      tradesResult.rows.forEach(row => {
        metrics['PnL %'].push(parseFloat(row.pnl_percent) || 0);
        metrics['PnL $'].push(parseFloat(row.net_pnl_usd) || 0);
        metrics['Position Size'].push(parseFloat(row.entry_amount_usd) || 0);
        metrics['Confidence'].push(parseInt(row.confidence) || 0);
        metrics['Volume 5m'].push(parseFloat(row.volume_5m) || 0);
        metrics['Volume 1h'].push(parseFloat(row.volume_1h) || 0);
        metrics['Age (hours)'].push(parseFloat(row.age_hours) || 0);
        metrics['Buy/Sell Ratio'].push(parseFloat(row.buy_sell_ratio) || 0);
        metrics['Market Cap'].push(parseFloat(row.market_cap) || 0);
        metrics['Liquidity'].push(parseFloat(row.liquidity) || 0);
        metrics['Risk Score'].push(parseInt(row.risk_score) || 0);
        metrics['Bot Count'].push(parseInt(row.total_bots_count) || 0);
        metrics['Bot Buys'].push(parseInt(row.bot_buys) || 0);
        metrics['Unique Users'].push(parseInt(row.unique_users) || 0);
      });

      // Filter out metrics with insufficient data (all zeros or nulls)
      const validMetrics: string[] = [];
      Object.keys(metrics).forEach(key => {
        const values = metrics[key];
        const hasVariation = values.some(v => v !== 0) && 
                           values.some((v, i) => i === 0 || v !== values[0]);
        if (hasVariation && values.length > 0) {
          validMetrics.push(key);
        }
      });

      // Calculate correlation matrix
      const matrix: any[] = [];
      
      for (let i = 0; i < validMetrics.length; i++) {
        const row: any[] = [];
        for (let j = 0; j < validMetrics.length; j++) {
          if (i === j) {
            row.push({ value: 1.0, metric1: validMetrics[i], metric2: validMetrics[j] });
          } else {
            const correlation = this.calculateCorrelation(
              metrics[validMetrics[i]],
              metrics[validMetrics[j]]
            );
            row.push({ 
              value: correlation, 
              metric1: validMetrics[i], 
              metric2: validMetrics[j] 
            });
          }
        }
        matrix.push(row);
      }

      return {
        matrix,
        metrics: validMetrics,
        sampleSize: tradesResult.rows.length
      };
    } catch (error) {
      logger.error('Failed to calculate correlation matrix:', error);
      throw error;
    }
  }

  /**
   * Calculate Pearson correlation coefficient
   */
  private calculateCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length === 0) return 0;

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    if (denominator === 0) return 0;
    return numerator / denominator;
  }

  /**
   * Calculate Alpha and Beta over time
   * Alpha = Excess return vs SOL (risk-adjusted)
   * Beta = Correlation with SOL movements (market exposure)
   */
  async getAlphaBetaAnalysis(options: { 
    hours?: number; 
    dateFrom?: string; 
    dateTo?: string;
    windowSize?: number;
  } = {}): Promise<any> {
    try {
      let whereClause = "WHERE t.status = 'closed' AND t.pnl_percent IS NOT NULL AND t.sol_price_entry IS NOT NULL AND t.sol_price_exit IS NOT NULL";
      
      // Date filtering
      if (options.dateFrom) {
        whereClause += ` AND t.entry_timestamp >= '${options.dateFrom}'::timestamp`;
      } else if (options.hours) {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '${options.hours} hours'`;
      } else {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '720 hours'`; // Default 30 days
      }

      if (options.dateTo) {
        whereClause += ` AND t.entry_timestamp <= '${options.dateTo}'::timestamp`;
      }

      const windowSize = options.windowSize || 30; // Rolling window size

      // Get all trades with SOL price data
      const tradesResult = await query(`
        SELECT 
          t.id,
          t.symbol,
          t.entry_timestamp,
          t.exit_timestamp,
          t.pnl_percent,
          t.net_pnl_usd,
          t.sol_price_entry,
          t.sol_price_exit
        FROM trades t
        ${whereClause}
        ORDER BY t.exit_timestamp ASC
      `);

      if (tradesResult.rows.length < windowSize) {
        return {
          data: [],
          overallAlpha: 0,
          overallBeta: 0,
          avgAlpha: 0,
          avgBeta: 0,
          sampleSize: tradesResult.rows.length
        };
      }

      // Calculate per-trade metrics
      const trades = tradesResult.rows.map(row => {
        const tokenReturn = parseFloat(row.pnl_percent);
        const solReturn = ((parseFloat(row.sol_price_exit) - parseFloat(row.sol_price_entry)) / parseFloat(row.sol_price_entry)) * 100;
        const alpha = tokenReturn - solReturn; // Excess return vs SOL
        
        return {
          id: row.id,
          symbol: row.symbol,
          exitTimestamp: new Date(row.exit_timestamp),
          tokenReturn,
          solReturn,
          alpha,
          netPnlUsd: parseFloat(row.net_pnl_usd || 0)
        };
      });

      // Calculate rolling Alpha and Beta
      const rollingData: any[] = [];
      
      for (let i = windowSize - 1; i < trades.length; i++) {
        const windowTrades = trades.slice(i - windowSize + 1, i + 1);
        const tokenReturns = windowTrades.map(t => t.tokenReturn);
        const solReturns = windowTrades.map(t => t.solReturn);
        const alphas = windowTrades.map(t => t.alpha);
        
        // Calculate rolling metrics
        const avgAlpha = alphas.reduce((a, b) => a + b, 0) / alphas.length;
        const beta = this.calculateCorrelation(tokenReturns, solReturns);
        
        // Calculate beta slope (regression slope)
        const betaSlope = this.calculateBetaSlope(tokenReturns, solReturns);
        
        rollingData.push({
          timestamp: windowTrades[windowTrades.length - 1].exitTimestamp.toISOString(),
          avgAlpha,
          beta,
          betaSlope,
          cumulativeAlpha: alphas.reduce((a, b) => a + b, 0),
          windowSize: windowTrades.length
        });
      }

      // Calculate overall metrics
      const allTokenReturns = trades.map(t => t.tokenReturn);
      const allSolReturns = trades.map(t => t.solReturn);
      const allAlphas = trades.map(t => t.alpha);
      
      const overallAlpha = allAlphas.reduce((a, b) => a + b, 0) / allAlphas.length;
      const overallBeta = this.calculateCorrelation(allTokenReturns, allSolReturns);
      const overallBetaSlope = this.calculateBetaSlope(allTokenReturns, allSolReturns);
      const avgAlpha = overallAlpha;
      const avgBeta = overallBeta;

      return {
        data: rollingData,
        overallAlpha,
        overallBeta,
        overallBetaSlope,
        avgAlpha,
        avgBeta,
        sampleSize: trades.length,
        trades: trades.slice(-50) // Last 50 trades for scatterplot
      };
    } catch (error) {
      logger.error('Failed to calculate alpha/beta analysis:', error);
      throw error;
    }
  }

  /**
   * Calculate Beta slope (regression slope) - how much token moves per 1% SOL move
   */
  private calculateBetaSlope(tokenReturns: number[], solReturns: number[]): number {
    if (tokenReturns.length !== solReturns.length || tokenReturns.length === 0) return 0;

    const n = tokenReturns.length;
    const sumX = solReturns.reduce((a, b) => a + b, 0);
    const sumY = tokenReturns.reduce((a, b) => a + b, 0);
    const sumXY = solReturns.reduce((sum, xi, i) => sum + xi * tokenReturns[i], 0);
    const sumX2 = solReturns.reduce((sum, xi) => sum + xi * xi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = n * sumX2 - sumX * sumX;

    if (denominator === 0) return 0;
    return numerator / denominator;
  }

  /**
   * Calculate Kelly Criterion for optimal position sizing
   * Formula: f* = (p × b - q) / b
   * Where: p = win rate, q = loss rate (1-p), b = average win / average loss
   */
  async getKellyCriterion(options: { 
    hours?: number; 
    dateFrom?: string; 
    dateTo?: string;
  } = {}): Promise<any> {
    try {
      let whereClause = "WHERE t.status = 'closed' AND t.pnl_percent IS NOT NULL";
      
      // Date filtering
      if (options.dateFrom) {
        whereClause += ` AND t.entry_timestamp >= '${options.dateFrom}'::timestamp`;
      } else if (options.hours) {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '${options.hours} hours'`;
      } else {
        whereClause += ` AND t.entry_timestamp >= NOW() - INTERVAL '720 hours'`; // Default 30 days
      }

      if (options.dateTo) {
        whereClause += ` AND t.entry_timestamp <= '${options.dateTo}'::timestamp`;
      }

      // Get all closed trades
      const tradesResult = await query(`
        SELECT 
          t.pnl_percent,
          t.net_pnl_usd,
          t.entry_amount_usd
        FROM trades t
        ${whereClause}
        ORDER BY t.exit_timestamp ASC
      `);

      if (tradesResult.rows.length < 10) {
        return {
          kellyPercent: 0,
          fractionalKelly: {
            quarter: 0,
            half: 0,
            threeQuarter: 0
          },
          winRate: 0,
          avgWin: 0,
          avgLoss: 0,
          riskRewardRatio: 0,
          sampleSize: tradesResult.rows.length,
          recommendation: 'Insufficient data'
        };
      }

      const trades = tradesResult.rows.map(row => ({
        pnlPercent: parseFloat(row.pnl_percent),
        netPnlUsd: parseFloat(row.net_pnl_usd || 0),
        entryAmountUsd: parseFloat(row.entry_amount_usd || 0)
      }));

      // Separate winners and losers
      const winners = trades.filter(t => t.pnlPercent > 0);
      const losers = trades.filter(t => t.pnlPercent <= 0);

      // Calculate win rate
      const winRate = winners.length / trades.length;
      const lossRate = 1 - winRate;

      // Calculate average win and loss
      const avgWin = winners.length > 0 
        ? winners.reduce((sum, t) => sum + Math.abs(t.pnlPercent), 0) / winners.length 
        : 0;
      const avgLoss = losers.length > 0 
        ? losers.reduce((sum, t) => sum + Math.abs(t.pnlPercent), 0) / losers.length 
        : 0;

      // Calculate risk/reward ratio (b in Kelly formula)
      // b = average win / average loss
      const riskRewardRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

      // Calculate Kelly Criterion
      // f* = (p × b - q) / b
      // Where: p = win rate, q = loss rate, b = risk/reward ratio
      let kellyPercent = 0;
      if (riskRewardRatio > 0 && winRate > 0) {
        kellyPercent = ((winRate * riskRewardRatio) - lossRate) / riskRewardRatio;
        // Kelly can be negative (don't bet) or > 1 (over-leverage)
        kellyPercent = Math.max(0, Math.min(1, kellyPercent)); // Clamp between 0 and 1
      }

      // Calculate fractional Kelly (safer alternatives)
      const fractionalKelly = {
        quarter: kellyPercent * 0.25,
        half: kellyPercent * 0.5,
        threeQuarter: kellyPercent * 0.75
      };

      // Generate recommendation
      let recommendation = '';
      if (kellyPercent <= 0) {
        recommendation = '⚠️ Kelly ≤ 0: Strategy is not profitable. Do not trade.';
      } else if (kellyPercent > 0.5) {
        recommendation = '⚠️ Kelly > 50%: Too aggressive! Use fractional Kelly (25-50%).';
      } else if (kellyPercent > 0.25) {
        recommendation = '✅ Kelly 25-50%: Consider using fractional Kelly (25-50%) for safety.';
      } else {
        recommendation = '✅ Kelly < 25%: Reasonable position size. Consider fractional Kelly for extra safety.';
      }

      return {
        kellyPercent: kellyPercent * 100, // Convert to percentage
        fractionalKelly: {
          quarter: fractionalKelly.quarter * 100,
          half: fractionalKelly.half * 100,
          threeQuarter: fractionalKelly.threeQuarter * 100
        },
        winRate: winRate * 100,
        avgWin,
        avgLoss,
        riskRewardRatio,
        sampleSize: trades.length,
        winnersCount: winners.length,
        losersCount: losers.length,
        recommendation,
        formula: {
          p: winRate,
          q: lossRate,
          b: riskRewardRatio,
          kelly: kellyPercent * 100
        }
      };
    } catch (error) {
      logger.error('Failed to calculate Kelly Criterion:', error);
      throw error;
    }
  }

  /**
   * Get candle data (OHLCV) before scan timestamp
   * Returns candlestick data for price action visualization before discovery
   */
  async getPreScanCandles(
    tokenAddress: string,
    chain: string,
    scanTimestamp: string,
    minutesBefore: number = 30
  ): Promise<{
    candles: Array<{
      timestamp: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      timeframe: string;
    }>;
    scanTimestamp: string;
    scanPrice: number | null;
    symbol: string | null;
  }> {
    try {
      const scanTime = new Date(scanTimestamp);
      const startTime = new Date(scanTime.getTime() - minutesBefore * 60 * 1000);
      
      // Get scan price and symbol
      const scanTimeStart = new Date(scanTime.getTime() - 1000);
      const scanTimeEnd = new Date(scanTime.getTime() + 1000);
      
      const scanResult = await query(`
        SELECT 
          st.symbol,
          st.price_usd as scan_price
        FROM scanned_tokens st
        INNER JOIN scans s ON s.id = st.scan_id
        WHERE st.token_address = $1
          AND st.chain = $2
          AND s.timestamp >= $3
          AND s.timestamp <= $4
        ORDER BY st.created_at DESC
        LIMIT 1
      `, [tokenAddress, chain, scanTimeStart, scanTimeEnd]);
      
      const scanPrice = scanResult.rows[0]?.scan_price ? parseFloat(scanResult.rows[0].scan_price) : null;
      const symbol = scanResult.rows[0]?.symbol || null;
      
      // Get candle data before scan timestamp (use 5m candles for cleaner chart)
      const result = await query(`
        SELECT 
          timeframe,
          timestamp,
          open_price,
          high_price,
          low_price,
          close_price,
          volume
        FROM candle_data
        WHERE token_address = $1
          AND chain = $2
          AND timeframe = '5m'
          AND timestamp >= $3
          AND timestamp < $4
        ORDER BY timestamp ASC
      `, [
        tokenAddress,
        chain,
        Math.floor(startTime.getTime() / 1000), // Unix timestamp in seconds
        Math.floor(scanTime.getTime() / 1000)
      ]);
      
      const candles = result.rows.map(row => ({
        timestamp: new Date(row.timestamp * 1000).toISOString(),
        open: parseFloat(row.open_price),
        high: parseFloat(row.high_price),
        low: parseFloat(row.low_price),
        close: parseFloat(row.close_price),
        volume: parseFloat(row.volume),
        timeframe: row.timeframe
      }));
      
      return {
        candles,
        scanTimestamp,
        scanPrice,
        symbol
      };
    } catch (error) {
      logger.error('Failed to fetch pre-scan candles:', error);
      throw error;
    }
  }

  /**
   * Get price history for a token from scan time to end of tracking
   * Returns price data points for charting
   */
  async getPriceHistory(tokenAddress: string, chain: string, scanTimestamp: string): Promise<{
    prices: Array<{ timestamp: string; price_usd: number }>;
    scanTimestamp: string;
    scanPrice: number | null;
    symbol: string | null;
  }> {
    try {
      // Get price history from scan timestamp to +1 hour (limit to first hour for chart clarity)
      const scanTime = new Date(scanTimestamp);
      const oneHourLater = new Date(scanTime.getTime() + 60 * 60 * 1000);
      
      // Get scan price and symbol from scanned_tokens (needed as baseline for peak gain calculation)
      // Use a range match because scanTimestamp from frontend may have different precision/format
      // Frontend: 2025-11-24T21:28:22.086Z, Database: 2025-11-24 21:28:22.086137
      // Convert scanTimestamp to Date first, then use range match
      const scanTimeForQuery = new Date(scanTimestamp);
      const scanTimeStart = new Date(scanTimeForQuery.getTime() - 1000); // -1 second
      const scanTimeEnd = new Date(scanTimeForQuery.getTime() + 1000);   // +1 second
      
      const scanResult = await query(`
        SELECT 
          st.symbol,
          st.price_usd as scan_price,
          st.created_at as scan_created_at
        FROM scanned_tokens st
        INNER JOIN scans s ON s.id = st.scan_id
        WHERE st.token_address = $1
          AND st.chain = $2
          AND s.timestamp >= $3
          AND s.timestamp <= $4
        ORDER BY st.created_at DESC
        LIMIT 1
      `, [tokenAddress, chain, scanTimeStart, scanTimeEnd]);
      
      const scanPrice = scanResult.rows[0]?.scan_price ? parseFloat(scanResult.rows[0].scan_price) : null;
      const symbol = scanResult.rows[0]?.symbol || null;
      const scanCreatedAt = scanResult.rows[0]?.scan_created_at;
      
      // Get price history from price_history table
      const result = await query(`
        SELECT 
          ph.timestamp,
          ph.price_usd
        FROM price_history ph
        WHERE ph.token_address = $1
          AND ph.chain = $2
          AND ph.timestamp >= $3
          AND ph.timestamp <= $4
        ORDER BY ph.timestamp ASC
      `, [tokenAddress, chain, scanTimestamp, oneHourLater]);

      const prices: Array<{ timestamp: string; price_usd: number }> = [];
      
      // CRITICAL: Include scan price as first point if available
      // This ensures charts show the baseline and can calculate peak gain correctly
      // Without this, if first price in history is the peak, chart shows 0% gain
      // Use scan_timestamp (from scans table) as the timestamp to ensure it's included in time filter
      if (scanPrice) {
        // Add scan price with scan timestamp (ensures it's the first point and not filtered out)
        // IMPORTANT: Normalize timestamp format to ISO with Z suffix for consistency
        // Backend returns timestamps with/without Z, which can cause timezone issues in frontend
        const scanTimestampISO = scanTimestamp.includes('T') 
          ? (scanTimestamp.endsWith('Z') ? scanTimestamp : scanTimestamp + 'Z')
          : new Date(scanTimestamp).toISOString();
        prices.push({
          timestamp: scanTimestampISO, // Normalized ISO string with Z
          price_usd: scanPrice
        });
      }
      
      // Add all price history points (deduplicate by timestamp)
      const seenTimestamps = new Set<string>();
      for (const row of result.rows) {
        const timestamp = row.timestamp.toISOString();
        if (!seenTimestamps.has(timestamp)) {
          prices.push({
            timestamp,
            price_usd: parseFloat(row.price_usd)
          });
          seenTimestamps.add(timestamp);
        }
      }
      
      // Sort by timestamp to ensure correct order
      prices.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      return {
        prices,
        scanTimestamp,
        scanPrice,
        symbol
      };
    } catch (error) {
      logger.error('Failed to fetch price history:', error);
      throw error;
    }
  }

  /**
   * Get current market regime
   * Returns the latest regime data from most recent scan
   */
  async getCurrentRegime(chain?: string): Promise<RegimeData | null> {
    try {
      const chainFilter = chain ? `AND chain = $1` : '';
      const params = chain ? [chain] : [];

      const result = await query(`
        SELECT 
          regime_trend_score,
          regime_liquidity_score,
          regime_risk_score,
          regime_micro_score,
          market_winrate_1h,
          market_ev_1h,
          sol_ret_1h,
          sol_ret_6h,
          sol_volatility_1h,
          sol_trend_strength,
          total_transactions,
          tokens_found,
          timestamp
        FROM scans
        WHERE regime_trend_score IS NOT NULL
          ${chainFilter}
        ORDER BY timestamp DESC
        LIMIT 1
      `, params);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      // Calculate classifications from scores (not stored in DB)
      const {
        classifyGlobalRegime,
        classifyTrendRegime,
        classifyLiquidityRegime,
        classifyRiskRegime,
        classifyMicroRegime,
      } = await import('./regime-detector');
      
      const trendScore = parseFloat(row.regime_trend_score || 0);
      const liquidityScore = parseFloat(row.regime_liquidity_score || 0);
      const riskScore = parseFloat(row.regime_risk_score || 0);
      const microScore = parseFloat(row.regime_micro_score || 0);
      const marketEv = parseFloat(row.market_ev_1h || 0);
      
      const trendRegime = classifyTrendRegime(trendScore);
      const liquidityRegime = classifyLiquidityRegime(liquidityScore);
      const riskRegime = classifyRiskRegime(riskScore, marketEv); // median_peak_gain not stored, uses market_ev
      const microRegime = classifyMicroRegime(microScore);
      const globalRegime = classifyGlobalRegime(trendRegime, liquidityRegime, riskRegime, microRegime);

      // Get regime-adjusted trading parameters
      const { getRegimeAdjustedParameters } = await import('./regime-detector');
      const tradingParams = getRegimeAdjustedParameters(globalRegime);

      return {
        scores: {
          trend_score: parseFloat(row.regime_trend_score || 0),
          liquidity_score: parseFloat(row.regime_liquidity_score || 0),
          risk_score: parseFloat(row.regime_risk_score || 0),
          micro_score: parseFloat(row.regime_micro_score || 0),
        },
        classifications: {
          trend_regime: trendRegime,
          liquidity_regime: liquidityRegime,
          risk_regime: riskRegime,
          micro_regime: microRegime,
          global_regime: globalRegime,
        },
        trading_parameters: {
          position_size_multiplier: tradingParams.position_size_multiplier,
          tp_levels: tradingParams.tp_levels,
          sl_percent: tradingParams.sl_percent,
          entry_threshold_adjustment: tradingParams.entry_threshold_adjustment,
        },
        metadata: {
          sol_ret_1h: parseFloat(row.sol_ret_1h || 0),
          sol_ret_6h: parseFloat(row.sol_ret_6h || 0),
          sol_volatility_1h: parseFloat(row.sol_volatility_1h || 0),
          sol_trend_strength: parseFloat(row.sol_trend_strength || 0),
          total_transactions: parseInt(row.total_transactions || 0),
          tokens_found: parseInt(row.tokens_found || 0),
          market_winrate_1h: parseFloat(row.market_winrate_1h || 0),
          market_ev_1h: parseFloat(row.market_ev_1h || 0),
        },
        timestamp: new Date(row.timestamp),
      };
    } catch (error) {
      logger.error('Failed to fetch current regime:', error);
      throw error;
    }
  }

  /**
   * Get regime history for charts
   * Returns regime data for last N hours
   */
  async getRegimeHistory(hours: number = 24, chain?: string): Promise<any[]> {
    try {
      const chainFilter = chain ? `AND chain = $2` : '';
      const params = chain ? [hours, chain] : [hours];

      const result = await query(`
        SELECT 
          timestamp,
          regime_trend_score,
          regime_liquidity_score,
          regime_risk_score,
          regime_micro_score,
          market_winrate_1h,
          market_ev_1h,
          sol_ret_1h,
          sol_ret_6h
        FROM scans
        WHERE timestamp >= NOW() - INTERVAL '${hours} hours'
          AND regime_trend_score IS NOT NULL
          ${chainFilter}
        ORDER BY timestamp ASC
      `, params);

      // Calculate classifications from scores (not stored in DB)
      const {
        classifyGlobalRegime,
        classifyTrendRegime,
        classifyLiquidityRegime,
        classifyRiskRegime,
        classifyMicroRegime,
      } = await import('./regime-detector');

      return result.rows.map((row) => {
        const trendScore = parseFloat(row.regime_trend_score || 0);
        const liquidityScore = parseFloat(row.regime_liquidity_score || 0);
        const riskScore = parseFloat(row.regime_risk_score || 0);
        const microScore = parseFloat(row.regime_micro_score || 0);
        const marketEv = parseFloat(row.market_ev_1h || 0);
        
        const trendRegime = classifyTrendRegime(trendScore);
        const liquidityRegime = classifyLiquidityRegime(liquidityScore);
        const riskRegime = classifyRiskRegime(riskScore, marketEv); // median_peak_gain not stored, uses market_ev
        const microRegime = classifyMicroRegime(microScore);
        const globalRegime = classifyGlobalRegime(trendRegime, liquidityRegime, riskRegime, microRegime);

        return {
          timestamp: row.timestamp,
          scores: {
            trend: parseFloat(row.regime_trend_score || 0),
            liquidity: parseFloat(row.regime_liquidity_score || 0),
            risk: parseFloat(row.regime_risk_score || 0),
            micro: parseFloat(row.regime_micro_score || 0),
          },
          classifications: {
            trend: trendRegime,
            liquidity: liquidityRegime,
            risk: riskRegime,
            micro: microRegime,
            global: globalRegime,
          },
          metadata: {
            market_winrate_1h: parseFloat(row.market_winrate_1h || 0),
            market_ev_1h: parseFloat(row.market_ev_1h || 0),
            sol_ret_1h: parseFloat(row.sol_ret_1h || 0),
            sol_ret_6h: parseFloat(row.sol_ret_6h || 0),
          },
        };
      });
    } catch (error) {
      logger.error('Failed to fetch regime history:', error);
      throw error;
    }
  }
}

export const analyticsAPI = new AnalyticsAPI();

