/**
 * Position Monitor
 * 
 * Monitors open paper trading positions and auto-exits when:
 * - Stop loss hit
 * - Take profit target reached
 * - Time-based exit triggered
 * 
 * Fetches real-time prices from DexScreener
 * 
 * IMPORTANT: PnL Percentage Calculation Strategy
 * ================================================
 * All percentage-based calculations (TP/SL checks, max gain, PnL %) use RAW entry_price
 * (before slippage) to maintain consistency across the entire system:
 * 
 * 1. ML Training: Predicts tokens that reach +X% from raw entry price
 * 2. Position Monitor: Checks TP/SL at +X% from raw entry price (THIS FILE)
 * 3. Analytics: Displays price gains from raw entry/scan price
 * 
 * Why raw prices for percentages?
 * - ML model is trained on raw price movements (e.g., "will reach +15%")
 * - Using actual_entry_price would create a ~0.5% mismatch with ML predictions
 * - Example: ML predicts +15% gain, token reaches +15%, but bot sees only +14.5%
 * 
 * Slippage and fees ARE applied for USD P&L calculations:
 * - entry_price: Raw price used for percentage calculations
 * - actual_entry_price: Raw price + 0.5% slippage (used for USD cost basis)
 * - actual_entry_cost: USD spent including slippage and fees
 * - Final net_pnl_usd: Accounts for all transaction costs
 * 
 * This ensures ML predictions align with live trading behavior.
 */

import { query } from '../infra/database';
import { logger } from '../utils/logger';
import { getChainConfig, Chain } from '../config/chain';
import { priceService } from './price-tracking';

// ============================================================================
// Configuration
// ============================================================================

const EXIT_SLIPPAGE = parseFloat(process.env.PAPER_EXIT_SLIPPAGE || '0.5');  // 0.5%
const EXIT_FEE = parseFloat(process.env.PAPER_EXIT_FEE || '0.3');            // 0.3%

// Dynamic trailing stop (simple enable/disable)
const ENABLE_DYNAMIC_TRAILING = process.env.PAPER_ENABLE_DYNAMIC_TRAILING === 'true';
const DYNAMIC_TRAILING_ACTIVATION = parseFloat(process.env.PAPER_DYNAMIC_TRAILING_ACTIVATION || '3');  // Start trailing at +3%
const DYNAMIC_TRAILING_DISTANCE = parseFloat(process.env.PAPER_DYNAMIC_TRAILING_DISTANCE || '3');      // Trail 3% below peak

// Trailing stop loss levels (after TP hits - only used when TPs are enabled)
const TRAILING_STOP_AFTER_TP1 = parseFloat(process.env.PAPER_TRAILING_STOP_AFTER_TP1 || '0');  // 0% (breakeven)
const TRAILING_STOP_AFTER_TP2 = parseFloat(process.env.PAPER_TRAILING_STOP_AFTER_TP2 || '10');   // +10%

// Timed exit configuration
const ENABLE_TIMED_EXIT = process.env.PAPER_ENABLE_TIMED_EXIT === 'true';
const TIMED_EXIT_MINUTES = parseInt(process.env.PAPER_TIMED_EXIT_MINUTES || '10');

// ============================================================================
// Position Monitor
// ============================================================================

export class PositionMonitor {
  constructor() {
    logger.info('📊 Position Monitor initialized (PostgreSQL)');
    
    // Parse TP levels and sell percentages from config
    const tpLevelsStr = process.env.PAPER_DEFAULT_TP_LEVELS || '15,100,500';
    const tpSellPercentsStr = process.env.PAPER_DEFAULT_TP_SELL_PERCENTS || '50,30,20';
    const tpLevels = tpLevelsStr.split(',').map(s => parseFloat(s.trim()));
    const tpSellPercents = tpSellPercentsStr.split(',').map(s => parseFloat(s.trim()));
    
    if (ENABLE_TIMED_EXIT) {
      logger.info(`⏰ Strategy: Timed Exit (${TIMED_EXIT_MINUTES} minutes) + Take Profits`);
      logger.info(`   Timed exit: ENABLED - Exit remaining position after ${TIMED_EXIT_MINUTES} minutes`);
      logger.info(`   Stop Loss: ENABLED (emergency protection, moves to 0% after TP1)`);
      if (tpLevels.length > 0) {
        logger.info(`   Take Profit 1: ENABLED at +${tpLevels[0]}% (sell ${tpSellPercents[0] || 50}%, matches ML activation threshold)`);
      }
      if (tpLevels.length > 1) {
        logger.info(`   Take Profit 2: ENABLED at +${tpLevels[1]}% (sell ${tpSellPercents[1] || 30}% of original)`);
      }
      if (tpLevels.length > 2) {
        logger.info(`   Take Profit 3: ENABLED at +${tpLevels[2]}% (sell ${tpSellPercents[2] || 20}% of original)`);
      }
      logger.info(`   Trailing Stop: DISABLED (TPs + timed exit strategy)`);
    } else if (ENABLE_DYNAMIC_TRAILING) {
      logger.info(`🔒 Strategy: Dynamic Trailing Stop (TPs disabled)`);
      logger.info(`   Dynamic trailing: Activate at +${DYNAMIC_TRAILING_ACTIVATION}%, trail -${DYNAMIC_TRAILING_DISTANCE}%`);
    } else {
      logger.info(`🎯 Strategy: Take Profits with TP Trailing Stops`);
      logger.info(`   Dynamic trailing: DISABLED`);
    }
  }
  
  /**
   * Fetch SOL price from DexScreener (free, no DB writes)
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
        return null;
      }
      
      const data = await response.json() as { pair?: { priceUsd?: string | number } };
      const solPrice = parseFloat(String(data.pair?.priceUsd || 0));
      
      if (isNaN(solPrice) || solPrice <= 0) {
        return null;
      }
      
      return solPrice;
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Check all open positions and exit if conditions met
   * Uses Codex batch price fetching for efficiency
   */
  async checkAndExitPositions(): Promise<void> {
    const openTrades = await this.getOpenTrades();
    
    if (openTrades.length === 0) {
      return;
    }
    
    logger.debug(`📊 Checking ${openTrades.length} open positions...`);
    
    // Fetch all prices in one batch call using price service
    const tokenAddresses = openTrades.map(t => t.token_address);
    const priceMap = await priceService.getPrices(tokenAddresses);
    
    // Check each position with its price
    for (const trade of openTrades) {
      try {
        // For Solana, addresses are case-sensitive base58, so match exactly
        const currentPrice = priceMap.get(trade.token_address);
        
        if (!currentPrice) {
          logger.warn(`Unable to fetch price for ${trade.symbol}, skipping`);
          continue;
        }
        
        await this.checkPosition(trade, currentPrice);
      } catch (error) {
        logger.error(`Error checking position #${trade.id}:`, error);
      }
    }
  }
  
  /**
   * Check a single position
   */
  private async checkPosition(trade: any, currentPrice: number): Promise<void> {
    logger.debug(`🔍 [checkPosition] Starting check for trade #${trade.id} ${trade.symbol}`);
    
    // IMPORTANT: Use RAW entry_price (before slippage) for percentage calculations
    // This ensures consistency with:
    // 1. ML training (predicts based on raw price movements)
    // 2. Analytics (displays raw price gains)
    // 3. TP/SL triggers (should match ML predictions)
    // Slippage is only applied when calculating USD P&L amounts
    const entryPrice = trade.entry_price;  // Raw price (before slippage)
    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    
    // Update max price reached
    if (!trade.max_price_reached || currentPrice > trade.max_price_reached) {
      try {
        await this.updateMaxPrice(trade.id, currentPrice);
        // Update trade object for this check cycle
        trade.max_price_reached = currentPrice;
      } catch (error) {
        logger.error(`[PositionMonitor] Failed to update max price for trade #${trade.id} (${trade.symbol}):`);
        logger.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof Error && error.stack) {
          logger.error(`   Stack: ${error.stack}`);
        }
        // Continue - don't block position checking
      }
    }
    
    // DYNAMIC TRAILING STOP (only if enabled and timed exit is disabled)
    // When timed exit is enabled, we disable trailing to avoid premature exits
    // Note: entryPrice here is already the raw price (set above)
    if (ENABLE_DYNAMIC_TRAILING && !ENABLE_TIMED_EXIT && trade.max_price_reached) {
      const maxGainPercent = ((trade.max_price_reached - entryPrice) / entryPrice) * 100;
      
      // Only activate trailing if we've reached the activation threshold
      if (maxGainPercent >= DYNAMIC_TRAILING_ACTIVATION) {
        const trailingStopPercent = maxGainPercent - DYNAMIC_TRAILING_DISTANCE;
        
        // Only move SL up, never down
        if (trailingStopPercent > trade.stop_loss_percent) {
          try {
            await query(`
              UPDATE trades
              SET stop_loss_percent = $1
              WHERE id = $2
            `, [trailingStopPercent, trade.id]);
            
            logger.info(
              `🔒 [DYNAMIC TRAILING] ${trade.symbol}: ` +
              `Peak ${maxGainPercent.toFixed(1)}% → SL moved to ${trailingStopPercent.toFixed(1)}% ` +
              `(was ${trade.stop_loss_percent.toFixed(1)}%, trailing -${DYNAMIC_TRAILING_DISTANCE}%)`
            );
            
            // Update trade object for this check cycle
            trade.stop_loss_percent = trailingStopPercent;
          } catch (error) {
            logger.error(`[PositionMonitor] Failed to update trailing stop for trade #${trade.id} (${trade.symbol}):`);
            logger.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
            logger.error(`   Trade ID: ${trade.id}, Trailing SL: ${trailingStopPercent}%`);
            if (error instanceof Error && error.stack) {
              logger.error(`   Stack: ${error.stack}`);
            }
            // Continue - don't block position checking
          }
        }
      }
    }
    
    logger.debug(`🔍 [checkPosition] PnL calculated: ${pnlPercent.toFixed(2)}%`);
    
    logger.debug(`🔍 [checkPosition] PnL calculated: ${pnlPercent.toFixed(2)}%`);
    
    // Track max drawdown (worst negative PnL during trade)
    // Only update if current PnL is negative and worse than previous max drawdown
    if (pnlPercent < 0) {
      const currentDrawdown = pnlPercent; // Already negative
      const existingDrawdown = trade.max_drawdown_percent || 0; // 0 means no drawdown tracked yet
      
      // Update if this is a worse drawdown (more negative)
      if (currentDrawdown < existingDrawdown) {
        try {
          await this.updateMaxDrawdown(trade.id, currentDrawdown);
          logger.debug(`📉 [Drawdown] New max drawdown for ${trade.symbol}: ${currentDrawdown.toFixed(2)}% (was ${existingDrawdown.toFixed(2)}%)`);
        } catch (error) {
          logger.error(`[PositionMonitor] Failed to update max drawdown for trade #${trade.id} (${trade.symbol}):`);
          logger.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof Error && error.stack) {
            logger.error(`   Stack: ${error.stack}`);
          }
          // Continue - don't block position checking
        }
      }
    }
    
    // Calculate hold duration
    const entryTime = new Date(trade.entry_timestamp).getTime();
    const now = Date.now();
    const holdDurationMinutes = Math.floor((now - entryTime) / 60000);
    const holdDurationSeconds = Math.floor((now - entryTime) / 1000);
    
    // DEBUG: Log position status
    logger.debug(`🔍 [POSITION DEBUG] ${trade.symbol} (ID: ${trade.id})`);
    logger.debug(`  Current PnL: ${pnlPercent.toFixed(2)}%`);
    logger.debug(`  Stop Loss: ${trade.stop_loss_percent}%`);
    logger.debug(`  Max Price Reached: $${trade.max_price_reached?.toExponential(6) || 'N/A'}`);
    logger.debug(`  Remaining tokens: ${trade.remaining_tokens.toExponential(4)} (original: ${trade.tokens_bought.toExponential(4)})`);
    logger.debug(`  Time Exit: ${trade.time_based_exit_seconds}s (${trade.time_based_exit_seconds ? Math.floor(trade.time_based_exit_seconds / 60) + 'min' : 'disabled'})`);
    
    // Check exit conditions
    let shouldExit = false;
    let exitReason: string | null = null;
    let partialExit = false;
    let sellPercent = 100; // Default: sell 100% (for SL or time exit)
    
    // 1. Stop Loss (exits entire position) - ALWAYS ACTIVE as emergency protection
    // Even with timed exit enabled, SL protects against catastrophic dumps
    if (pnlPercent <= trade.stop_loss_percent) {
      shouldExit = true;
      exitReason = 'stop_loss';
      sellPercent = 100;
      logger.info(`🛑 Stop loss hit for ${trade.symbol}: ${pnlPercent.toFixed(2)}% (threshold: ${trade.stop_loss_percent}%)`);
    }
    
    // 2. Take Profit Levels (checked BEFORE timed exit so TPs take priority)
    // Strategy: TP1 at +15% (matches ML activation threshold), TP2 at +30%, TP3 at +45%
    // All TPs work even with timed exit - timed exit only exits remaining position
    if (!ENABLE_DYNAMIC_TRAILING && !shouldExit) {
      if (!trade.tp1_hit && trade.take_profit_1 && pnlPercent >= trade.take_profit_1) {
        shouldExit = true;
        partialExit = true;
        exitReason = 'take_profit_1';
        sellPercent = trade.take_profit_1_sell_percent || 100;
        logger.success(`🎯 Take profit 1 hit for ${trade.symbol}: ${pnlPercent.toFixed(2)}% (target: ${trade.take_profit_1}%) - Selling ${sellPercent}% (ML activation threshold)`);
      } else if (!shouldExit && !trade.tp2_hit && trade.take_profit_2 && pnlPercent >= trade.take_profit_2) {
        shouldExit = true;
        partialExit = true;
        exitReason = 'take_profit_2';
        sellPercent = trade.take_profit_2_sell_percent || 100;
        logger.success(`🎯 Take profit 2 hit for ${trade.symbol}: ${pnlPercent.toFixed(2)}% (target: ${trade.take_profit_2}%) - Selling ${sellPercent}%`);
      } else if (!shouldExit && !trade.tp3_hit && trade.take_profit_3 && pnlPercent >= trade.take_profit_3) {
        shouldExit = true;
        partialExit = true;
        exitReason = 'take_profit_3';
        sellPercent = trade.take_profit_3_sell_percent || 100;
        logger.success(`🎯 Take profit 3 hit for ${trade.symbol}: ${pnlPercent.toFixed(2)}% (target: ${trade.take_profit_3}%) - Selling ${sellPercent}%`);
      }
    }
    
    // 3. Timed Exit (global timed exit - exits remaining position after X minutes)
    // Checked AFTER TP1 so TP1 takes priority if price reaches +15% before 30min
    // If TP1 was hit, this exits the remaining 50%. Otherwise, exits 100%.
    if (!shouldExit && ENABLE_TIMED_EXIT && holdDurationMinutes >= TIMED_EXIT_MINUTES) {
      shouldExit = true;
      exitReason = 'timed_exit';
      sellPercent = 100; // Exit 100% of remaining position (if TP1 hit, remaining is 50%)
      const positionRemaining = (trade.remaining_tokens / trade.tokens_bought) * 100;
      logger.info(`⏰ Timed exit for ${trade.symbol}: held ${holdDurationMinutes}min (max: ${TIMED_EXIT_MINUTES}min), exiting ${positionRemaining.toFixed(0)}% remaining position, PnL: ${pnlPercent.toFixed(2)}%`);
    }
    
    // 4. Legacy per-trade time limit (only if global timed exit is disabled)
    if (!shouldExit && !ENABLE_TIMED_EXIT && trade.time_based_exit_seconds && holdDurationSeconds >= trade.time_based_exit_seconds) {
      shouldExit = true;
      exitReason = 'time_based';
      sellPercent = 100;
      logger.info(`⏰ Time-based exit for ${trade.symbol}: held ${holdDurationMinutes}min (max: ${Math.floor(trade.time_based_exit_seconds / 60)}min)`);
    }
    
    // Exit if any condition met
    if (shouldExit && exitReason) {
      await this.exitPosition(trade, currentPrice, exitReason, holdDurationMinutes, partialExit, sellPercent);
    } else {
      // Just log current status
      const remainingPercent = (trade.remaining_tokens / trade.tokens_bought) * 100;
      logger.debug(`  ${trade.symbol}: ${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}% (held ${holdDurationMinutes}min, ${remainingPercent.toFixed(0)}% position remaining)`);
    }
  }
  
  /**
   * Exit a position (full or partial, depending on TPs)
   */
  private async exitPosition(
    trade: any,
    currentPrice: number,
    exitReason: string,
    holdDurationMinutes: number,
    partialExit: boolean = false,
    sellPercent: number = 100
  ): Promise<void> {
    // Fetch SOL price at exit for beta calculation
    const solPriceAtExit = await this.getSOLPrice();
    
    // Calculate how many tokens to sell
    let tokensToSell = partialExit 
      ? (trade.tokens_bought * sellPercent) / 100  // Partial: sell % of original
      : trade.remaining_tokens;                    // Full: sell all remaining
    let tokensRemaining = trade.remaining_tokens - tokensToSell;
    
    logger.info(`📊 [POSITION EXIT] ${trade.symbol} (ID: ${trade.id})`);
    logger.info(`  Exit Type: ${partialExit ? 'PARTIAL' : 'FULL'}`);
    logger.info(`  Reason: ${exitReason}`);
    logger.info(`  Sell Percent: ${sellPercent}% of ORIGINAL position`);
    logger.info(`  Tokens to sell: ${tokensToSell.toExponential(4)}`);
    logger.info(`  Tokens remaining after: ${tokensRemaining.toExponential(4)}`);
    
    // PAPER TRADING: Simulate slippage and fees
    const slippageMultiplier = 1 - (EXIT_SLIPPAGE / 100);
    const actualExitPrice = currentPrice * slippageMultiplier;
    
    // Calculate exit amount before fees
    const exitAmountBeforeFees = tokensToSell * actualExitPrice;
    
    // Apply exit fee
    const feeMultiplier = 1 - (EXIT_FEE / 100);
    const actualExitAmount = exitAmountBeforeFees * feeMultiplier;
    
    // Calculate PnL for THIS exit
    // For PERCENTAGE: Use raw price movement (consistent with ML/analytics)
    // For USD AMOUNT: Use actual costs with slippage/fees applied
    const rawEntryPrice = trade.entry_price;  // Raw price (before slippage)
    const rawExitPnlPercent = ((currentPrice - rawEntryPrice) / rawEntryPrice) * 100;
    
    // USD P&L calculation (uses actual costs with slippage/fees)
    // CRITICAL FIX: For full exits after partial exits, calculate cost based on tokens ratio, not sellPercent
    // sellPercent is 100% for full exits, but we're only selling remaining_tokens (e.g., 50% of original)
    const originalCostForThisPortion = partialExit
      ? (trade.actual_entry_cost * sellPercent) / 100  // Partial exit: use sellPercent
      : (trade.actual_entry_cost * tokensToSell) / trade.tokens_bought;  // Full exit: use token ratio
    const partialPnlUsd = actualExitAmount - originalCostForThisPortion;
    const partialPnlPercent = rawExitPnlPercent;  // Use raw price % for consistency
    
    // Calculate max gain using raw entry price (consistent with ML training)
    const entryPrice = trade.entry_price;  // Raw price, not actual_entry_price
    const maxGainPercent = trade.max_price_reached
      ? ((trade.max_price_reached - entryPrice) / entryPrice) * 100
      : 0;
    
    logger.info(`  💰 P&L for this exit: ${partialPnlPercent > 0 ? '+' : ''}${partialPnlPercent.toFixed(2)}% ($${partialPnlUsd > 0 ? '+' : ''}${partialPnlUsd.toFixed(2)})`);
    
    if (partialExit && tokensRemaining > 0.00001) {
      // PARTIAL EXIT: Update trade, keep position open
      const tpColumn = exitReason === 'take_profit_1' ? 'tp1_hit' : 
                       exitReason === 'take_profit_2' ? 'tp2_hit' : 'tp3_hit';
      
      const currentCumulativePnl = trade.cumulative_pnl_usd || 0;
      const newCumulativePnl = currentCumulativePnl + partialPnlUsd;
      
      await query(`
        UPDATE trades
        SET 
          ${tpColumn} = TRUE,
          remaining_tokens = $1,
          cumulative_pnl_usd = $2
        WHERE id = $3
      `, [tokensRemaining, newCumulativePnl, trade.id]);
      
      // TP Trailing Stop: Update SL after TP hits
      // TP1: Move SL to breakeven (0%) to protect remaining position
      // TP2: Move SL to protect accumulated gains
      if (!ENABLE_DYNAMIC_TRAILING && exitReason === 'take_profit_1') {
        const newStopLoss = TRAILING_STOP_AFTER_TP1; // Should be 0% (breakeven)
        await query(`UPDATE trades SET stop_loss_percent = $1 WHERE id = $2`, [newStopLoss, trade.id]);
        logger.info(`🔒 [TP TRAILING] TP1 hit! Moving SL to breakeven (${newStopLoss}%) to protect remaining ${(100 - sellPercent).toFixed(0)}% position`);
      } else if (!ENABLE_DYNAMIC_TRAILING && exitReason === 'take_profit_2') {
        const newStopLoss = TRAILING_STOP_AFTER_TP2;
        await query(`UPDATE trades SET stop_loss_percent = $1 WHERE id = $2`, [newStopLoss, trade.id]);
        logger.info(`🔒 [TP TRAILING] TP2 hit! Moving SL to +${newStopLoss}%`);
      }
      
      logger.success(`✅ PARTIAL EXIT: Sold ${sellPercent}% for ${partialPnlPercent > 0 ? '+' : ''}${partialPnlPercent.toFixed(2)}% ($${partialPnlUsd > 0 ? '+' : ''}${partialPnlUsd.toFixed(2)})`);
      logger.success(`  Remaining: ${((tokensRemaining / trade.tokens_bought) * 100).toFixed(1)}% position still open`);
    } else {
      // FULL EXIT: Close position entirely
      // For USD: Use cumulative P&L from all exits (accounts for actual costs)
      const previousCumulativePnl = trade.cumulative_pnl_usd || 0;
      const finalTotalPnl = previousCumulativePnl + partialPnlUsd;
      
      // For PERCENTAGE: Calculate based on cumulative profit/loss (accounts for partial exits)
      // This ensures pnl_percent reflects the actual performance, not just final exit price
      const finalPnlPercent = (finalTotalPnl / trade.actual_entry_cost) * 100;
      
      const tpColumn = exitReason === 'take_profit_1' ? 'tp1_hit' : 
                       exitReason === 'take_profit_2' ? 'tp2_hit' : 
                       exitReason === 'take_profit_3' ? 'tp3_hit' : null;
      
      const updateFields = tpColumn 
        ? `${tpColumn} = TRUE, exit_timestamp = CURRENT_TIMESTAMP,`
        : 'exit_timestamp = CURRENT_TIMESTAMP,';
      
      await query(`
        UPDATE trades
        SET 
          ${updateFields}
          exit_price = $1,
          exit_reason = $2,
          exit_slippage_percent = $3,
          exit_fee_percent = $4,
          actual_exit_price = $5,
          actual_exit_amount = $6,
          pnl_percent = $7,
          net_pnl_usd = $8,
          hold_duration_minutes = $9,
          max_gain_percent = $10,
          cumulative_pnl_usd = $11,
          sol_price_exit = $12,
          remaining_tokens = 0,
          status = 'closed'
        WHERE id = $13
      `, [
        currentPrice,
        exitReason,
        EXIT_SLIPPAGE,
        EXIT_FEE,
        actualExitPrice,
        actualExitAmount,
        finalPnlPercent,
        finalTotalPnl,
        holdDurationMinutes,
        maxGainPercent,
        finalTotalPnl,
        solPriceAtExit,
        trade.id
      ]);
      
      // Log full exit summary
      const emoji = finalPnlPercent > 0 ? '🟢' : '🛑';
      logger.success(`${emoji} POSITION CLOSED: #${trade.id} ${trade.symbol}`);
      logger.success(`  Reason: ${exitReason}`);
      logger.success(`  Final P&L: ${finalPnlPercent > 0 ? '+' : ''}${finalPnlPercent.toFixed(2)}% ($${finalTotalPnl > 0 ? '+' : ''}${finalTotalPnl.toFixed(2)})`);
      logger.success(`  Hold duration: ${holdDurationMinutes} minutes`);
      logger.success(`  Max gain during hold: ${maxGainPercent.toFixed(2)}%`);
    }
    
    // Update decision table to mark as executed
    await query(`
      UPDATE decisions
      SET executed = TRUE
      WHERE id = $1
    `, [trade.decision_id]);
    
    logger.info(`  ✓ Decision #${trade.decision_id} marked as executed`);
  }
  
  /**
   * Update max price reached
   */
  private async updateMaxPrice(tradeId: number, price: number): Promise<void> {
    await query(`
      UPDATE trades
      SET max_price_reached = $1,
          max_price_timestamp = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [price, tradeId]);
  }
  
  /**
   * Update max drawdown (worst negative PnL during trade)
   */
  private async updateMaxDrawdown(tradeId: number, drawdownPercent: number): Promise<void> {
    await query(`
      UPDATE trades
      SET 
        max_drawdown_percent = $1,
        max_drawdown_timestamp = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [drawdownPercent, tradeId]);
  }
  
  /**
   * Get all open trades with their decision data
   * NOTE: TP levels are stored IN trades table, not decisions!
   * Using t.* already includes all TP columns, no need to JOIN for them
   */
  private async getOpenTrades(): Promise<any[]> {
    const result = await query(`
      SELECT 
        t.*
      FROM trades t
      WHERE t.status = 'open'
        AND t.chain = $1
      ORDER BY t.entry_timestamp ASC
    `, [getChainConfig().chain]);
    return result.rows;
  }
  
  /**
   * Manually close a position
   */
  async manualExit(tradeId: number, reason: string = 'manual'): Promise<boolean> {
    const result = await query('SELECT * FROM trades WHERE id = $1 AND status = \'open\'', [tradeId]);
    const trade = result.rows[0];
    
    if (!trade) {
      logger.warn(`Trade #${tradeId} not found or already closed`);
      return false;
    }
    
    // Fetch price using price service
    const currentPrice = await priceService.getPrice(trade.token_address);
    
    if (!currentPrice) {
      logger.error(`Unable to fetch price for manual exit of #${tradeId}`);
      return false;
    }
    
    const holdDurationMinutes = Math.floor((Date.now() - new Date(trade.entry_timestamp).getTime()) / 60000);
    
    await this.exitPosition(trade, currentPrice, reason, holdDurationMinutes, false, 100);
    
    return true;
  }
}

