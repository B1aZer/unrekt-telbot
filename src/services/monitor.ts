/**
 * Token Monitor Service
 * Continuously scans and posts to channel when AI recommends tokens
 */

import type { Bot } from 'grammy';
import { scanHotTokens, type TokenStats } from '../utils/scanner';
import { TradingAnalyzer, type TradingDecision } from './trading-analyzer';
import { sharedPaperTrader } from './shared-paper-trader';
import type { PaperTrader } from './paper-trader';
import { WatchlistManager, type WatchlistConfig } from './watchlist-manager';
import { priceService } from './price-tracking';
import { scanLogger } from './scan-logger';
import { logger } from '../utils/logger';
import { escapeMarkdownV2, formatLargeNumber, formatNumber } from '../utils/telegram-escape';
import type { CodexBSCTokenData } from '../infra/codex';
import { getChainConfig, Chain } from '../config/chain';
import { hybridShadowTracker } from './hybrid-shadow-tracker';

export class TokenMonitor {
  private bot: Bot;
  private channelId: string;
  private publicChannelId: string | null;
  private intervalMinutes: number;
  private tradingAnalyzer: TradingAnalyzer;
  private paperTrader: PaperTrader;
  private watchlistManager: WatchlistManager | null = null;
  private isRunning = false;
  private intervalId?: Timer;

  constructor(
    bot: Bot,
    channelId: string,
    intervalMinutes: number = 5
  ) {
    this.bot = bot;
    this.channelId = channelId;
    this.publicChannelId = process.env.PUBLIC_CHANNEL_ID || null;
    this.intervalMinutes = intervalMinutes;
    this.tradingAnalyzer = new TradingAnalyzer();
    this.paperTrader = sharedPaperTrader; // Use shared instance
    
    // Initialize watchlist if enabled
    const watchlistConfig = this.loadWatchlistConfig();
    if (watchlistConfig.enabled) {
      const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
      const chain = getChainConfig().chain;
      
      this.watchlistManager = new WatchlistManager(
        watchlistConfig,
        anthropicKey,
        // Price fetching callback - uses priceService for caching + DB tracking
        async (tokenAddress: string, chain: string) => {
          return await priceService.getPrice(tokenAddress, chain);
        },
        // Trade execution callback
        async (entry, price) => {
          await this.executeWatchlistTrade(entry, price);
        }
      );
    }
  }
  
  /**
   * Load watchlist configuration from environment variables
   */
  private loadWatchlistConfig(): WatchlistConfig {
    return {
      enabled: process.env.WATCHLIST_ENABLED === 'true',
      useHaiku: process.env.WATCHLIST_USE_HAIKU !== 'false', // Default to true for backwards compatibility
      observationSeconds: parseInt(process.env.WATCHLIST_OBSERVATION_SECONDS || '120'),
      priceCheckInterval: parseInt(process.env.WATCHLIST_PRICE_CHECK_INTERVAL || '30'),
      skipDumpThreshold: parseFloat(process.env.WATCHLIST_SKIP_DUMP_THRESHOLD || '-15'),
      skipNoMomentumThreshold: parseFloat(process.env.WATCHLIST_SKIP_NO_MOMENTUM_THRESHOLD || '5'),
      recoveryThreshold: parseFloat(process.env.WATCHLIST_RECOVERY_THRESHOLD || '5'),
    };
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Monitor already running');
      return;
    }
    
    if (!this.tradingAnalyzer.isEnabled()) {
      logger.error('❌ Cannot start monitor - Trading analyzer is disabled');
      logger.info('   Add ANTHROPIC_API_KEY to your .env file');
      return;
    }
    
    this.isRunning = true;
    logger.info('🔍 Token monitor started');
    logger.info(`📢 Will post to channel: ${this.channelId}`);
    if (this.publicChannelId) {
      logger.info(`🌐 Public channel enabled: ${this.publicChannelId}`);
    }
    if (this.watchlistManager) {
      logger.info('📊 Watchlist enabled - trades will be delayed for observation');
    } else {
      logger.info('⚡ Watchlist disabled - immediate execution mode');
    }
    logger.info('🤖 Using unified Trading Analyzer (single AI call)');
    logger.info(`⏱️  Scan interval: ${this.intervalMinutes} minutes`);
    
    // Initialize watchlist manager (recover any monitoring entries)
    if (this.watchlistManager) {
      await this.watchlistManager.initialize();
    }
    
    // Initialize token tracker (recover tracking state and calculate peak_gain for past tokens)
    const { tokenTracker } = await import('./token-tracker');
    if (tokenTracker.isEnabled()) {
      await tokenTracker.initialize();
    }
    
    // Start paper trading position monitor
    this.paperTrader.startMonitoring();
    
    // Start hybrid shadow tracker if enabled
    if (hybridShadowTracker.isEnabled()) {
      hybridShadowTracker.startMonitoring();
    }
    
    // Delay first scan by 10 seconds to let bot fully initialize (webhook setup, etc.)
    logger.info('⏰ First scan will start in 10 seconds...');
    setTimeout(() => {
      this.scan().catch(err => {
        logger.error('Monitor scan error', err);
      });
    }, 10000);
    
    // Then run on interval
    const intervalMs = this.intervalMinutes * 60 * 1000;
    this.intervalId = setInterval(() => {
      this.scan().catch(err => {
        logger.error('Monitor scan error', err);
      });
    }, intervalMs);
  }

  private async scan() {
    try {
      logger.info('🔎 Running monitor scan...');
      
      // Step 1: Scanner finds hot tokens
      const scanResult = await scanHotTokens();
      
      // Start tracking scan metrics
      await scanLogger.startScan(scanResult);
      
      logger.info(`📋 Found ${scanResult.topTokens.length} hot tokens`);
      scanResult.topTokens.forEach((token, idx) => {
        const metadata = scanResult.tokenMetadata.get(token.token);
        logger.info(
          `  ${idx + 1}. ${metadata?.symbol || 'Unknown'} (${token.token.substring(0, 10)}...) - ` +
          `${token.buys}B/${token.sells}S, ${token.users.size} users`
        );
      });
      
      // Step 2: Unified Trading Analyzer (single AI call for everything!)
      const analysis = await this.tradingAnalyzer.analyzeTokens(scanResult);
      
      // Get scan ID BEFORE any early returns (completeScan clears currentScan)
      const currentScanId = scanLogger.getCurrentScanId();
      
      // Run hybrid shadow tracker RIGHT AFTER tokens are logged (before processing decisions)
      // This ensures:
      // 1. Tokens are definitely in DB (logAllScannedTokens is awaited inside analyzeTokens)
      // 2. We don't block the main trading flow (runs independently)
      // 3. Shadow mode doesn't depend on trading decisions
      if (hybridShadowTracker.isEnabled() && currentScanId) {
        // Run in background (don't await) so it doesn't block main trading flow
        hybridShadowTracker.processScanById(currentScanId).catch(err => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const errorStack = err instanceof Error ? err.stack : undefined;
          logger.error(`[Hybrid Shadow] Error processing scan ${currentScanId}: ${errorMsg}`);
          if (errorStack) {
            logger.error(`[Hybrid Shadow] Stack trace: ${errorStack.substring(0, 500)}`);
          }
        });
      }
      
      // Filter tokens where AI says BUY vs SKIP
      const buyDecisions = analysis.decisions.filter(decision => decision.shouldBuy);
      const skipDecisions = analysis.decisions.filter(decision => !decision.shouldBuy);
      
      // Update scan metrics with AI decisions
      scanLogger.updateDecisions(buyDecisions.length, skipDecisions.length);
      
      if (!analysis.decisions || analysis.decisions.length === 0) {
        logger.info('✓ Scan complete - No tokens recommended for trading');
        logger.debug('Summary:', analysis.summary);
        // Complete scan tracking even if no decisions
        await scanLogger.completeScan();
        return;
      }
      
      // Log skip decisions
      skipDecisions.forEach(decision => {
        logger.info(
          `⏭️  Skipping ${decision.symbol} - AI says SKIP (confidence: ${decision.confidence}%)`
        );
      });
      
      // Token tracking is now handled automatically in trading-analyzer.ts
      // after tokens are logged to scanned_tokens table
      
      if (buyDecisions.length === 0) {
        logger.info('✓ Scan complete - No new BUY recommendations');
        logger.debug('Summary:', analysis.summary);
        // Complete scan tracking even if no buy decisions
        await scanLogger.completeScan();
        return;
      }
      
      logger.info(`🎯 AI recommends buying ${buyDecisions.length} token(s)`);
      
      // Step 3: Add to watchlist OR execute immediately (depending on config)
      for (const decision of buyDecisions) {
        const decisionId = this.tradingAnalyzer.getDecisionId(decision.token);
        
        if (!decisionId) {
          logger.warn(`⚠️  No decision ID found for ${decision.symbol} - skipping`);
          continue;
        }
        
        if (this.watchlistManager) {
          // WATCHLIST MODE: Add to watchlist (handles both immediate and delayed based on config)
          const chain = getChainConfig().chain;
          await this.watchlistManager.addToWatchlist(
            {
              address: decision.token,
              chain: chain,
              symbol: decision.symbol,
              price: decision.marketData.price,
            },
            {
              id: decisionId,
              reasoning: decision.reasoning || '',
              confidence: decision.confidence,
              opportunities: decision.opportunities || [],
              risks: decision.risks || [],
              warnings: decision.warnings || [],
              discoveredByBots: decision.discoveredByBots,
              primaryBot: decision.primaryBot,
            }
          );
          // Note: Trade execution happens via watchlist callback after observation/haiku check
          // Mark as not yet executed (will be set by callback if approved)
          (decision as any).paperTradeExecuted = false;
        } else {
          // IMMEDIATE MODE: Execute paper trade right away (old behavior)
          if (this.paperTrader) {
            const currentPrice = decision.marketData.price;
            const tradeId = await this.paperTrader.executeTrade(decision, decisionId, currentPrice);
            
            // Store trade ID and fetch actual position size from DB
            (decision as any).paperTradeId = tradeId;
            (decision as any).paperTradeExecuted = tradeId !== null;
            
            // Get the actual position size used (after limits/adjustments)
            if (tradeId) {
              const trade = await this.paperTrader.getTradeById(tradeId);
              if (trade) {
                (decision as any).actualPositionUsd = trade.entry_amount_usd;
              }
            }
          }
        }
      }
      
      // Step 4: Post to Telegram (for executed trades)
      for (const decision of buyDecisions) {
        // Skip if trade was not executed (either immediate mode or Haiku rejected)
        if (!(decision as any).paperTradeExecuted || !(decision as any).paperTradeId) {
          logger.warn(`⚠️  Skipping Telegram alert for ${decision.symbol} - trade was not executed`);
          continue;
        }
          
          const token = scanResult.topTokens.find(t => t.token === decision.token);
          if (!token) continue;
          
          try {
            const message = await this.formatTradingAlert(decision);
            
            // Post to main channel
            await this.bot.api.sendMessage(this.channelId, message, {
              parse_mode: 'MarkdownV2',
              link_preview_options: { is_disabled: true },
            });
            
            logger.success(`📣 Posted BUY alert for ${decision.symbol}`);
            
            // Post to public channel if enabled
            if (this.publicChannelId) {
              this.postToPublicChannel(decision).catch(err => {
                logger.error(`Failed to post to public channel for ${decision.symbol}`, err);
              });
            }
            
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (error: any) {
            logger.error(`Failed to post alert for ${decision.token}`, error);
          }
        }
      
      // Complete scan tracking
      await scanLogger.completeScan();
      
    } catch (error) {
      logger.error('Monitor scan failed', error);
      // Try to complete scan even on error (with partial data)
      await scanLogger.completeScan().catch(() => {});
    }
  }

  private async formatTradingAlert(decision: TradingDecision): Promise<string> {
    // Format numbers with proper escaping
    const mcFormatted = formatLargeNumber(decision.marketData.marketCap);
    const liqFormatted = formatLargeNumber(decision.marketData.liquidity);
    const volFormatted = formatLargeNumber(decision.marketData.volume24h);
    const priceFormatted = formatNumber(decision.marketData.price, 8);
    
    // Confidence emoji
    const confidenceEmoji = decision.confidence >= 85 ? '💎🚀' : decision.confidence >= 75 ? '💎' : '✅';
    const confidenceLabel = decision.confidence >= 85 ? 'HIGH CONFIDENCE BUY' : decision.confidence >= 75 ? 'BUY SIGNAL' : 'MODERATE BUY';
    
    // Get paper trading stats for footer
    const stats = await this.paperTrader.getStats(24);
    const openTrades = await this.paperTrader.getOpenTrades();
    let statsText = '';
    if (stats.totalTrades > 0) {
      const winRate = escapeMarkdownV2(stats.winRate.toFixed(0) + '%');
      const pnlSign = stats.totalPnlUsd >= 0 ? escapeMarkdownV2('+') : escapeMarkdownV2('-');
      const pnlAmount = escapeMarkdownV2(`$${Math.abs(stats.totalPnlUsd).toFixed(0)}`);
      const currentBalance = escapeMarkdownV2(`$${stats.currentBalance.toFixed(0)}`);
      const returnSign = stats.portfolioReturnPercent >= 0 ? escapeMarkdownV2('+') : escapeMarkdownV2('-');
      const returnPercent = escapeMarkdownV2(`${Math.abs(stats.portfolioReturnPercent).toFixed(1)}%`);
      
      // Build TP/SL breakdown string - always show all exit types for transparency
      const tp1 = stats.tp1_count || 0;
      const tp2 = stats.tp2_count || 0;
      const tp3 = stats.tp3_count || 0;
      const sl = stats.stopLossCount || 0;
      const exitStats = ` ${escapeMarkdownV2('|')} ${escapeMarkdownV2(`TP1:${tp1} TP2:${tp2} TP3:${tp3} SL:${sl}`)}`;
      
      statsText = `📊 Trading \\(24h\\): ${stats.closedTrades} trades${exitStats} ${escapeMarkdownV2('|')} ${pnlSign}${pnlAmount}\n💰 Portfolio: ${currentBalance} \\(${returnSign}${returnPercent}\\)\n🟢 Open Positions: ${openTrades.length}`;
    } else {
      statsText = `📊 Trading \\(24h\\): No closed trades yet\n💰 Portfolio: ${escapeMarkdownV2(`$${stats.initialBalance.toFixed(0)}`)} \\(starting\\)\n🟢 Open Positions: ${openTrades.length}`;
    }
    
    // Check if trade was executed
    const paperTradeStatus = (decision as any).paperTradeExecuted === true
      ? `✅ *Trade Executed* \\#${(decision as any).paperTradeId}`
      : (decision as any).paperTradeExecuted === false
      ? `❌ *Trade Failed*`
      : ``;
    
    // Format opportunities and risks
    const opportunitiesText = decision.opportunities
      .map((opp: string) => `  ✅ ${escapeMarkdownV2(opp)}`)
      .join('\n');
    const risksText = decision.risks
      .map((risk: string) => `  ⚠️ ${escapeMarkdownV2(risk)}`)
      .join('\n');
    
    // Format security info
    let securityText = '';
    if (decision.securityAnalysis) {
      const sec = decision.securityAnalysis;
      const riskEmoji = sec.riskScore >= 50 ? '🚨' : sec.riskScore >= 30 ? '⚠️' : '✅';
      securityText = `
🔒 *Security Check:* ${riskEmoji}
  • Contract: ${sec.contractVerified ? '✅ Verified' : '❌ Not Verified'}
  • Risk Score: ${escapeMarkdownV2(`${sec.riskScore}/100`)}
  • Honeypot: ${sec.honeypotDetected ? '🚨 Detected' : '✅ None'}
${sec.contractAgeDays !== undefined ? `  • Age: ${escapeMarkdownV2(sec.contractAgeDays < 1 ? `${sec.contractAgeHours?.toFixed(1)}h` : `${sec.contractAgeDays.toFixed(1)}d`)}\n` : '  • Age: Unknown\n'}
`;
    }
    
    // Format trading strategy
    let strategyText = '';
    if (decision.positionSize && decision.riskManagement) {
      const currentPrice = decision.marketData.price;
      
      // Use actual position size if trade was executed, otherwise fallback to planned
      const positionUsd = (decision as any).actualPositionUsd || decision.positionSize.maxUsdAmount;
      
      // Calculate the ACTUAL percentage used based on CURRENT portfolio balance
      // This ensures the percentage shown matches the USD amount relative to current balance
      const stats = await this.paperTrader.getStats(24);
      const currentBalance = stats.currentBalance;
      const actualPercentage = (positionUsd / currentBalance) * 100;
      
      // Calculate exact prices
      const stopLossPrice = currentPrice * (1 + decision.riskManagement.stopLoss / 100);
      const tp1Price = currentPrice * (1 + decision.riskManagement.takeProfitLevels[0].percentage / 100);
      const tp2Price = currentPrice * (1 + decision.riskManagement.takeProfitLevels[1].percentage / 100);
      const tp3Price = currentPrice * (1 + decision.riskManagement.takeProfitLevels[2].percentage / 100);
      
      // Format prices in a human-friendly way
      const formatPrice = (price: number): string => {
        if (price >= 1) {
          return `$${price.toFixed(4)}`;
        } else if (price >= 0.0001) {
          return `$${price.toFixed(6)}`;
        } else {
          return `$${price.toFixed(9)}`;
        }
      };
      
      // Format values - use ACTUAL percentage that matches the USD amount
      const posSize = escapeMarkdownV2(`${actualPercentage.toFixed(1)}%`);
      const posAmount = escapeMarkdownV2(`$${positionUsd.toFixed(0)}`);
      const stopLoss = escapeMarkdownV2(`${decision.riskManagement.stopLoss}%`);
      const entryPriceStr = escapeMarkdownV2(formatPrice(currentPrice));
      const stopLossPriceStr = escapeMarkdownV2(formatPrice(stopLossPrice));
      const tp1PriceStr = escapeMarkdownV2(formatPrice(tp1Price));
      const tp2PriceStr = escapeMarkdownV2(formatPrice(tp2Price));
      const tp3PriceStr = escapeMarkdownV2(formatPrice(tp3Price));
      
      strategyText = `
📈 *Trading Strategy:*
  • Entry: ${entryPriceStr} \\(${posSize} ${escapeMarkdownV2('=')} ${posAmount}\\)
  • Stop Loss: ${stopLoss} ${escapeMarkdownV2('→')} ${stopLossPriceStr}
  • TP1: ${escapeMarkdownV2(`+${decision.riskManagement.takeProfitLevels[0].percentage}%`)} ${escapeMarkdownV2('→')} ${tp1PriceStr} ${escapeMarkdownV2(`(sell ${decision.riskManagement.takeProfitLevels[0].sellPercent}%)`)}
  • TP2: ${escapeMarkdownV2(`+${decision.riskManagement.takeProfitLevels[1].percentage}%`)} ${escapeMarkdownV2('→')} ${tp2PriceStr} ${escapeMarkdownV2(`(sell ${decision.riskManagement.takeProfitLevels[1].sellPercent}%)`)}
  • TP3: ${escapeMarkdownV2(`+${decision.riskManagement.takeProfitLevels[2].percentage}%`)} ${escapeMarkdownV2('→')} ${tp3PriceStr} ${escapeMarkdownV2(`(sell ${decision.riskManagement.takeProfitLevels[2].sellPercent}%)`)}
  • Max Hold: ${escapeMarkdownV2(process.env.PAPER_TRADING_MAX_HOLD_HOURS || '24')} ${escapeMarkdownV2('hours (safety timeout)')}

`;
    }
    
    // Format warnings
    let warningsText = '';
    if (decision.warnings && decision.warnings.length > 0) {
      warningsText = `
⚠️ *Warnings:*
${decision.warnings.map(w => `  • ${escapeMarkdownV2(w)}`).join('\n')}

`;
    }
    
    return `
${confidenceEmoji} *${confidenceLabel}* ${confidenceEmoji}

*${escapeMarkdownV2(decision.name)}* \\($${escapeMarkdownV2(decision.symbol)}\\)
🎯 *Confidence: ${escapeMarkdownV2(`${decision.confidence}%`)}*

📋 Contract: \`${decision.token}\`

💰 Market Cap: *${mcFormatted}*
💵 Price: $${priceFormatted}
💧 Liquidity: ${liqFormatted}
📈 Volume 24h: ${volFormatted}

📊 *Trading Activity \\(Last 5min\\):*
  • Buys: ${decision.marketData.buys} ${escapeMarkdownV2('|')} Sells: ${decision.marketData.sells}
  • Net: ${escapeMarkdownV2(decision.marketData.buys - decision.marketData.sells > 0 ? `+${decision.marketData.buys - decision.marketData.sells}` : `${decision.marketData.buys - decision.marketData.sells}`)}
  • Unique Users: ${decision.marketData.users}

${securityText}${strategyText}${this.getAnalysisLabel(decision)}
${escapeMarkdownV2(decision.reasoning)}

✨ *Opportunities:*
${opportunitiesText}

⚠️ *Risks:*
${risksText}
${warningsText}
${this.getExplorerLinks(decision.token)}

${paperTradeStatus ? paperTradeStatus + '\n' : ''}${statsText}

⚠️ _${this.getDisclaimerLabel()} \\- DYOR \\- High Risk \\- Not financial advice_
`.trim();
  }

  private formatAIAlert(token: TokenStats, metadata: CodexBSCTokenData, aiRec: any, entryDecision: any = null): string {
    // Format numbers with proper escaping
    const mcFormatted = formatLargeNumber(metadata.marketCap);
    const liqFormatted = formatLargeNumber(metadata.liquidity);
    const volFormatted = formatLargeNumber(metadata.volume24h);
    const priceFormatted = formatNumber(metadata.priceUSD, 8);
    
    // Build bot activity breakdown with escaped text
    let botActivityText = '';
    token.botActivity.forEach((activity, botName) => {
      if (activity.buys > 0 || activity.sells > 0) {
        botActivityText += `  • ${escapeMarkdownV2(botName)}: ${activity.buys}B / ${activity.sells}S\n`;
      }
    });
    
    // Format AI analysis with proper escaping - GEM FOCUSED EMOJIS
    const scoreEmoji = aiRec.score >= 80 ? '💎🚀' : aiRec.score >= 70 ? '💎' : '🔍';
    const gemLabel = aiRec.score >= 80 ? 'HIDDEN GEM ALERT' : aiRec.score >= 70 ? 'GEM CANDIDATE' : 'TOKEN ALERT';
    
    const opportunitiesText = aiRec.opportunities
      .map((opp: string) => `  ✅ ${escapeMarkdownV2(opp)}`)
      .join('\n');
    const risksText = aiRec.risks
      .map((risk: string) => `  ⚠️ ${escapeMarkdownV2(risk)}`)
      .join('\n');
    
    // Format entry analysis if available (Phase 2)
    let entryAnalysisText = '';
    if (entryDecision) {
      const buyEmoji = entryDecision.shouldBuy ? '✅' : '❌';
      const actionText = entryDecision.shouldBuy ? 'BUY NOW' : 'SKIP';
      
      // Build take profit text with proper escaping
      let takeProfitText = '';
      if (entryDecision.shouldBuy && entryDecision.riskManagement?.takeProfitLevels) {
        takeProfitText = entryDecision.riskManagement.takeProfitLevels
          .map((l: any) => escapeMarkdownV2(`${l.percentage}%`))
          .join(', ');
      }
      
      // Escape all numeric values that might contain special chars
      const confidenceText = escapeMarkdownV2(`${entryDecision.confidence}%`);
      const positionSizeText = escapeMarkdownV2(`${entryDecision.positionSize.percentage}%`);
      const maxAmountText = escapeMarkdownV2(`$${entryDecision.positionSize.maxUsdAmount}`);
      const stopLossText = escapeMarkdownV2(`${entryDecision.riskManagement.stopLoss}%`);
      
      entryAnalysisText = `
🤖 *Phase 2 Entry Analysis:*
  • Decision: ${buyEmoji} *${escapeMarkdownV2(actionText)}*
  • Confidence: ${confidenceText}
  • Reasoning: ${escapeMarkdownV2(entryDecision.reasoning)}
${entryDecision.shouldBuy ? `  • Position Size: ${positionSizeText} \\(max ${maxAmountText}\\)
  • Stop Loss: ${stopLossText}
  • Take Profit: ${takeProfitText}` : ''}
${entryDecision.warnings && entryDecision.warnings.length > 0 ? `  • ⚠️ ${escapeMarkdownV2(entryDecision.warnings[0])}` : ''}

`;
    }
    
    // Format security information if available
    let securityText = '';
    if (aiRec.securityAnalysis) {
      const sec = aiRec.securityAnalysis;
      const riskEmoji = sec.riskScore >= 50 ? '🚨' : sec.riskScore >= 30 ? '⚠️' : '✅';
      securityText = `
🔒 *Security Check:* ${riskEmoji}
  • Contract: ${sec.contractVerified ? '✅ Verified' : '❌ Not Verified'}
  • Risk Score: ${sec.riskScore}/100
  • Honeypot: ${sec.honeypotDetected ? '🚨 Detected' : '✅ None'}
  • Hidden Functions: ${sec.hiddenFunctionsDetected ? '🚨 Detected' : '✅ None'}
${sec.risks.length > 0 ? `  • 🚨 ${escapeMarkdownV2(sec.risks[0])}` : ''}

`;
    }
    
    return `
${scoreEmoji} *${gemLabel}* ${scoreEmoji}

*${escapeMarkdownV2(metadata.name)}* \\($${escapeMarkdownV2(metadata.symbol)}\\)
📊 *Gem Score: ${aiRec.score}/100*

📋 Contract: \`${token.token}\`

💰 Market Cap: *${mcFormatted}*
💵 Price: $${priceFormatted}
💧 Liquidity: ${liqFormatted}
📈 Volume 24h: ${volFormatted}
${metadata.holders ? `👥 Holders: ${metadata.holders}\n` : ''}${aiRec.securityAnalysis?.contractAgeDays !== undefined ? `🕒 Age: ${escapeMarkdownV2(aiRec.securityAnalysis.contractAgeDays < 1 ? `${aiRec.securityAnalysis.contractAgeHours?.toFixed(1)}h` : `${aiRec.securityAnalysis.contractAgeDays.toFixed(1)}d`)}\n` : ''}
${securityText}${entryAnalysisText}🔍 *AI Analysis:*
${escapeMarkdownV2(aiRec.reasoning)}

✨ *Opportunities:*
${opportunitiesText}

⚠️ *Risks:*
${risksText}

📊 *Trading Activity \\(Last 5min\\):*
  • Buys: ${token.buys} ${escapeMarkdownV2('|')} Sells: ${token.sells}
  • Net Flow: ${escapeMarkdownV2(token.netBuys > 0 ? `+${token.netBuys}` : token.netBuys.toString())}
  • Unique Users: ${token.users.size}

🤖 *Bot Activity:*
${botActivityText}
${this.getExplorerLinks(token.token)}

⚠️ _AI Gem Hunter \\- DYOR \\- High Risk/High Reward \\- Not financial advice_
`.trim();
  }

  /**
   * Get analysis label based on whether AI or point-based system is used
   */
  private getAnalysisLabel(decision: TradingDecision): string {
    const useAI = process.env.USE_AI_ANALYSIS !== 'false';
    
    if (useAI) {
      return '🤖 *AI Analysis:*\n';
    } else {
      // Point-based system - show score if available in reasoning
      const scoreMatch = decision.reasoning.match(/(\d+)\/100/);
      if (scoreMatch) {
        const score = parseInt(scoreMatch[1]);
        const emoji = score >= 85 ? '⭐' : score >= 80 ? '✨' : '📊';
        return `${emoji} *Analysis \\(Score: ${escapeMarkdownV2(score.toString())}/100\\):*\n`;
      }
      return '📊 *Analysis:*\n';
    }
  }
  
  /**
   * Get disclaimer label based on system mode
   */
  private getDisclaimerLabel(): string {
    const useAI = process.env.USE_AI_ANALYSIS !== 'false';
    return useAI ? 'AI Trading Bot' : 'Automated Trading Bot';
  }

  /**
   * Get chain-appropriate explorer links
   */
  private getExplorerLinks(tokenAddress: string): string {
    const chainConfig = getChainConfig();
    
    if (chainConfig.chain === Chain.SOLANA) {
      // Solana links
      return `🔗 [Trade on Padre](https://trade.padre.gg/trade/solana/${tokenAddress})
🔗 [View on DexScreener](https://dexscreener.com/solana/${tokenAddress})`;
    } else {
      // BSC links  
      return `🔗 [Trade on Padre](https://trade.padre.gg/trade/bsc/${tokenAddress})
🔗 [View on DexScreener](https://dexscreener.com/bsc/${tokenAddress})`;
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.paperTrader.stopMonitoring();
    hybridShadowTracker.stopMonitoring();
    this.isRunning = false;
    logger.info('🛑 Token monitor stopped');
  }
  
  /**
   * Post simplified alert to public channel (delayed)
   * Shows enough for people to copy the trade, but hides strategy details
   * 
   * Optional: Only posts if price moved favorably (PUBLIC_MIN_GAIN_TO_POST)
   */
  private async postToPublicChannel(decision: TradingDecision): Promise<void> {
    const PUBLIC_DELAY_MS = parseInt(process.env.PUBLIC_DELAY_SECONDS || '90', 10) * 1000; // Default 90s
    const MIN_GAIN_TO_POST = parseFloat(process.env.PUBLIC_MIN_GAIN_TO_POST || '0'); // 0 = always post
    
    // Wait before checking price
    await new Promise(resolve => setTimeout(resolve, PUBLIC_DELAY_MS));
    
    try {
      // If MIN_GAIN_TO_POST is set, check if trade is profitable before posting
      if (MIN_GAIN_TO_POST > 0) {
        const shouldPost = await this.shouldPostToPublic(decision, MIN_GAIN_TO_POST);
        if (!shouldPost) {
          logger.info(
            `🚫 Skipping public post for ${decision.symbol} - ` +
            `price didn't reach +${MIN_GAIN_TO_POST}% threshold`
          );
          return;
        }
      }
      
      // Format simplified alert - keep trade details, hide strategy reasoning
      const message = await this.formatPublicAlert(decision);
      
      await this.bot.api.sendMessage(this.publicChannelId!, message, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
      
      logger.success(
        `🌐 Posted PUBLIC alert for ${decision.symbol} ` +
        `(delayed ${PUBLIC_DELAY_MS / 1000}s)`
      );
    } catch (error: any) {
      logger.error(`Failed to post public alert for ${decision.symbol}`, error);
    }
  }
  
  /**
   * Check if we should post to public based on price performance
   * Returns true if price gained at least minGainPercent since entry
   */
  private async shouldPostToPublic(decision: TradingDecision, minGainPercent: number): Promise<boolean> {
    try {
      // Get current price using price service
      const currentPrice = await priceService.getPrice(decision.token);
      
      if (!currentPrice) {
        logger.warn('Could not fetch price, posting anyway');
        return true;
      }
      
      const entryPrice = decision.marketData.price;
      const gainPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
      
      logger.info(
        `📊 ${decision.symbol} price check: ` +
        `Entry $${entryPrice.toFixed(8)} → Current $${currentPrice.toFixed(8)} ` +
        `(${gainPercent >= 0 ? '+' : ''}${gainPercent.toFixed(2)}%)`
      );
      
      return gainPercent >= minGainPercent;
      
    } catch (error) {
      logger.error('Error checking price for public post', error);
      // If error, post anyway (fail open)
      return true;
    }
  }
  
  /**
   * Format public alert - redact strategy details with █ blocks
   */
  private async formatPublicAlert(decision: TradingDecision): Promise<string> {
    // Format numbers with proper escaping
    const mcFormatted = formatLargeNumber(decision.marketData.marketCap);
    const liqFormatted = formatLargeNumber(decision.marketData.liquidity);
    const volFormatted = formatLargeNumber(decision.marketData.volume24h);
    const priceFormatted = formatNumber(decision.marketData.price, 8);
    
    const confidenceEmoji = decision.confidence >= 85 ? '💎🚀' : decision.confidence >= 75 ? '💎' : '✅';
    const confidenceLabel = decision.confidence >= 85 ? 'HIGH CONFIDENCE BUY' : decision.confidence >= 75 ? 'BUY SIGNAL' : 'MODERATE BUY';
    
    // Format entry price with smart precision (same as private alert)
    const formatPrice = (price: number): string => {
      if (price >= 1) {
        return `$${price.toFixed(4)}`;
      } else if (price >= 0.0001) {
        return `$${price.toFixed(6)}`;
      } else {
        return `$${price.toFixed(9)}`;
      }
    };
    const entryPriceStr = escapeMarkdownV2(formatPrice(decision.marketData.price));
    // Security text (exact same as private alert)
    let securityText = '';
    if (decision.securityAnalysis) {
      const sec = decision.securityAnalysis;
      const riskEmoji = sec.riskScore >= 50 ? '🚨' : sec.riskScore >= 30 ? '⚠️' : '✅';
      securityText = `
🔒 *Security Check:* ${riskEmoji}
  • Contract: ${sec.contractVerified ? '✅ Verified' : '❌ Not Verified'}
  • Risk Score: ${escapeMarkdownV2(`${sec.riskScore}/100`)}
  • Honeypot: ${sec.honeypotDetected ? '🚨 Detected' : '✅ None'}
${sec.contractAgeDays !== undefined ? `  • Age: ${escapeMarkdownV2(sec.contractAgeDays < 1 ? `${sec.contractAgeHours?.toFixed(1)}h` : `${sec.contractAgeDays.toFixed(1)}d`)}\n` : '  • Age: Unknown\n'}
`;
    }
    
    // Redacted opportunities (show only first word/emoji)
    const opportunitiesText = decision.opportunities
      .map((opp: string) => `  ✅ ${escapeMarkdownV2('█'.repeat(40))}`)
      .join('\n');
    
    // Redacted risks (show only first word/emoji)
    const risksText = decision.risks
      .map((risk: string) => `  ⚠️ ${escapeMarkdownV2('█'.repeat(40))}`)
      .join('\n');
    
    // Redacted warnings
    const warningsText = decision.warnings && decision.warnings.length > 0
      ? decision.warnings.map((w: string) => `  ${escapeMarkdownV2('•')} ${escapeMarkdownV2('█'.repeat(40))}`).join('\n') + '\n'
      : '';
    
    return `
${confidenceEmoji} *${confidenceLabel}* ${confidenceEmoji}

*${escapeMarkdownV2(decision.name)}* \\($${escapeMarkdownV2(decision.symbol)}\\)
🎯 *Confidence: ${escapeMarkdownV2(`${decision.confidence}%`)}*

📋 Contract: \`${decision.token}\`

💰 Market Cap: *${mcFormatted}*
💵 Price: $${priceFormatted}
💧 Liquidity: ${liqFormatted}
📈 Volume 24h: ${volFormatted}

📊 *Trading Activity \\(Last 5min\\):*
  • Buys: ${decision.marketData.buys} ${escapeMarkdownV2('|')} Sells: ${decision.marketData.sells}
  • Net: ${escapeMarkdownV2(decision.marketData.buys - decision.marketData.sells > 0 ? `+${decision.marketData.buys - decision.marketData.sells}` : `${decision.marketData.buys - decision.marketData.sells}`)}
  • Unique Users: ${decision.marketData.users}

${securityText}

📈 *Trading Strategy:*
  ${escapeMarkdownV2('•')} Entry: ${entryPriceStr}
  ${escapeMarkdownV2('•')} Stop Loss: ${escapeMarkdownV2('█'.repeat(20))}
  ${escapeMarkdownV2('•')} Take Profits: ${escapeMarkdownV2('█'.repeat(20))}

🤖 *AI Analysis:*
${escapeMarkdownV2('█'.repeat(60))}

✨ *Opportunities:*
${opportunitiesText}

⚠️ *Risks:*
${risksText}

${warningsText ? `⚠️ *Warnings:*\n${warningsText}` : ''}
${this.getExplorerLinks(decision.token)}


✅ Trade Executed ${escapeMarkdownV2('#')}${escapeMarkdownV2('█'.repeat(3))}
📊 Trading \\(24h\\): ${escapeMarkdownV2('█'.repeat(15))}
💰 Portfolio: ${escapeMarkdownV2('█'.repeat(15))}
🟢 Open Positions: ${escapeMarkdownV2('█'.repeat(5))}


⚠️ *AI Trading Bot \\- DYOR \\- High Risk \\- Not financial advice*`;
  }
  
  // Paper trading utilities
  async getPaperTradingStats(hours: number = 24) {
    return await this.paperTrader.getStats(hours);
  }
  
  async getOpenPaperTrades() {
    return await this.paperTrader.getOpenTrades();
  }
  
  /**
   * Execute a watchlist trade (called by WatchlistManager when Haiku approves)
   */
  private async executeWatchlistTrade(entry: any, price: number): Promise<void> {
    try {
      logger.info(`📤 Executing watchlist trade for ${entry.symbol} at $${price}`);
      
      // Fetch fresh trading activity from DexScreener using VolumeAnalyzer
      const { VolumeAnalyzer } = await import('./data-gatherers/volume-analyzer');
      const volumeAnalyzer = new VolumeAnalyzer();
      const volumeMetrics = await volumeAnalyzer.getVolumeMetrics(entry.token_address);
      
      const buys = volumeMetrics.txnBuys5m || 0;
      const sells = volumeMetrics.txnSells5m || 0;
      const users = Math.ceil((buys + sells) / 2); // Rough estimate
      
      logger.debug(`Trading activity for ${entry.symbol}: ${buys}B/${sells}S, ${users} users`);
      
      // We need to reconstruct the TradingDecision object from the watchlist entry
      // Get the original decision from DB
      const { query } = await import('../infra/database');
      const result = await query(`
        SELECT * FROM decisions WHERE id = $1
      `, [entry.decision_id]);
      
      if (result.rows.length === 0) {
        logger.error(`⚠️  No decision found for watchlist entry ${entry.id}`);
        return;
      }
      
      const dbDecision = result.rows[0];
      
      // Reconstruct TradingDecision object
      const decision: any = {
        token: entry.token_address,
        symbol: entry.symbol,
        name: dbDecision.name || entry.symbol,
        shouldBuy: true,
        confidence: dbDecision?.confidence || 0,
        reasoning: dbDecision?.reasoning || '',
        marketData: {
          price: price,
          marketCap: dbDecision.market_cap || 0,
          liquidity: dbDecision.liquidity || 0,
          volume24h: dbDecision.volume_24h || 0,
          ageHours: dbDecision.age_hours || 0,
          buys: buys,   // Fresh data from DexScreener
          sells: sells, // Fresh data from DexScreener
          users: users, // Fresh data (estimated)
        },
        positionSize: {
          percentage: dbDecision.position_size_percent || 1,
          maxUsdAmount: (dbDecision.position_size_percent || 1) * 10, // Rough estimate
        },
        riskManagement: {
          stopLoss: dbDecision.stop_loss_percent || 18,
          takeProfitLevels: [
            {
              percentage: dbDecision.take_profit_1_percent || 18,
              sellPercent: 40,
            },
            {
              percentage: dbDecision.take_profit_2_percent || 35,
              sellPercent: 35,
            },
            {
              percentage: dbDecision.take_profit_3_percent || 55,
              sellPercent: 25,
            },
          ],
        },
        opportunities: dbDecision?.opportunities || [],
        risks: dbDecision?.risks || [],
        warnings: dbDecision?.warnings || [],
      };
      
      // Execute paper trade
      const tradeId = await this.paperTrader.executeTrade(decision, entry.decision_id, price);
      
      if (!tradeId) {
        logger.error(`⚠️  Failed to execute paper trade for ${entry.symbol}`);
        return;
      }
      
      // Get actual position size
      const trade = await this.paperTrader.getTradeById(tradeId);
      if (trade) {
        decision.actualPositionUsd = trade.entry_amount_usd;
        decision.paperTradeId = tradeId;
        decision.paperTradeExecuted = true;
      }
      
      // Post to Telegram
      const message = await this.formatTradingAlert(decision);
      
      await this.bot.api.sendMessage(this.channelId, message, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
      
      logger.success(`📣 Posted watchlist BUY alert for ${entry.symbol} (Haiku approved)`);
      
      // Post to public channel if enabled
      if (this.publicChannelId) {
        this.postToPublicChannel(decision).catch(err => {
          logger.error(`Failed to post to public channel for ${entry.symbol}`, err);
        });
      }
    } catch (error) {
      logger.error(`Failed to execute watchlist trade for ${entry.symbol}:`, error);
    }
  }
}

