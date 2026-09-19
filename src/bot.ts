#!/usr/bin/env bun
/**
 * Unrekt Telegram Bot
 * 
 * Scans BSC bot routers and alerts users about hot tokens
 * 
 * Usage:
 *   bun run src/bot.ts
 */

import { Bot, webhookCallback } from 'grammy';
import type { Update } from 'grammy/types';
import { startCommand } from './commands/start';
import { statsCommand } from './commands/stats';
import { TokenMonitor } from './services/monitor';
import { logger } from './utils/logger';
import { hash } from 'crypto';
import { getCurrentChain, getChainConfig, validateChainConfig } from './config/chain';
import { initializeSchema, closePool, query } from './infra/database';

/** Gzip-compress JSON responses when client supports it */
function jsonGzip(data: unknown, request: Request, status = 200): Response {
  const json = JSON.stringify(data);
  const acceptEncoding = request.headers.get('accept-encoding') || '';
  if (acceptEncoding.includes('gzip') && json.length > 1024) {
    return new Response(Bun.gzipSync(Buffer.from(json)), {
      status,
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    });
  }
  return new Response(json, { status, headers: { 'Content-Type': 'application/json' } });
}

// Initialize database schema on startup
logger.info('🔄 Initializing database schema...');
await initializeSchema();

// Validate chain configuration on startup
const chainValidation = validateChainConfig();
if (!chainValidation.valid) {
  logger.error('❌ Invalid chain configuration:');
  chainValidation.errors.forEach(err => logger.error(`   - ${err}`));
  process.exit(1);
}

const chainConfig = getChainConfig();
logger.info(`⛓️  Chain: ${chainConfig.name} (${chainConfig.chain})`);
logger.info(`🔗 RPC: ${chainConfig.rpcUrl.substring(0, 50)}...`);
logger.info(`🔍 Explorer: ${chainConfig.explorerUrl}`);

// Environment configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ENABLE_WEBHOOKS = process.env.ENABLE_WEBHOOKS === 'true';
const PORT = parseInt(process.env.PORT || '8080');
const BOT_WEBHOOK_HOST = process.env.BOT_WEBHOOK_HOST; // e.g., https://yourapp.run.app
const WEBHOOK_SECRET_TOKEN = process.env.WEBHOOK_SECRET_TOKEN || 'your-secret-token';

if (!BOT_TOKEN) {
  logger.error('❌ TELEGRAM_BOT_TOKEN is not set in environment');
  logger.error('   Get a token from @BotFather on Telegram');
  process.exit(1);
}

// Create bot instance
const bot = new Bot(BOT_TOKEN);

// Add unique instance ID for debugging
const INSTANCE_ID = `${process.env.K_REVISION || 'local'}-${Date.now()}`;
logger.info(`🆔 Instance ID: ${INSTANCE_ID}`);

// Set bot commands menu
bot.api.setMyCommands([
  { command: 'start', description: `Scan for hot tokens on ${chainConfig.name}` },
  { command: 'stats', description: 'Show paper trading stats' },
  { command: 'help', description: 'Show help and bot info' },
]).catch((err) => {
  logger.warn('Failed to set bot commands', err);
});

// Register commands
bot.command('start', startCommand);
bot.command('stats', statsCommand);

// Help command
bot.command('help', async (ctx) => {
  await ctx.reply(
    '🔥 *Unrekt Hot Token Bot*\n\n' +
    'Commands:\n' +
    '/start - Scan for hot tokens on BSC\n' +
    '/stats - Show paper trading stats\n' +
    '/help - Show this help message\n\n' +
    'This bot scans trading activity from major BSC bots:\n' +
    '🍌 BananaGun\n' +
    '🎵 Maestro\n' +
    '⚡ Axios\n' +
    '∑ Sigma\n' +
    '🌸 Bloom\n' +
    '🔨 BonkBot\n\n' +
    'Features:\n' +
    '• Real-time buy/sell tracking\n' +
    '• Token metadata (name, price, liquidity)\n' +
    '• Links to DexScreener\n' +
    '• Paper trading with AI analysis\n\n' +
    '_Scans last 300 blocks (~15 minutes)_\n' +
    '_Note: Scanning takes 30-60 seconds_',
    { parse_mode: 'Markdown' }
  );
});

// Handle errors
bot.catch((err) => {
  const error = err.error as any;
  if (error?.error_code === 409) {
    logger.warn('⚠️  Another bot instance is running, shutting down this instance...');
    process.exit(0); // Exit gracefully
  }
  logger.error('Bot error', err);
});

// Graceful shutdown
let isShuttingDown = false;
let monitor: TokenMonitor | undefined;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.error(`🛑 [${INSTANCE_ID}] ${signal} received, shutting down gracefully...`);
  
  const promises: Promise<unknown>[] = [];
  
  // Stop monitor first (stops background intervals)
  if (monitor) {
    logger.info('Stopping monitor...');
    try {
      monitor.stop();
    } catch (err) {
      logger.warn('Error stopping monitor:', err);
    }
  }
  
  // Stop HTTP server
  if (server) {
    logger.info('Stopping HTTP server...');
    promises.push(server.stop());
  }
  
  // Stop bot
  logger.info('Stopping bot...');
  promises.push(bot.stop());
  
  // Close database pool
  logger.info('Closing database connections...');
  promises.push(closePool());
  
  try {
    await Promise.all(promises);
    logger.info('✅ All services stopped gracefully');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start bot
logger.info('🤖 Starting Unrekt Telegram Bot...');
logger.info('📊 Tracking 7 BSC bot routers');

if (process.env.DISABLE_FILE_LOGGING === 'true') {
  logger.info('📝 File logging disabled (container mode)');
} else {
  logger.info('📝 File logging enabled (writing to bot.log)');
}

// Start bot in webhook mode (required)
let server: ReturnType<typeof Bun.serve> | undefined;

if (ENABLE_WEBHOOKS && BOT_WEBHOOK_HOST) {
  // ===========================================================================
  // WEBHOOK MODE (for Cloud Run production)
  // ===========================================================================
  logger.info('🌐 Starting in WEBHOOK mode');
  
  // Use bot token hash as secret path to avoid exposing token
  const secretPath = `/bot/webhook/${hash('sha256', BOT_TOKEN).slice(0, 20)}`;
  const webhookUrl = `${BOT_WEBHOOK_HOST}${secretPath}`;
  
  const callback = webhookCallback(bot, 'bun', {
    secretToken: WEBHOOK_SECRET_TOKEN,
    timeoutMilliseconds: 10000,
    onTimeout: () => {
      const error = 'Webhook timeout after 10000ms';
      logger.error(error);
      // Telegram will retry the update, so we just log it
    },
  });
  
  server = Bun.serve({
    port: PORT,
    idleTimeout: 120, // 2 minutes - allow long-running analytics queries
    async fetch(request) {
      const url = new URL(request.url);
      
      // Health check endpoint
      if (url.pathname === '/health') {
        return new Response('OK', { status: 200 });
      }
      
      // Whitepaper PDF
      if (url.pathname === '/WHITEPAPER.pdf') {
        try {
          const possiblePaths = [
            './WHITEPAPER.pdf',
            '../WHITEPAPER.pdf',
            process.cwd() + '/WHITEPAPER.pdf',
            '/app/WHITEPAPER.pdf',
          ];

          for (const path of possiblePaths) {
            try {
              const file = Bun.file(path);
              const bytes = await file.arrayBuffer();
              if (bytes && bytes.byteLength > 0) {
                return new Response(bytes, {
                  headers: { 'Content-Type': 'application/pdf' },
                });
              }
            } catch (e) {
              continue;
            }
          }

          return new Response('File not found', { status: 404 });
        } catch (err) {
          logger.error('Failed to load WHITEPAPER.pdf:', err);
          return new Response('File not found', { status: 404 });
        }
      }

      // Static files (CSS, JS)
      if (url.pathname === '/style.css' || url.pathname === '/script.js') {
        try {
          const fileName = url.pathname.slice(1); // Remove leading slash
          const possiblePaths = [
            `./${fileName}`,
            `../${fileName}`,
            process.cwd() + `/${fileName}`,
            `/app/${fileName}`,
          ];
          
          for (const path of possiblePaths) {
            try {
              const file = Bun.file(path);
              const text = await file.text();
              if (text && text.length > 0) {
                const contentType = fileName.endsWith('.css') ? 'text/css' : 'application/javascript';
                return new Response(text, {
                  headers: { 'Content-Type': contentType },
                });
              }
            } catch (e) {
              continue;
            }
          }
          
          return new Response('File not found', { status: 404 });
        } catch (err) {
          logger.error(`Failed to load ${url.pathname}:`, err);
          return new Response('File not found', { status: 404 });
        }
      }
      
      // Landing page (root)
      if (url.pathname === '/') {
        try {
          const possiblePaths = [
            './index.html',
            '../index.html',
            process.cwd() + '/index.html',
            '/app/index.html',
          ];
          
          let html: string | null = null;
          for (const path of possiblePaths) {
            try {
              const file = Bun.file(path);
              const text = await file.text();
              if (text && text.length > 0) {
                html = text;
                break;
              }
            } catch (e) {
              continue;
            }
          }
          
          if (html) {
            return new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            });
          }
          
          logger.warn('Landing page not found, returning health check');
          return new Response('OK', { status: 200 });
        } catch (err) {
          logger.error('Failed to load landing page:', err);
          return new Response('OK', { status: 200 });
        }
      }
      
      // Analytics API endpoints
      if (url.pathname === '/api/token-flow') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const params = Object.fromEntries(url.searchParams.entries());
          const options: any = {};
          
          if (params.limit) options.limit = parseInt(params.limit);
          if (params.offset) options.offset = parseInt(params.offset);
          if (params.flowStage) options.flowStage = params.flowStage;
          if (params.scanId) options.scanId = params.scanId;
          if (params.tokenAddress) options.tokenAddress = params.tokenAddress;
          if (params.chain) options.chain = params.chain;
          if (params.dateFrom) options.dateFrom = params.dateFrom;
          if (params.dateTo) options.dateTo = params.dateTo;
          if (params.strategyVersion) options.strategyVersion = params.strategyVersion;
          
          const result = await analyticsAPI.getTokenFlowData(options);
          return jsonGzip(result, request);
        } catch (err) {
          logger.error('Analytics API error:', err);
          return jsonGzip({ error: 'Failed to fetch data' }, request, 500);
        }
      }
      
      if (url.pathname === '/api/summary') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const params = Object.fromEntries(url.searchParams.entries());
          const options: any = {};
          
          if (params.hours) options.hours = parseInt(params.hours);
          if (params.dateFrom) options.dateFrom = params.dateFrom;
          if (params.dateTo) options.dateTo = params.dateTo;
          if (params.chain) options.chain = params.chain;
          if (params.strategyVersion) options.strategyVersion = params.strategyVersion;
          
          const stats = await analyticsAPI.getSummaryStats(options);
          return jsonGzip(stats, request);
        } catch (err) {
          logger.error('Summary API error:', err);
          return jsonGzip({ error: 'Failed to fetch stats' }, request, 500);
        }
      }

      if (url.pathname === '/api/strategies') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const strategies = await analyticsAPI.getStrategies();
          return jsonGzip(strategies, request);
        } catch (err) {
          logger.error('Strategies API error:', err);
          return jsonGzip({ error: 'Failed to fetch strategies' }, request, 500);
        }
      }

      if (url.pathname === '/api/funnel') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = url.searchParams.get('hours') ? parseInt(url.searchParams.get('hours')!) : undefined;
          const dateFrom = url.searchParams.get('dateFrom') || undefined;
          const dateTo = url.searchParams.get('dateTo') || undefined;
          const data = await analyticsAPI.getFunnelData({ hours, dateFrom, dateTo });
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Funnel API error:', err);
          return jsonGzip({ error: 'Failed to fetch funnel data' }, request, 500);
        }
      }

      if (url.pathname === '/api/bot-performance') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = url.searchParams.get('hours') ? parseInt(url.searchParams.get('hours')!) : undefined;
          const dateFrom = url.searchParams.get('dateFrom') || undefined;
          const dateTo = url.searchParams.get('dateTo') || undefined;
          const data = await analyticsAPI.getBotPerformanceData({ hours, dateFrom, dateTo });
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Bot performance API error:', err);
          return jsonGzip({ error: 'Failed to fetch bot performance data' }, request, 500);
        }
      }

      if (url.pathname === '/api/time-series') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = parseInt(url.searchParams.get('hours') || '24');
          const interval = url.searchParams.get('interval') || '1 hour';
          const data = await analyticsAPI.getTimeSeriesData(hours, interval);
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Time series API error:', err);
          return jsonGzip({ error: 'Failed to fetch time series data' }, request, 500);
        }
      }

      if (url.pathname === '/api/hourly-activity') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const days = parseInt(url.searchParams.get('days') || '7');
          const data = await analyticsAPI.getHourlyActivityData(days);
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Hourly activity API error:', err);
          return jsonGzip({ error: 'Failed to fetch hourly activity data' }, request, 500);
        }
      }

      if (url.pathname === '/api/regime') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const chain = url.searchParams.get('chain') || undefined;
          const regime = await analyticsAPI.getCurrentRegime(chain);
          return jsonGzip(regime, request);
        } catch (err) {
          logger.error('Regime API error:', err);
          return jsonGzip({ error: 'Failed to fetch regime data' }, request, 500);
        }
      }

      if (url.pathname === '/api/regime-history') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = parseInt(url.searchParams.get('hours') || '24');
          const chain = url.searchParams.get('chain') || undefined;
          const history = await analyticsAPI.getRegimeHistory(hours, chain);
          return jsonGzip(history, request);
        } catch (err) {
          logger.error('Regime history API error:', err);
          return jsonGzip({ error: 'Failed to fetch regime history' }, request, 500);
        }
      }

      if (url.pathname === '/api/activity-decay') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = parseInt(url.searchParams.get('hours') || '168'); // Default 7 days
          const data = await analyticsAPI.getActivityDecayAnalysis(hours);
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Activity decay API error:', err);
          return jsonGzip({ error: 'Failed to fetch activity decay analysis' }, request, 500);
        }
      }

      if (url.pathname === '/api/returns-distribution') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = url.searchParams.get('hours') ? parseInt(url.searchParams.get('hours')!) : undefined;
          const dateFrom = url.searchParams.get('dateFrom') || undefined;
          const dateTo = url.searchParams.get('dateTo') || undefined;
          const data = await analyticsAPI.getReturnsDistribution({ hours, dateFrom, dateTo });
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Returns distribution API error:', err);
          return jsonGzip({ error: 'Failed to fetch returns distribution' }, request, 500);
        }
      }

      if (url.pathname === '/api/sharpe-ratio-over-time') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = url.searchParams.get('hours') ? parseInt(url.searchParams.get('hours')!) : undefined;
          const dateFrom = url.searchParams.get('dateFrom') || undefined;
          const dateTo = url.searchParams.get('dateTo') || undefined;
          const windowSize = url.searchParams.get('windowSize') ? parseInt(url.searchParams.get('windowSize')!) : undefined;
          const data = await analyticsAPI.getSharpeRatioOverTime({ hours, dateFrom, dateTo, windowSize });
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Sharpe ratio over time API error:', err);
          return jsonGzip({ error: 'Failed to fetch Sharpe ratio over time' }, request, 500);
        }
      }

      if (url.pathname === '/api/drawdown') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = url.searchParams.get('hours') ? parseInt(url.searchParams.get('hours')!) : undefined;
          const dateFrom = url.searchParams.get('dateFrom') || undefined;
          const dateTo = url.searchParams.get('dateTo') || undefined;
          const data = await analyticsAPI.getDrawdownData({ hours, dateFrom, dateTo });
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Drawdown API error:', err);
          return jsonGzip({ error: 'Failed to fetch drawdown data' }, request, 500);
        }
      }

      if (url.pathname === '/api/position-size-vs-pnl') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = url.searchParams.get('hours') ? parseInt(url.searchParams.get('hours')!) : undefined;
          const dateFrom = url.searchParams.get('dateFrom') || undefined;
          const dateTo = url.searchParams.get('dateTo') || undefined;
          const data = await analyticsAPI.getPositionSizeVsPnL({ hours, dateFrom, dateTo });
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Position size vs PnL API error:', err);
          return jsonGzip({ error: 'Failed to fetch position size vs PnL data' }, request, 500);
        }
      }

      if (url.pathname === '/api/correlation-matrix') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = url.searchParams.get('hours') ? parseInt(url.searchParams.get('hours')!) : undefined;
          const dateFrom = url.searchParams.get('dateFrom') || undefined;
          const dateTo = url.searchParams.get('dateTo') || undefined;
          const data = await analyticsAPI.getCorrelationMatrix({ hours, dateFrom, dateTo });
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Correlation matrix API error:', err);
          return jsonGzip({ error: 'Failed to calculate correlation matrix' }, request, 500);
        }
      }

      if (url.pathname === '/api/alpha-beta') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = url.searchParams.get('hours') ? parseInt(url.searchParams.get('hours')!) : undefined;
          const dateFrom = url.searchParams.get('dateFrom') || undefined;
          const dateTo = url.searchParams.get('dateTo') || undefined;
          const windowSize = url.searchParams.get('windowSize') ? parseInt(url.searchParams.get('windowSize')!) : 30;
          const data = await analyticsAPI.getAlphaBetaAnalysis({ hours, dateFrom, dateTo, windowSize });
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Alpha/Beta API error:', err);
          return jsonGzip({ error: 'Failed to calculate alpha/beta analysis' }, request, 500);
        }
      }

      if (url.pathname === '/api/kelly-criterion') {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const hours = url.searchParams.get('hours') ? parseInt(url.searchParams.get('hours')!) : undefined;
          const dateFrom = url.searchParams.get('dateFrom') || undefined;
          const dateTo = url.searchParams.get('dateTo') || undefined;
          const data = await analyticsAPI.getKellyCriterion({ hours, dateFrom, dateTo });
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Kelly Criterion API error:', err);
          return jsonGzip({ error: 'Failed to calculate Kelly Criterion' }, request, 500);
        }
      }

      if (url.pathname.startsWith('/api/pre-scan-candles/')) {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const pathParts = url.pathname.split('/');
          const tokenAddress = decodeURIComponent(pathParts[3]);
          const chain = decodeURIComponent(pathParts[4]);
          const scanTimestamp = decodeURIComponent(pathParts[5]);
          const minutesBefore = url.searchParams.get('minutes') ? parseInt(url.searchParams.get('minutes')!) : 30;
          
          const data = await analyticsAPI.getPreScanCandles(tokenAddress, chain, scanTimestamp, minutesBefore);
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Pre-scan candles API error:', err);
          return jsonGzip({ error: 'Failed to fetch pre-scan candles' }, request, 500);
        }
      }

      if (url.pathname.startsWith('/api/price-history/')) {
        try {
          const { analyticsAPI } = await import('./services/analytics-api');
          const pathParts = url.pathname.split('/');
          const tokenAddress = pathParts[pathParts.length - 1];
          const chain = url.searchParams.get('chain') || 'SOLANA';
          const scanTimestamp = url.searchParams.get('scanTimestamp');
          
          if (!scanTimestamp) {
            return jsonGzip({ error: 'scanTimestamp parameter required' }, request, 400);
          }
          
          const data = await analyticsAPI.getPriceHistory(tokenAddress, chain, scanTimestamp);
          return jsonGzip(data, request);
        } catch (err) {
          logger.error('Price history API error:', err);
          return jsonGzip({ error: 'Failed to fetch price history' }, request, 500);
        }
      }
      
      if (url.pathname === '/api/codex-requests') {
        try {
          const { codexRequestTracker } = await import('./utils/codex-request-tracker');
          const minutes = url.searchParams.get('minutes') ? parseInt(url.searchParams.get('minutes')!, 10) : 60;
          const stats = codexRequestTracker.getStats(minutes);
          return jsonGzip({
            period_minutes: minutes,
            ...stats,
            hourly_rate: stats.total * (60 / minutes),
            daily_estimate: (stats.total * (60 / minutes)) * 24,
          }, request);
        } catch (err) {
          logger.error('Codex requests API error:', err);
          return jsonGzip({ error: 'Failed to fetch Codex request stats' }, request, 500);
        }
      }
      
      if (url.pathname === '/api/rpc-requests') {
        try {
          const { rpcRequestTracker } = await import('./utils/rpc-request-tracker');
          const minutes = url.searchParams.get('minutes') ? parseInt(url.searchParams.get('minutes')!, 10) : 60;
          const stats = rpcRequestTracker.getStats(minutes);
          return jsonGzip({
            period_minutes: minutes,
            ...stats,
            hourly_rate: stats.total * (60 / minutes),
            daily_estimate: (stats.total * (60 / minutes)) * 24,
          }, request);
        } catch (err) {
          logger.error('RPC requests API error:', err);
          return jsonGzip({ error: 'Failed to fetch RPC request stats' }, request, 500);
        }
      }

      if (url.pathname === '/api/jupiter-requests') {
        try {
          const { jupiterRequestTracker } = await import('./utils/jupiter-request-tracker');
          const minutes = url.searchParams.get('minutes') ? parseInt(url.searchParams.get('minutes')!, 10) : 60;
          const stats = jupiterRequestTracker.getStats(minutes);
          return jsonGzip({
            period_minutes: minutes,
            ...stats,
            hourly_rate: stats.total * (60 / minutes),
            daily_estimate: (stats.total * (60 / minutes)) * 24,
          }, request);
        } catch (err) {
          logger.error('Jupiter requests API error:', err);
          return jsonGzip({ error: 'Failed to fetch Jupiter request stats' }, request, 500);
        }
      }
      
      // Hybrid shadow strategy API endpoints
      if (url.pathname === '/api/hybrid/stats') {
        try {
          const { hybridShadowTracker } = await import('./services/hybrid-shadow-tracker');
          if (!hybridShadowTracker.isEnabled()) {
            return jsonGzip({ enabled: false, message: 'Hybrid shadow mode is disabled' }, request);
          }
          const stats = await hybridShadowTracker.getStats();
          const realTrading = process.env.USE_REAL_SOLANA_TRADING === 'true';
          
          // Get current balance (real wallet or paper)
          const balance = await hybridShadowTracker.getCurrentBalance();
          
          return jsonGzip({ 
            enabled: true, 
            realTrading, 
            ...stats,
            currentBalance: balance.balanceUsd,
            currentBalanceSol: balance.balanceSol, // Only populated for real trading
          }, request);
        } catch (err) {
          logger.error('Hybrid stats API error:', err);
          return jsonGzip({ error: 'Failed to fetch hybrid shadow stats' }, request, 500);
        }
      }
      
      if (url.pathname === '/api/hybrid/daily') {
        try {
          const { hybridShadowTracker } = await import('./services/hybrid-shadow-tracker');
          if (!hybridShadowTracker.isEnabled()) {
            return jsonGzip({ enabled: false, data: [] }, request);
          }
          const days = url.searchParams.get('days') ? parseInt(url.searchParams.get('days')!) : 7;
          const dailyStats = await hybridShadowTracker.getDailyStats(days);
          return jsonGzip({ enabled: true, data: dailyStats }, request);
        } catch (err) {
          logger.error('Hybrid daily stats API error:', err);
          return jsonGzip({ error: 'Failed to fetch hybrid daily stats' }, request, 500);
        }
      }
      
      if (url.pathname === '/api/hybrid/funnel') {
        try {
          const { hybridShadowTracker } = await import('./services/hybrid-shadow-tracker');
          if (!hybridShadowTracker.isEnabled()) {
            return jsonGzip({ enabled: false }, request);
          }
          const days = url.searchParams.get('days') ? parseInt(url.searchParams.get('days')!) : 7;
          const funnel = await hybridShadowTracker.getDecisionFunnel(days);
          return jsonGzip({ enabled: true, ...funnel }, request);
        } catch (err) {
          logger.error('Hybrid funnel API error:', err);
          return jsonGzip({ error: 'Failed to fetch hybrid decision funnel' }, request, 500);
        }
      }
      
      if (url.pathname === '/api/scans') {
        try {
          const days = url.searchParams.get('days') ? parseInt(url.searchParams.get('days')!, 10) : 7;
          const result = await query(`
            SELECT
              timestamp,
              tokens_found,
              tokens_analyzed,
              duration_ms,
              bot_tokens_breakdown
            FROM scans
            WHERE timestamp >= NOW() - ($1 || ' days')::INTERVAL
              AND chain = $2
            ORDER BY timestamp ASC
          `, [days, chainConfig.chain]);
          return jsonGzip({ data: result.rows }, request);
        } catch (err) {
          logger.error('Scans API error:', err);
          return jsonGzip({ error: 'Failed to fetch scans' }, request, 500);
        }
      }

      if (url.pathname === '/api/hybrid/trades') {
        try {
          const { hybridShadowTracker } = await import('./services/hybrid-shadow-tracker');
          if (!hybridShadowTracker.isEnabled()) {
            return jsonGzip({ enabled: false, data: [] }, request);
          }
          const days = url.searchParams.get('days') ? parseInt(url.searchParams.get('days')!) : 7;
          const trades = await hybridShadowTracker.getTrades(days);
          return jsonGzip({ enabled: true, data: trades }, request);
        } catch (err) {
          logger.error('Hybrid trades API error:', err);
          return jsonGzip({ error: 'Failed to fetch hybrid trades' }, request, 500);
        }
      }
      
      // Hybrid Analytics UI
      if (url.pathname === '/hybrid-analytics' || url.pathname === '/hybrid-analytics.html') {
        try {
          const possiblePaths = [
            './hybrid-analytics.html',
            '../hybrid-analytics.html',
            process.cwd() + '/hybrid-analytics.html',
            '/app/hybrid-analytics.html',
          ];
          
          let html: string | null = null;
          for (const path of possiblePaths) {
            try {
              const file = Bun.file(path);
              const text = await file.text();
              if (text && text.length > 0) {
                html = text;
                break;
              }
            } catch (e) {
              continue;
            }
          }
          
          if (html) {
            return new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            });
          }
          
          logger.warn('Hybrid analytics UI file not found in any of the expected paths');
          return new Response('Hybrid Analytics UI not found', { status: 404 });
        } catch (err) {
          logger.error('Failed to load hybrid analytics UI:', err);
          return new Response('Hybrid Analytics UI not found', { status: 404 });
        }
      }
      
      // Analytics UI
      if (url.pathname === '/analytics' || url.pathname === '/analytics.html') {
        try {
          // In Cloud Run, file is at /app/analytics.html (WORKDIR is /app)
          // Try multiple possible paths for different environments
          const possiblePaths = [
            './analytics.html',           // Current directory (Cloud Run: /app)
            '../analytics.html',          // Parent directory (local dev)
            process.cwd() + '/analytics.html',  // Explicit cwd
            '/app/analytics.html',        // Explicit Cloud Run path
          ];
          
          let html: string | null = null;
          for (const path of possiblePaths) {
            try {
              const file = Bun.file(path);
              const text = await file.text();
              if (text && text.length > 0) {
                html = text;
                break;
              }
            } catch (e) {
              continue;
            }
          }
          
          if (html) {
            return new Response(html, {
              headers: { 'Content-Type': 'text/html' },
            });
          }
          
          logger.warn('Analytics UI file not found in any of the expected paths');
          return new Response('Analytics UI not found', { status: 404 });
        } catch (err) {
          logger.error('Failed to load analytics UI:', err);
          return new Response('Analytics UI not found', { status: 404 });
        }
      }
      
      // Webhook endpoint
      if (url.pathname === secretPath) {
        try {
          return await callback(request as any);
        } catch (err) {
          logger.error('Webhook error:', err);
          return new Response('OK', { status: 200 }); // Always return 200 to Telegram
        }
      }
      
      return new Response('Not found', { status: 404 });
    },
  });
  
  // Set webhook with Telegram
  await bot.api.setWebhook(webhookUrl, { secret_token: WEBHOOK_SECRET_TOKEN });
  
  logger.success(`✅ Bot started in webhook mode`);
  logger.info(`🔗 Webhook URL: ${webhookUrl}`);
  logger.info(`🏥 Health check: ${BOT_WEBHOOK_HOST}/health`);
  logger.info(`📊 Analytics UI: ${BOT_WEBHOOK_HOST}/analytics`);
  logger.info(`👂 Listening on port ${PORT}`);
  
  // NOW start the monitor (after webhook is fully set up)
  const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
  const MONITOR_INTERVAL = parseInt(process.env.MONITOR_INTERVAL_MINUTES || '5');

  if (CHANNEL_ID && CHANNEL_ID.trim() !== '') {
    logger.info('📢 Channel monitoring enabled');
    logger.info('🤖 Using unified Trading Analyzer (1 AI call for all analysis)');
    
    monitor = new TokenMonitor(
      bot,
      CHANNEL_ID,
      MONITOR_INTERVAL
    );
    
    // Start monitoring
    monitor.start().catch(err => {
      logger.error('Failed to start monitor', err);
    });
  } else {
    logger.warn('⚠️  TELEGRAM_CHANNEL_ID not set - monitoring disabled');
    logger.info('   Set TELEGRAM_CHANNEL_ID in .env to enable auto-posting');
  }
  
} else {
  logger.error('❌ ENABLE_WEBHOOKS must be true and BOT_WEBHOOK_HOST must be set');
  logger.error('   This bot only supports webhook mode');
  process.exit(1);
}

