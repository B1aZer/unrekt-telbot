/**
 * Paper Trading Engine
 * 
 * Simulates trades based on AI BUY decisions
 * - Auto-executes on BUY signal
 * - Tracks positions
 * - Auto-exits on stop loss / take profit / time
 * - Simulates slippage (0.5%) and fees (0.3%)
 */

import { query, getClient } from '../infra/database';
import { logger } from '../utils/logger';
import type { TradingDecision } from './trading-analyzer';
import type { DecisionLogger } from './decision-logger';
import { PositionMonitor } from './position-monitor';
import { getChainConfig, Chain } from '../config/chain';
import { getStrategyId } from '../config/strategy';

// ============================================================================
// Types
// ============================================================================

export interface PaperTrade {
  id: number;
  decisionId: number;
  
  // Token
  tokenAddress: string;
  symbol: string;
  
  // Entry
  entryTimestamp: number;
  entryPrice: number;
  entryAmountUsd: number;
  entrySlippage: number;      // 0.5%
  entryFee: number;           // 0.3%
  actualEntryPrice: number;   // After slippage
  actualEntryCost: number;    // After fees
  tokensBought: number;
  
  // Exit (when closed)
  exitTimestamp?: number;
  exitPrice?: number;
  exitReason?: 'stop_loss' | 'take_profit_1' | 'take_profit_2' | 'take_profit_3' | 'time_based' | 'manual';
  exitSlippage?: number;
  exitFee?: number;
  actualExitPrice?: number;
  actualExitAmount?: number;
  
  // Results
  pnlPercent?: number;
  pnlUsd?: number;
  holdDurationMinutes?: number;
  maxPriceReached?: number;
  maxGainPercent?: number;
  
  // Status
  status: 'open' | 'closed' | 'failed';
  
  // Risk Management (from decision)
  stopLossPercent: number;
  takeProfitLevels: Array<{ percentage: number; sellPercent: number }>;
  timeBasedExitSeconds: number;
}

export interface PaperTradingStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  
  // Results
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  
  // PnL
  totalPnlUsd: number;
  avgPnlPercent: number;
  avgWinningPnl: number;
  avgLosingPnl: number;
  
  // Portfolio
  initialBalance: number;
  currentBalance: number;
  portfolioReturnPercent: number;
  
  // Best/Worst
  bestTradeSymbol: string;
  bestTradePnl: number;
  worstTradeSymbol: string;
  worstTradePnl: number;
  
  // Timing
  avgHoldDuration: number;
  
  // Exit Reasons
  stopLossCount: number;
  takeProfitCount: number;
  timeBasedCount: number;
  tp1_count: number;
  tp2_count: number;
  tp3_count: number;
}

// ============================================================================
// Configuration
// ============================================================================

const PAPER_TRADING_CONFIG = {
  // Starting capital (for tracking only - not used for position sizing)
  INITIAL_BALANCE_USD: parseFloat(process.env.PAPER_TRADING_INITIAL_BALANCE_USD || '1000'),
  
  // Real trading is NOT supported in main paper trader - only in shadow mode
  // USE_REAL_TRADING: false (always paper trading)
  
  // Slippage & Fees (simulated for paper, actual for real trading)
  ENTRY_SLIPPAGE: parseFloat(process.env.PAPER_ENTRY_SLIPPAGE || '0.5'),  // 0.5%
  EXIT_SLIPPAGE: parseFloat(process.env.PAPER_EXIT_SLIPPAGE || '0.5'),    // 0.5%
  ENTRY_FEE: parseFloat(process.env.PAPER_ENTRY_FEE || '0.3'),            // 0.3%
  EXIT_FEE: parseFloat(process.env.PAPER_EXIT_FEE || '0.3'),              // 0.3%
  
  // Position sizing mode
  USE_FIXED_POSITION_SIZE: process.env.PAPER_USE_FIXED_POSITION === 'true',
  FIXED_POSITION_PERCENT: parseFloat(process.env.PAPER_FIXED_POSITION_PERCENT || '1'),  // % of balance
  
  // Position sizing limits (percentage-based, scales with balance)
  MIN_POSITION_PERCENT: parseFloat(process.env.PAPER_MIN_POSITION_PERCENT || '0.5'),  // Minimum 0.5%
  MAX_POSITION_PERCENT: parseFloat(process.env.PAPER_MAX_POSITION_PERCENT || '2'),    // Maximum 2% (exceptional trades)
  
  // Monitor interval
  MONITOR_INTERVAL_MS: parseInt(process.env.PAPER_MONITOR_INTERVAL || '30000', 10), // 30 seconds
};

logger.info('💰 Paper Trading Config:');
logger.info(`  Initial Balance: $${PAPER_TRADING_CONFIG.INITIAL_BALANCE_USD} (tracking only)`);
if (PAPER_TRADING_CONFIG.USE_FIXED_POSITION_SIZE) {
  logger.info(`  Position Size: FIXED ${PAPER_TRADING_CONFIG.FIXED_POSITION_PERCENT}% of current balance (ignoring AI recommendation)`);
} else {
  logger.info(`  Position Size: Dynamic % based on AI recommendation`);
  logger.info(`    Min: ${PAPER_TRADING_CONFIG.MIN_POSITION_PERCENT}% | Max: ${PAPER_TRADING_CONFIG.MAX_POSITION_PERCENT}% (scales with balance)`);
}
logger.info(`  Entry Slippage: ${PAPER_TRADING_CONFIG.ENTRY_SLIPPAGE}%`);
logger.info(`  Exit Slippage: ${PAPER_TRADING_CONFIG.EXIT_SLIPPAGE}%`);
logger.info(`  Entry Fee: ${PAPER_TRADING_CONFIG.ENTRY_FEE}%`);
logger.info(`  Exit Fee: ${PAPER_TRADING_CONFIG.EXIT_FEE}%`);
logger.info(`  Monitor Interval: ${PAPER_TRADING_CONFIG.MONITOR_INTERVAL_MS / 1000}s`);

// ============================================================================
// Paper Trader
// ============================================================================

export class PaperTrader {
  private enabled: boolean;
  private monitoringInterval: Timer | null = null;
  private positionMonitor!: PositionMonitor; // Initialized conditionally if enabled
  
  constructor() {
    // Check if paper trading is enabled
    this.enabled = process.env.PAPER_TRADING_ENABLED !== 'false';
    
    if (this.enabled) {
      logger.success('✅ Paper Trading enabled');
      this.positionMonitor = new PositionMonitor();
    } else {
      logger.warn('⚠️  Paper Trading disabled (set PAPER_TRADING_ENABLED=true to enable)');
    }
  }
  
  /**
   * Fetch SOL price from DexScreener (free, no DB writes)
   * Uses SOL/USDC pair on Raydium
   */
  private async getSOLPrice(): Promise<number | null> {
    try {
      const chainConfig = getChainConfig();
      
      // Only fetch for Solana chain
      if (chainConfig.chain !== Chain.SOLANA) {
        return null;
      }
      
      // SOL/USDC pair on Raydium (most liquid)
      const solUsdcPair = '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm';
      const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${solUsdcPair}`;
      
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn(`DexScreener API error: ${response.status}`);
        return null;
      }
      
      const data = await response.json() as { pair?: { priceUsd?: string | number } };
      const solPrice = parseFloat(String(data.pair?.priceUsd || 0));
      
      if (isNaN(solPrice) || solPrice <= 0) {
        logger.warn('Invalid SOL price from DexScreener');
        return null;
      }
      
      return solPrice;
    } catch (error) {
      logger.error('Failed to fetch SOL price:', error);
      return null;
    }
  }
  
  /**
   * Execute a paper trade based on AI decision
   */
  async executeTrade(
    decision: TradingDecision,
    decisionId: number,
    currentPrice: number
  ): Promise<number | null> {
    if (!this.enabled) {
      logger.debug('Paper trading disabled, skipping execution');
      return null;
    }
    
    try {
      // Check if we already have an open position for this token
      const existingResult = await query(`
        SELECT id, symbol, entry_timestamp
        FROM trades
        WHERE token_address = $1 AND status = 'open'
        LIMIT 1
      `, [decision.token]);
      
      if (existingResult.rows.length > 0) {
        const existingPosition = existingResult.rows[0];
        const entryTime = new Date(existingPosition.entry_timestamp);
        const holdMinutes = Math.floor((Date.now() - entryTime.getTime()) / 60000);
        logger.warn(`${decision.symbol}: Already have open position #${existingPosition.id} (held ${holdMinutes}min) - skipping duplicate trade`);
        return null;
      }
      
      // Calculate position size
      let positionSizeUsd: number;
      
      if (PAPER_TRADING_CONFIG.USE_FIXED_POSITION_SIZE) {
        // FIXED SIZE MODE: Use fixed % of current balance (ignores AI recommendation)
        const currentBalance = (await this.getStats(24)).currentBalance;
        positionSizeUsd = (currentBalance * PAPER_TRADING_CONFIG.FIXED_POSITION_PERCENT) / 100;
        logger.debug(`Position sizing: FIXED ${PAPER_TRADING_CONFIG.FIXED_POSITION_PERCENT}% of $${currentBalance.toFixed(2)} = $${positionSizeUsd.toFixed(2)} (ignoring AI recommendation)`);
      } else {
        // DYNAMIC SIZE MODE: Use AI's percentage recommendation
        const stats = await this.getStats(24); // Get current portfolio stats
        const currentBalance = stats.currentBalance;
        
        // Get AI's recommended percentage (fallback to 1% if not provided)
        // Position sizing philosophy: Conservative to preserve capital
        // - 0.5-1.5%: Normal trades (most common)
        // - 2%: Exceptional high-confidence setups only
        let positionPercent = decision.positionSize?.percentage || 1;
        
        // Validate percentage is reasonable (safety check)
        if (typeof positionPercent !== 'number' || isNaN(positionPercent)) {
          logger.error(`${decision.symbol}: Invalid position percentage (${positionPercent}), using 1% default`);
          positionPercent = 1;
        }
        
        // Cap percentage between configured min and max (conservative limits aligned with ML training)
        // ML models assume position sizing in this range for risk management
        const minPercent = PAPER_TRADING_CONFIG.MIN_POSITION_PERCENT;
        const maxPercent = PAPER_TRADING_CONFIG.MAX_POSITION_PERCENT;
        
        if (positionPercent < minPercent) {
          logger.warn(`${decision.symbol}: Position percentage too low (${positionPercent}%), using ${minPercent}% minimum`);
          positionPercent = minPercent;
        } else if (positionPercent > maxPercent) {
          logger.warn(`${decision.symbol}: Position percentage too high (${positionPercent}%), capping at ${maxPercent}% (max for exceptional trades)`);
          positionPercent = maxPercent;
        }
        
        // Calculate USD amount based on CURRENT balance
        // No absolute USD cap - position size scales with balance
        // Example: 2% of $1000 = $20, 2% of $500 = $10, 2% of $5000 = $100
        positionSizeUsd = (currentBalance * positionPercent) / 100;
        
        logger.debug(`Position sizing: ${positionPercent}% of $${currentBalance.toFixed(2)} = $${positionSizeUsd.toFixed(2)}`);
      }
      
      // PAPER TRADING: Simulate slippage and fees
      const slippageMultiplier = 1 + (PAPER_TRADING_CONFIG.ENTRY_SLIPPAGE / 100);
      const actualEntryPrice = currentPrice * slippageMultiplier;
      
      // Calculate tokens bought before fees
      const tokensBeforeFees = positionSizeUsd / actualEntryPrice;
      
      // Apply entry fee
      const feeMultiplier = 1 - (PAPER_TRADING_CONFIG.ENTRY_FEE / 100);
      const tokensBought = tokensBeforeFees * feeMultiplier;
      
      // Actual cost including fees
      const actualEntryCost = positionSizeUsd;
      
      // Set TPs based on dynamic trailing flag
      // If dynamic trailing is enabled, disable TPs. Otherwise, use TPs.
      const USE_DYNAMIC_TRAILING = process.env.PAPER_ENABLE_DYNAMIC_TRAILING === 'true';
      
      let tp1: number | null = null;
      let tp1SellPercent: number | null = null;
      let tp2: number | null = null;
      let tp2SellPercent: number | null = null;
      let tp3: number | null = null;
      let tp3SellPercent: number | null = null;
      
      if (!USE_DYNAMIC_TRAILING) {
        // TPs enabled - parse from env
        const tpLevels = (process.env.PAPER_DEFAULT_TP_LEVELS || '15,30,45').split(',').map(x => parseFloat(x.trim()));
        const tpSellPercents = (process.env.PAPER_DEFAULT_TP_SELL_PERCENTS || '80,10,10').split(',').map(x => parseFloat(x.trim()));
        
        tp1 = tpLevels.length > 0 ? tpLevels[0] : null;
        tp1SellPercent = tpSellPercents.length > 0 ? tpSellPercents[0] : null;
        tp2 = tpLevels.length > 1 ? tpLevels[1] : null;
        tp2SellPercent = tpSellPercents.length > 1 ? tpSellPercents[1] : null;
        tp3 = tpLevels.length > 2 ? tpLevels[2] : null;
        tp3SellPercent = tpSellPercents.length > 2 ? tpSellPercents[2] : null;
      }
      const stopLoss = decision.riskManagement?.stopLoss || -15;
      
      // Time-based exit: Use environment variable for primary timed exit
      // If PAPER_ENABLE_TIMED_EXIT is true, use PAPER_TIMED_EXIT_MINUTES (default: 30 min)
      // Otherwise, use PAPER_TRADING_MAX_HOLD_HOURS as safety timeout (default: 24 hours)
      const enableTimedExit = process.env.PAPER_ENABLE_TIMED_EXIT === 'true';
      let timeExit: number;
      
      if (enableTimedExit) {
        // Primary timed exit strategy (e.g., 30 minutes)
        const timedExitMinutes = parseInt(process.env.PAPER_TIMED_EXIT_MINUTES || '30', 10);
        timeExit = timedExitMinutes * 60; // Convert to seconds
        logger.debug(`[Timed Exit] Using primary exit: ${timedExitMinutes} minutes (${timeExit}s)`);
      } else {
        // Safety timeout only (e.g., 24 hours)
        const maxHoldHours = parseInt(process.env.PAPER_TRADING_MAX_HOLD_HOURS || '24', 10);
        timeExit = maxHoldHours * 3600; // Convert to seconds
        logger.debug(`[Time Exit] Using safety timeout: ${maxHoldHours} hours (${timeExit}s)`);
      }
      
      // DEBUG: Log what we're about to save (before INSERT)
      logger.info(`💾 SAVING TRADE - About to INSERT into trades table:`);
      logger.info(`   TP1: ${tp1}% (sell ${tp1SellPercent}%)`);
      logger.info(`   TP2: ${tp2}% (sell ${tp2SellPercent}%)`);
      logger.info(`   TP3: ${tp3}% (sell ${tp3SellPercent}%)`);
      logger.info(`   SL: ${stopLoss}%`);
      logger.info(`   Time Exit: ${timeExit}s (${Math.floor(timeExit / 60)}min)${enableTimedExit ? ' [Primary Strategy]' : ' [Safety Timeout]'}`);
      logger.info(`   Strategy: ${USE_DYNAMIC_TRAILING ? 'Dynamic Trailing Stop' : 'Take Profits + Timed Exit'}`);
      
      // Fetch SOL price for beta calculation (DexScreener - no DB write)
      const solPrice = await this.getSOLPrice();
      if (solPrice) {
        logger.debug(`📊 SOL price at entry: $${solPrice.toFixed(2)}`);
      }
      
      // Get strategy ID for tracking
      const strategyId = await getStrategyId();
      
      // Insert trade WITH risk management parameters using PostgreSQL syntax
      const result = await query(`
        INSERT INTO trades (
          decision_id, chain, token_address, symbol,
          entry_price, entry_amount_usd,
          entry_slippage_percent, entry_fee_percent,
          actual_entry_price, actual_entry_cost, tokens_bought,
          stop_loss_percent, 
          take_profit_1, take_profit_1_sell_percent,
          take_profit_2, take_profit_2_sell_percent,
          take_profit_3, take_profit_3_sell_percent,
          time_based_exit_seconds,
          remaining_tokens,
          sol_price_entry,
          strategy_id,
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
        RETURNING id
      `, [
        decisionId,
        getChainConfig().chain, // Add chain
        decision.token,
        decision.symbol,
        currentPrice,
        positionSizeUsd,
        PAPER_TRADING_CONFIG.ENTRY_SLIPPAGE,
        PAPER_TRADING_CONFIG.ENTRY_FEE,
        actualEntryPrice,
        actualEntryCost,
        tokensBought,
        stopLoss,
        tp1,
        tp1SellPercent,
        tp2,
        tp2SellPercent,
        tp3,
        tp3SellPercent,
        timeExit,
        tokensBought,  // remaining_tokens = tokens_bought initially
        solPrice,      // SOL price at entry (for beta)
        strategyId,    // Strategy that generated this trade
        'open'
      ]);
      
      const tradeId = result.rows[0].id;
      
      // DEBUG: Verify what was actually saved to database
      const savedTradeResult = await query(`SELECT * FROM trades WHERE id = $1`, [tradeId]);
      const savedTrade = savedTradeResult.rows[0];
      logger.info(`✅ TRADE SAVED - Verifying from database (ID: ${tradeId}):`);
      logger.info(`   SL in DB: ${savedTrade.stop_loss_percent}%`);
      
      if (USE_DYNAMIC_TRAILING) {
        logger.info(`   Strategy: Dynamic Trailing Stop (TPs disabled)`);
        logger.info(`   Dynamic Trailing: Enabled (activate at +${process.env.PAPER_DYNAMIC_TRAILING_ACTIVATION || '3'}%, trail -${process.env.PAPER_DYNAMIC_TRAILING_DISTANCE || '3'}%)`);
      } else {
        logger.info(`   Strategy: Take Profits with TP Trailing Stops`);
        logger.info(`   TP1 in DB: ${savedTrade.take_profit_1}% (sell ${savedTrade.take_profit_1_sell_percent}%)`);
        logger.info(`   TP2 in DB: ${savedTrade.take_profit_2}% (sell ${savedTrade.take_profit_2_sell_percent}%)`);
        logger.info(`   TP3 in DB: ${savedTrade.take_profit_3}% (sell ${savedTrade.take_profit_3_sell_percent}%)`);
      }
      
      logger.success(`💰 Paper trade executed: #${tradeId} ${decision.symbol}`);
      logger.info(`  Entry Price: $${currentPrice.toExponential(4)} (actual: $${actualEntryPrice.toExponential(4)} +${PAPER_TRADING_CONFIG.ENTRY_SLIPPAGE}% slippage)`);
      logger.info(`  Position: $${positionSizeUsd.toFixed(2)} → ${tokensBought.toExponential(4)} tokens (after ${PAPER_TRADING_CONFIG.ENTRY_FEE}% fee)`);
      logger.info(`  Stop Loss: ${stopLoss}%`);
      if (USE_DYNAMIC_TRAILING) {
        logger.info(`  Exit Strategy: Dynamic trailing stop only`);
      } else {
        logger.info(`  Take Profits: ${tp1}%, ${tp2}%, ${tp3}%`);
      }
      logger.info(`  Time Exit: ${timeExit}s (${timeExit > 0 ? Math.floor(timeExit / 60) + 'min' : 'disabled'})`);
      
      return tradeId;
      
    } catch (error: any) {
      logger.error('Failed to execute paper trade:');
      logger.error(`  Token: ${decision.symbol} (${decision.token})`);
      logger.error(`  Decision ID: ${decisionId}`);
      logger.error(`  Error: ${error.message || error}`);
      if (error.code) logger.error(`  Code: ${error.code}`);
      if (error.errno) logger.error(`  Errno: ${error.errno}`);
      return null;
    }
  }
  
  /**
   * Start monitoring open positions
   */
  startMonitoring(): void {
    if (!this.enabled) {
      logger.debug('Paper trading disabled, not starting monitor');
      return;
    }
    
    if (this.monitoringInterval) {
      logger.warn('Position monitor already running');
      return;
    }
    
    logger.info(`📊 Starting position monitor (checking every ${PAPER_TRADING_CONFIG.MONITOR_INTERVAL_MS / 1000}s)`);
    
    // Check immediately
    this.checkPositions();
    
    // Then check at interval
    this.monitoringInterval = setInterval(() => {
      this.checkPositions();
    }, PAPER_TRADING_CONFIG.MONITOR_INTERVAL_MS);
  }
  
  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      logger.info('📊 Position monitor stopped');
    }
  }
  
  /**
   * Check all open positions and exit if conditions met
   */
  private async checkPositions(): Promise<void> {
    try {
      await this.positionMonitor.checkAndExitPositions();
    } catch (error) {
      logger.error('Error checking positions:', error);
    }
  }
  
  /**
   * Get all open trades
   */
  async getOpenTrades(): Promise<any[]> {
    const result = await query(`
      SELECT *
      FROM trades
      WHERE status = 'open'
        AND chain = $1
      ORDER BY entry_timestamp DESC
    `, [getChainConfig().chain]);
    return result.rows;
  }
  
  /**
   * Get a specific trade by ID
   */
  async getTradeById(tradeId: number): Promise<any | null> {
    const result = await query(`
      SELECT * FROM trades WHERE id = $1
    `, [tradeId]);
    return result.rows[0] || null;
  }
  
  /**
   * Get recent closed trades since a given timestamp
   */
  async getRecentExits(sinceTimestamp: number): Promise<any[]> {
    const sinceDate = new Date(sinceTimestamp);
    const result = await query(`
      SELECT *
      FROM trades
      WHERE status = 'closed'
        AND chain = $1
        AND exit_timestamp >= $2
      ORDER BY exit_timestamp DESC
    `, [getChainConfig().chain, sinceDate]);
    return result.rows;
  }
  
  /**
   * Get paper trading statistics
   */
  async getStats(hours: number = 24): Promise<PaperTradingStats> {
    // Get 24h stats for display (trade counts, TP/SL breakdown)
    const statsResult = await query(`
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_trades,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_trades,
        SUM(CASE WHEN status = 'closed' AND pnl_percent > 0 THEN 1 ELSE 0 END) as winning_trades,
        SUM(CASE WHEN status = 'closed' AND pnl_percent < 0 THEN 1 ELSE 0 END) as losing_trades,
        AVG(CASE WHEN status = 'closed' THEN pnl_percent END) as avg_pnl_percent,
        AVG(CASE WHEN status = 'closed' AND pnl_percent > 0 THEN pnl_percent END) as avg_winning_pnl,
        AVG(CASE WHEN status = 'closed' AND pnl_percent < 0 THEN pnl_percent END) as avg_losing_pnl,
        SUM(CASE WHEN status = 'closed' THEN net_pnl_usd ELSE 0 END) as total_pnl_usd_24h,
        AVG(CASE WHEN status = 'closed' THEN hold_duration_minutes END) as avg_hold_duration,
        SUM(CASE WHEN status = 'closed' AND exit_reason = 'stop_loss' THEN 1 ELSE 0 END) as stop_loss_count,
        SUM(CASE WHEN status = 'closed' AND tp1_hit = TRUE THEN 1 ELSE 0 END) as tp1_count,
        SUM(CASE WHEN status = 'closed' AND tp2_hit = TRUE THEN 1 ELSE 0 END) as tp2_count,
        SUM(CASE WHEN status = 'closed' AND tp3_hit = TRUE THEN 1 ELSE 0 END) as tp3_count,
        SUM(CASE WHEN status = 'closed' AND exit_reason LIKE 'take_profit%' THEN 1 ELSE 0 END) as take_profit_count,
        SUM(CASE WHEN status = 'closed' AND exit_reason = 'time_based' THEN 1 ELSE 0 END) as time_based_count
      FROM trades
      WHERE entry_timestamp >= NOW() - INTERVAL '${hours} hours'
        AND chain = $1
    `, [getChainConfig().chain]);
    
    const stats = statsResult.rows[0];
    
    // Get ALL-TIME portfolio value (not just 24h window)
    const portfolioResult = await query(`
      SELECT 
        SUM(CASE WHEN status = 'closed' THEN net_pnl_usd ELSE 0 END) as total_pnl_usd_all_time
      FROM trades
      WHERE chain = $1
    `, [getChainConfig().chain]);
    
    const bestTradeResult = await query(`
      SELECT symbol, pnl_percent
      FROM trades
      WHERE status = 'closed'
        AND chain = $1
        AND entry_timestamp >= NOW() - INTERVAL '${hours} hours'
      ORDER BY pnl_percent DESC
      LIMIT 1
    `, [getChainConfig().chain]);
    
    const bestTrade = bestTradeResult.rows[0];
    
    const worstTradeResult = await query(`
      SELECT symbol, pnl_percent
      FROM trades
      WHERE status = 'closed'
        AND chain = $1
        AND entry_timestamp >= NOW() - INTERVAL '${hours} hours'
      ORDER BY pnl_percent ASC
      LIMIT 1
    `, [getChainConfig().chain]);
    
    const worstTrade = worstTradeResult.rows[0];
    
    const winRate = stats.closed_trades > 0
      ? (stats.winning_trades / stats.closed_trades) * 100
      : 0;
    
    // Calculate portfolio metrics - USE ALL-TIME PnL, not 24h window
    const initialBalance = PAPER_TRADING_CONFIG.INITIAL_BALANCE_USD;
    const totalPnlUsdAllTime = Number((parseFloat(portfolioResult.rows[0].total_pnl_usd_all_time) || 0).toFixed(2));
    const currentBalance = initialBalance + totalPnlUsdAllTime;
    const portfolioReturnPercent = initialBalance > 0
      ? Number(((totalPnlUsdAllTime / initialBalance) * 100).toFixed(2))
      : 0;
    
    // Use 24h PnL for the stats display (shows recent performance)
    const totalPnlUsd = Number((parseFloat(stats.total_pnl_usd_24h) || 0).toFixed(2));
    
    return {
      totalTrades: parseInt(stats.total_trades) || 0,
      openTrades: parseInt(stats.open_trades) || 0,
      closedTrades: parseInt(stats.closed_trades) || 0,
      winningTrades: parseInt(stats.winning_trades) || 0,
      losingTrades: parseInt(stats.losing_trades) || 0,
      winRate: Number(winRate.toFixed(2)),
      totalPnlUsd: totalPnlUsd, // 24h PnL for stats display
      avgPnlPercent: Number((parseFloat(stats.avg_pnl_percent) || 0).toFixed(2)),
      avgWinningPnl: Number((parseFloat(stats.avg_winning_pnl) || 0).toFixed(2)),
      avgLosingPnl: Number((parseFloat(stats.avg_losing_pnl) || 0).toFixed(2)),
      initialBalance: initialBalance,
      currentBalance: Number(currentBalance.toFixed(2)),
      portfolioReturnPercent: portfolioReturnPercent,
      bestTradeSymbol: bestTrade?.symbol || 'N/A',
      bestTradePnl: Number((parseFloat(bestTrade?.pnl_percent) || 0).toFixed(2)),
      worstTradeSymbol: worstTrade?.symbol || 'N/A',
      worstTradePnl: Number((parseFloat(worstTrade?.pnl_percent) || 0).toFixed(2)),
      avgHoldDuration: Number((parseFloat(stats.avg_hold_duration) || 0).toFixed(0)),
      stopLossCount: parseInt(stats.stop_loss_count) || 0,
      takeProfitCount: parseInt(stats.take_profit_count) || 0,
      timeBasedCount: parseInt(stats.time_based_count) || 0,
      tp1_count: parseInt(stats.tp1_count) || 0,
      tp2_count: parseInt(stats.tp2_count) || 0,
      tp3_count: parseInt(stats.tp3_count) || 0,
    };
  }

  /**
   * Get strategy performance metrics for ML threshold adjustment
   * Returns daily P&L and recent win rate (last 10 trades)
   * Matches backtest logic: reversible threshold decay based on daily losses + recent recovery
   */
  async getStrategyPerformance(): Promise<{
    dailyPnlUsd: number;
    dailyPnlPct: number;  // Daily P&L as % of balance at START of day (matches backtest)
    recentWinRate: number | null;
    recentTradesCount: number;
  }> {
    const chainConfig = getChainConfig();
    
    // Get today's P&L (from trades closed today)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const dailyPnlResult = await query(`
      SELECT 
        COALESCE(SUM(net_pnl_usd), 0) as daily_pnl_usd
      FROM trades
      WHERE chain = $1
        AND status = 'closed'
        AND DATE(exit_timestamp) = CURRENT_DATE
    `, [chainConfig.chain]);
    
    const dailyPnlUsd = Number((parseFloat(dailyPnlResult.rows[0]?.daily_pnl_usd) || 0).toFixed(2));
    
    // Get balance at START of today (end of yesterday) for percentage calculation
    // This matches backtest logic: daily_pnl_pct = daily_pnl_usd / starting_balance
    // We need: balance_at_start_of_today = current_balance - today's_pnl
    const stats = await this.getStats(24);
    const currentBalance = stats.currentBalance;
    const balanceAtStartOfDay = currentBalance - dailyPnlUsd;  // Balance before today's trades
    
    // Calculate daily P&L as percentage of balance at START of day (matches backtest)
    // Example: Start of day: $2,000, today's loss: $20 → 20/2000 = 1%
    const dailyPnlPct = balanceAtStartOfDay > 0 ? (dailyPnlUsd / balanceAtStartOfDay) : 0;
    
    // Get recent trades (last 10 closed trades) for win rate calculation
    // Use net_pnl_usd > 0 instead of pnl_percent > 0 to match backtest's net_return > 0
    // This is equivalent: net_pnl_usd > 0 ⟺ net_return > 0 (both account for costs)
    const recentTradesResult = await query(`
      SELECT 
        pnl_percent,
        net_pnl_usd
      FROM trades
      WHERE chain = $1
        AND status = 'closed'
        AND net_pnl_usd IS NOT NULL
      ORDER BY exit_timestamp DESC
      LIMIT 10
    `, [chainConfig.chain]);
    
    const recentTrades = recentTradesResult.rows;
    let recentWinRate: number | null = null;
    
    if (recentTrades.length >= 5) {
      // Need at least 5 trades to assess recovery (matches backtest)
      // Use net_pnl_usd > 0 (equivalent to net_return > 0 in backtest)
      // Both account for costs: bot uses USD P&L, backtest uses percentage subtraction
      const wins = recentTrades.filter(t => parseFloat(t.net_pnl_usd) > 0).length;
      recentWinRate = wins / recentTrades.length;
    }
    
    return {
      dailyPnlUsd,
      dailyPnlPct,
      recentWinRate,
      recentTradesCount: recentTrades.length,
    };
  }
  
  isEnabled(): boolean {
    return this.enabled;
  }
}

