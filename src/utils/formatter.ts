/**
 * Format scan results for Telegram
 */

import type { ScanResult } from './scanner';
import { escapeMarkdownV2 } from './escape';
import { getChainConfig, Chain } from '../config/chain';

/**
 * Get chain-appropriate explorer links
 */
function getExplorerLinks(tokenAddress: string): string {
  const chainConfig = getChainConfig();
  
  if (chainConfig.chain === Chain.SOLANA) {
    // Solana links
    return `[Trade on Padre](https://trade.padre.gg/trade/solana/${tokenAddress})\n[View on DexScreener](https://dexscreener.com/solana/${tokenAddress})`;
  } else {
    // BSC links  
    return `[Trade on Padre](https://trade.padre.gg/trade/bsc/${tokenAddress})\n[View on DexScreener](https://dexscreener.com/bsc/${tokenAddress})`;
  }
}

export function formatHotTokens(result: ScanResult): string {
  let message = '🔥 *Hot Tokens on BSC*\n\n';
  
  // Bot breakdown only
  if (result.botBreakdown.size > 0) {
    message += `🤖 *Bot Activity:*\n`;
    const sortedBots = Array.from(result.botBreakdown.entries())
      .sort((a, b) => b[1] - a[1]);
    
    for (const [bot, count] of sortedBots) {
      const emoji = getBotEmoji(bot);
      message += `${emoji} ${escapeMarkdownV2(bot)}: ${count} trades\n`;
    }
    message += '\n';
  }
  
  // Bot-specific top 3 tokens
  const botSpecificStats = new Map<string, Map<string, { buys: number; sells: number; users: Set<string> }>>();
  
  // Build bot-specific stats from per-bot activity data
  result.topTokens.forEach(token => {
    token.botActivity.forEach((activity, botName) => {
      if (!botSpecificStats.has(botName)) {
        botSpecificStats.set(botName, new Map());
      }
      
      const botStats = botSpecificStats.get(botName)!;
      if (!botStats.has(token.token)) {
        botStats.set(token.token, { buys: 0, sells: 0, users: new Set() });
      }
      
      // Use per-bot activity counts
      const stats = botStats.get(token.token)!;
      stats.buys = activity.buys;
      stats.sells = activity.sells;
      token.users.forEach(u => stats.users.add(u));
    });
  });
  
  // Show top 3 for each active bot (top 5 bots)
  const activeBots = Array.from(result.botBreakdown.entries())
    .filter(([_, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5); // Show top 5 bots
  
  activeBots.forEach(([botName, _]) => {
    const botStats = botSpecificStats.get(botName);
    if (!botStats || botStats.size === 0) return;
    
    const topForBot = Array.from(botStats.entries())
      .map(([tokenAddr, stats]) => {
        const tokenData = result.topTokens.find(t => t.token === tokenAddr);
        return {
          token: tokenAddr,
          buys: stats.buys,
          sells: stats.sells,
          netBuys: stats.buys - stats.sells,
          users: stats.users,
          totalActivity: stats.buys + stats.sells,
          meta: result.tokenMetadata.get(tokenAddr),
          allBots: tokenData?.bots || new Set([botName]),
        };
      })
      .sort((a, b) => b.totalActivity - a.totalActivity)
      .slice(0, 3);
    
    if (topForBot.length === 0) return;
    
    const botEmoji = getBotEmoji(botName);
    message += `\n${botEmoji} *TOP 3 \\- ${escapeMarkdownV2(botName.toUpperCase())}:*\n`;
    
    topForBot.forEach((token, idx) => {
      const sentiment = token.netBuys > 0 ? '🟢' : token.netBuys < 0 ? '🔴' : '⚪';
      const netBuysStr = token.netBuys >= 0 ? `+${token.netBuys}` : `-${Math.abs(token.netBuys)}`;
      
      if (token.meta) {
        message += `*${idx + 1}\\. ${escapeMarkdownV2(token.meta.name)} \\(${escapeMarkdownV2(token.meta.symbol)}\\)*\n`;
      } else {
        message += `*${idx + 1}\\. Token*\n`;
      }
      message += `📋 \`${token.token}\`\n`;
      
      message += `${sentiment} ${token.buys} buys, ${token.sells} sells \\(${escapeMarkdownV2(netBuysStr)}\\)\n`;
      message += `👥 ${token.users.size} users\n`;
      
      if (token.meta) {
        const priceFormatted = formatPrice(token.meta.priceUSD);
        const mcapFormatted = formatMarketCap(token.meta.marketCap);
        const liqFormatted = formatLiquidity(token.meta.liquidity);
        const vol24hFormatted = formatLiquidity(token.meta.volume24h); // Reuse same formatter
        
        message += `💰 ${priceFormatted} \\| MCap: ${mcapFormatted} \\| Liq: ${liqFormatted}\n`;
        message += `📊 Vol 24h: ${vol24hFormatted}\n`;
      }
      
      message += getExplorerLinks(token.token);
      message += '\n\n';
    });
  });
  
  // Top 5 tokens overall
  const topTokensOverall = result.topTokens.slice(0, 5);
  
  if (topTokensOverall.length > 0) {
    message += `\n🏆 *TOP ${Math.min(5, topTokensOverall.length)} OVERALL:*\n\n`;
    
    topTokensOverall.forEach((token, idx) => {
      const sentiment = token.netBuys > 0 ? '🟢' : token.netBuys < 0 ? '🔴' : '⚪';
      const netBuysStr = token.netBuys >= 0 ? `+${token.netBuys}` : `-${Math.abs(token.netBuys)}`;
      const botsUsed = Array.from(token.bots)
        .map(b => escapeMarkdownV2(b))
        .join(', ');
      const meta = result.tokenMetadata.get(token.token);
      
      // Token name or address
      if (meta) {
        message += `*${idx + 1}\\. ${escapeMarkdownV2(meta.name)} \\(${escapeMarkdownV2(meta.symbol)}\\)*\n`;
      } else {
        message += `*${idx + 1}\\. Token*\n`;
      }
      message += `📋 \`${token.token}\`\n`;
      
      // Trading activity
      message += `${sentiment} ${token.buys} buys, ${token.sells} sells \\(${escapeMarkdownV2(netBuysStr)}\\)\n`;
      message += `👥 ${token.users.size} users${botsUsed ? ` \\| 🤖 ${botsUsed}` : ''}\n`;
      
      // Token metadata if available
      if (meta) {
        const liqFormatted = formatLiquidity(meta.liquidity);
        const mcapFormatted = formatMarketCap(meta.marketCap);
        const priceFormatted = formatPrice(meta.priceUSD);
        const vol24hFormatted = formatLiquidity(meta.volume24h);
        
        message += `💰 ${priceFormatted} \\| MCap: ${mcapFormatted}\n`;
        message += `💧 Liq: ${liqFormatted} \\| Holders: ${meta.holders || 'N/A'}\n`;
        message += `📊 Vol 24h: ${vol24hFormatted}\n`;
      }
      
      message += getExplorerLinks(token.token);
      message += '\n\n';
    });
  }
  
  message += `_Last 300 blocks \\(\\~15 minutes\\)_`;
  
  return message;
}

function getBotEmoji(botName: string): string {
  const emojis: Record<string, string> = {
    'BananaGun': '🍌',
    'Maestro': '🎵',
    'Axios': '⚡',
    'Sigma': '∑',
    'Bloom': '🌸',
    'BonkBot': '🔨',
  };
  return emojis[botName] || '🤖';
}

function formatPrice(price: number): string {
  let formatted: string;
  if (price === 0) formatted = '$0';
  else if (price < 0.00000001) formatted = `$${price.toExponential(2)}`;
  else if (price < 0.01) formatted = `$${price.toFixed(8)}`;
  else if (price < 1) formatted = `$${price.toFixed(6)}`;
  else formatted = `$${price.toFixed(4)}`;
  
  // Escape dots for MarkdownV2
  return formatted.replace(/\./g, '\\.');
}

function formatLiquidity(liq: number): string {
  let formatted: string;
  if (liq >= 1000000) formatted = `$${(liq / 1000000).toFixed(2)}M`;
  else if (liq >= 1000) formatted = `$${(liq / 1000).toFixed(1)}K`;
  else formatted = `$${liq.toFixed(0)}`;
  
  // Escape dots for MarkdownV2
  return formatted.replace(/\./g, '\\.');
}

function formatMarketCap(mcap: number): string {
  let formatted: string;
  if (mcap >= 1000000) formatted = `$${(mcap / 1000000).toFixed(2)}M`;
  else if (mcap >= 1000) formatted = `$${(mcap / 1000).toFixed(1)}K`;
  else formatted = `$${mcap.toFixed(0)}`;
  
  // Escape dots for MarkdownV2
  return formatted.replace(/\./g, '\\.');
}


