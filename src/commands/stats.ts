import type { CommandContext } from 'grammy';
import { sharedPaperTrader } from '../services/shared-paper-trader';
import { logger } from '../utils/logger';

export async function statsCommand(ctx: CommandContext<any>) {
  try {
    const stats = await sharedPaperTrader.getStats(24); // Last 24 hours
    const openTrades = await sharedPaperTrader.getOpenTrades();
    const recentExits = await sharedPaperTrader.getRecentExits(Date.now() - 24 * 60 * 60 * 1000);

    let message = `📊 *Trading Stats* \\(Last 24h\\)\n\n`;

    // Portfolio Summary
    message += `💰 *Portfolio*\n`;
    message += `Balance: $${escapeMarkdown(stats.currentBalance.toFixed(2))} \\(${stats.portfolioReturnPercent >= 0 ? '\\+' : ''}${escapeMarkdown(stats.portfolioReturnPercent.toFixed(1))}%\\)\n`;
    message += `Deployed: ${openTrades.length > 0 ? `${openTrades.length} positions` : 'None'}\n\n`;

    // Performance
    message += `📈 *Performance*\n`;
    message += `Trades: ${stats.closedTrades}\n`;
    message += `Win Rate: ${escapeMarkdown((stats.winRate?.toFixed(0) || 0).toString())}% \\(${stats.winningTrades}W/${stats.losingTrades}L\\)\n`;
    message += `Avg Hold: ${stats.avgHoldDuration || 0} min\n`;
    const bestPnl = stats.bestTradePnl || 0;
    const worstPnl = stats.worstTradePnl || 0;
    message += `Best Trade: ${bestPnl >= 0 ? '\\+' : ''}${escapeMarkdown(bestPnl.toFixed(1))}%\n`;
    message += `Worst Trade: ${worstPnl >= 0 ? '\\+' : ''}${escapeMarkdown(worstPnl.toFixed(1))}%\n\n`;

    // Open Positions
    if (openTrades.length > 0) {
      message += `🟢 *Open Positions* \\(${openTrades.length}\\)\n`;
      for (const trade of openTrades) {
        const now = Date.now();
        // Parse SQLite DATETIME string to timestamp
        const entryTime = new Date(trade.entry_timestamp).getTime();
        const holdMin = Math.floor((now - entryTime) / 60000);
        const entryPrice = escapeMarkdown(trade.entry_price.toFixed(8));
        const amount = escapeMarkdown(trade.entry_amount_usd.toFixed(2));
        const sl = escapeMarkdown((trade.stop_loss_percent || 0).toString());
        
        // Calculate remaining position %
        const remainingPercent = trade.remaining_tokens && trade.tokens_bought 
          ? (trade.remaining_tokens / trade.tokens_bought) * 100 
          : 100;
        
        // Show which TPs have been hit and which are still active
        const tp1Status = trade.tp1_hit ? `~~${trade.take_profit_1 || 0}%~~` : `${trade.take_profit_1 || 0}%`;
        const tp2Status = trade.tp2_hit ? `~~${trade.take_profit_2 || 0}%~~` : `${trade.take_profit_2 || 0}%`;
        const tp3Status = trade.tp3_hit ? `~~${trade.take_profit_3 || 0}%~~` : `${trade.take_profit_3 || 0}%`;
        
        const maxHoldHours = parseInt(process.env.PAPER_TRADING_MAX_HOLD_HOURS || '24', 10);
        
        message += `\n*${escapeMarkdown(trade.symbol)}* \\(${remainingPercent.toFixed(0)}% remaining\\)\n`;
        message += `Entry: $${entryPrice} \\| $${amount}\n`;
        message += `SL: ${sl}% \\| TP: ${escapeMarkdown(tp1Status)}, ${escapeMarkdown(tp2Status)}, ${escapeMarkdown(tp3Status)}\n`;
        message += `Hold: ${holdMin}min \\| Max: ${maxHoldHours}h\n`;
      }
      message += `\n`;
    } else {
      message += `🟢 *Open Positions*: None\n\n`;
    }

    // Recent Exits
    if (recentExits.length > 0) {
      message += `📜 *Recent Exits* \\(Last ${Math.min(recentExits.length, 10)}\\)\n`;
      const exitsToShow = recentExits.slice(0, 10);
      
      for (const exit of exitsToShow) {
        const emoji = exit.pnl_percent >= 0 ? '✅' : '❌';
        const pnl = exit.pnl_percent >= 0 ? `\\+${escapeMarkdown(exit.pnl_percent.toFixed(1))}` : escapeMarkdown(exit.pnl_percent.toFixed(1));
        const reason = formatExitReason(exit.exit_reason);
        const holdMin = exit.hold_duration_minutes || 0;
        const date = new Date(exit.exit_timestamp).toLocaleString('en-US', { 
          month: 'short', 
          day: 'numeric', 
          hour: '2-digit', 
          minute: '2-digit',
          hour12: false 
        });
        const entryPrice = escapeMarkdown(exit.entry_price.toFixed(8));
        
        message += `${emoji} *${escapeMarkdown(exit.symbol)}*: ${pnl}% \\(${reason}, ${holdMin}min\\)\n`;
        message += `   ${escapeMarkdown(date)} \\| Entry: $${entryPrice}\n`;
      }
    }

    await ctx.reply(message, { parse_mode: 'MarkdownV2' });
    
  } catch (error: any) {
    logger.error('Stats command error', error);
    await ctx.reply(`❌ Error fetching stats: ${error.message}`);
  }
}

function formatExitReason(reason: string): string {
  switch (reason) {
    case 'stop_loss': return 'SL';
    case 'take_profit_1': return 'TP1';
    case 'take_profit_2': return 'TP2';
    case 'take_profit_3': return 'TP3';
    case 'time_based': return 'Time';
    default: return reason;
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

