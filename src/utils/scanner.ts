/**
 * Hot Token Scanner
 * Unified interface for scanning hot tokens on multiple chains (BSC, Solana)
 */

import { createPublicClient, http, type TransactionReceipt } from 'viem';
import { bsc } from 'viem/chains';
import { CodexAPI } from '../infra/codex';
import { logger } from './logger';
import { Chain, getChainConfig } from '../config/chain';
import { SolanaScanner, type SolanaScanResult, type SolanaToken } from '../services/solana/scanner';
import { rpcRequestTracker, extractHttpStatusFromError } from './rpc-request-tracker';

// Trading bot routers on BSC
const BOT_ROUTERS = new Map<string, string>([
  ['0x013bb8a204499523ddf717e0abaa14e6dc849060', 'Maestro'],
  ['0x3328f7f4a1d1c57c35df56bbf0c9dcafca309c49', 'Maestro V2'],
  ['0x51c72848c68a965f66fa7a88855f9f7784502a7f', 'BonkBot'],
  ['0xaaaaaaaaaac9630b35e6d485f57abd93ad3d2930', 'Axios'],
  ['0x75ff870a864b59f03ff3e67a65ef44dea64f0caf', 'Sigma'],
  ['0xb1000058c87d843fc0154591ff9d72af5e7213d5', 'Bloom'],
  //['0x461efe0100be0682545972ebfc8b4a13253bd602', 'BananaGun'],
  //['0xb300000b72deaeb607a12d5f54773d1c19c7028d', 'Binance'],
]);

// Make configurable via env for easier tuning on Cloud Run
const BLOCKS_TO_SCAN = parseInt(process.env.BLOCKS_TO_SCAN || '300', 10);
const TRANSFER_EVENT = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const IGNORE_TOKENS = new Set([
  // Wrapped BNB
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
  
  // Stablecoins
  '0x55d398326f99059ff775485246999027b3197955', // USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
  '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', // DAI
  '0x8965349fb649a33a30cbfda057d8ec2c48abe2a2', // USDD
  '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', // USD1
  
  // Major tokens (too established, not "hot" anymore)
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8', // ETH
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', // BTCB (Bitcoin)
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', // CAKE
  
  // Other common base tokens
  '0x4338665cbb7b2485a8855a139b75d5e34ab0db94', // LTC
  '0xba2ae424d960c26247dd6c32edc70b295c744c43', // DOGE
]);

import type { CodexBSCTokenData } from '../infra/codex';

export interface TokenStats {
  token: string;
  buys: number;
  sells: number;
  netBuys: number;
  users: Set<string>;
  bots: Set<string>;
  totalActivity: number;
  botActivity: Map<string, { buys: number; sells: number }>; // Per-bot buy/sell counts
  pairCreatedAt?: number; // timestamp in milliseconds (Solana only)
  // Pool metadata (Solana only) — used by security scanner for on-chain pool reads
  dexId?: string;
  pairAddress?: string;
  quoteToken?: string;
  // Smart money metrics (Solana only, NULL when no smart money activity)
  smartMoneyWalletCount?: number | null;
  smartMoneyWalletAddresses?: string[] | null;
  smartMoneyBuyCount?: number | null;
  smartMoneyBuyPercentage?: number | null;
  smartMoneyConvictionScore?: number | null;
}

export interface ScanResult {
  totalTrades: number;
  uniqueUsers: number;
  topTokens: TokenStats[];
  botBreakdown: Map<string, number>; // Transaction counts per bot
  botTokensBreakdown: Map<string, number>; // Unique tokens per bot
  tokenMetadata: Map<string, CodexBSCTokenData>;
}

/**
 * Unified scan function that automatically selects the correct scanner based on chain config
 */
export async function scanHotTokens(): Promise<ScanResult> {
  const chainConfig = getChainConfig();
  
  if (chainConfig.chain === Chain.SOLANA) {
    return await scanHotTokensSolana();
  } else {
    return await scanHotTokensBSC();
  }
}

/**
 * Solana-specific scanner
 */
async function scanHotTokensSolana(): Promise<ScanResult> {
  const startTime = Date.now();
  logger.scanStart();
  
  const chainConfig = getChainConfig();
  const scanner = new SolanaScanner(chainConfig.rpcUrl, {
    scanLimit: parseInt(process.env.SOLANA_SCAN_LIMIT || '300', 10),
    concurrency: parseInt(process.env.SOLANA_CONCURRENCY || '5', 10),
    filterBondingCurve: process.env.SOLANA_FILTER_BONDING_CURVE !== 'false',
  });
  
  const solanaScanResult: SolanaScanResult = await scanner.scanRecentActivity();
  
  // Convert SolanaToken[] to TokenStats[] for unified interface
  const topTokens: TokenStats[] = solanaScanResult.hotTokens.map((solToken: SolanaToken) => ({
    token: solToken.address,
    buys: solToken.buys,
    sells: solToken.sells,
    netBuys: solToken.netBuys,
    users: solToken.uniqueUsers,
    bots: solToken.bots,
    totalActivity: solToken.buys + solToken.sells,
    botActivity: solToken.botActivity,
    pairCreatedAt: solToken.pairCreatedAt, // Pass through for security analysis
    // Pass through pool metadata — needed by security scanner for on-chain pool reads
    dexId: solToken.dexId,
    pairAddress: solToken.pairAddress,
    quoteToken: solToken.quoteToken,
    // Pass through smart money metrics
    smartMoneyWalletCount: solToken.smartMoneyWalletCount,
    smartMoneyWalletAddresses: solToken.smartMoneyWalletAddresses,
    smartMoneyBuyCount: solToken.smartMoneyBuyCount,
    smartMoneyBuyPercentage: solToken.smartMoneyBuyPercentage,
    smartMoneyConvictionScore: solToken.smartMoneyConvictionScore,
  }));
  
  // Fetch Codex metadata for Solana tokens (price, market cap, volume, candles)
  const tokenMetadata = new Map<string, any>();
  
  const codexApiKey = process.env.CODEX_API_KEY;
  if (codexApiKey) {
    try {
      const codexApi = new CodexAPI(codexApiKey);
      const tokenAddresses = topTokens.map(t => t.token);
      
      logger.debug('Fetching Codex metadata', { tokenCount: tokenAddresses.length, tokens: tokenAddresses });
      
      const metadata = await codexApi.getTokenDataBatch(tokenAddresses);
      
      metadata.forEach((data, address) => {
        tokenMetadata.set(address, data);
      });
      
      logger.codexFetch(tokenAddresses.length, metadata.size);
      
      if (metadata.size > 0) {
        logger.debug('Codex metadata sample', {
          sample: Array.from(metadata.entries()).slice(0, 2).map(([addr, data]) => ({
            address: addr,
            name: data.name,
            symbol: data.symbol,
            price: data.priceUSD,
          }))
        });
      }
    } catch (error) {
      logger.error('Error fetching Codex metadata', error);
    }
  } else {
    logger.warn('No CODEX_API_KEY - skipping Solana metadata fetch');
    
    // Fallback: create minimal metadata from scanner data
    solanaScanResult.hotTokens.forEach((solToken: SolanaToken) => {
      tokenMetadata.set(solToken.address, {
        address: solToken.address,
        name: solToken.name || 'Unknown',
        symbol: solToken.symbol || 'Unknown',
        decimals: solToken.decimals || 9,
        priceUSD: 0,
        marketCap: 0,
        liquidity: solToken.liquidityUsd || 0,
        volume24h: 0,
        priceChange24h: 0,
        holders: 0,
      });
    });
  }
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.scanComplete(solanaScanResult.totalTrades, topTokens.length, parseFloat(duration));
  
  // Convert Record to Map for consistency with BSC scanner
  const botBreakdownMap = new Map<string, number>();
  Object.entries(solanaScanResult.botBreakdown).forEach(([key, value]) => {
    botBreakdownMap.set(key, value);
  });
  
  const botTokensBreakdownMap = new Map<string, number>();
  Object.entries(solanaScanResult.botTokensBreakdown).forEach(([key, value]) => {
    botTokensBreakdownMap.set(key, value);
  });

  return {
    totalTrades: solanaScanResult.totalTrades,
    uniqueUsers: solanaScanResult.uniqueUsers,
    topTokens,
    botBreakdown: botBreakdownMap,
    botTokensBreakdown: botTokensBreakdownMap,
    tokenMetadata,
  };
}

/**
 * BSC-specific scanner (original implementation)
 */
async function scanHotTokensBSC(): Promise<ScanResult> {
  const startTime = Date.now();
  logger.scanStart();
  
  const RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org';
  
  const client = createPublicClient({
    chain: bsc,
    transport: http(RPC_URL, {
      timeout: 30000,        // 30 second timeout per request
      retryCount: 2,         // Retry failed requests 2 times
      retryDelay: 1000,      // 1 second between retries
    }),
  });

  logger.info('⏳ Fetching latest block number...');
  const latestBlock = await client.getBlockNumber();
  rpcRequestTracker.logRequest('getBlockNumber', { chain: 'bsc', success: true });
  logger.success(`✅ Got latest block: ${latestBlock}`);
  
  const startBlock = latestBlock - BigInt(BLOCKS_TO_SCAN);
  
  logger.debug('Scan parameters', {
    latestBlock: latestBlock.toString(),
    startBlock: startBlock.toString(),
    blocksToScan: BLOCKS_TO_SCAN,
    rpcUrl: RPC_URL.substring(0, 30) + '...',
  });
  
  const routerMap = new Map<string, string>();
  BOT_ROUTERS.forEach((botName, address) => {
    routerMap.set(address.toLowerCase(), botName);
  });

  const trades: Array<{ hash: string; user: string; bot: string }> = [];
  const botBreakdown = new Map<string, number>(); // Will count unique tokens per bot
  const botTokens = new Map<string, Set<string>>(); // Track unique tokens per bot

  // Scan blocks for bot trades
  const totalBlocksToScan = Number(latestBlock - startBlock);
  let blocksScanned = 0;
  let lastLoggedPercent = 0;
  
  for (let bn = latestBlock; bn >= startBlock; bn--) {
    try {
      const block = await client.getBlock({ blockNumber: bn, includeTransactions: true });
      rpcRequestTracker.logRequest('getBlock', { chain: 'bsc', blockNumber: bn, success: true });
      
      for (const tx of block.transactions ?? []) {
        const to = (tx as any).to as string | null;
        
        if (to) {
          const toLower = to.toLowerCase();
          const botName = routerMap.get(toLower);
          
          if (botName) {
            const from = (tx as any).from as string;
            
            trades.push({
              hash: (tx as any).hash as string,
              user: from,
              bot: botName,
            });
            
            // Note: botBreakdown will be calculated later from unique tokens per bot
          }
        }
      }
      
      // Log progress every 10%
      blocksScanned++;
      const progressPercent = Math.floor((blocksScanned / totalBlocksToScan) * 100);
      if (progressPercent >= lastLoggedPercent + 10 && progressPercent <= 100) {
        logger.info(`📊 Block scan progress: ${progressPercent}% (${blocksScanned}/${totalBlocksToScan} blocks, ${trades.length} bot trades found)`);
        lastLoggedPercent = progressPercent;
      }
      
    } catch (error) {
      const { statusCode, errorType } = extractHttpStatusFromError(error);
      rpcRequestTracker.logRequest('getBlock', { chain: 'bsc', blockNumber: bn, success: false, statusCode, errorType });
      continue;
    }
  }

  // Analyze trades to find token buys
  const tokenStats = new Map<string, { buys: number; sells: number; users: Set<string>; bots: Set<string>; botActivity: Map<string, { buys: number; sells: number }> }>();
  
  logger.debug('Starting trade analysis', { totalTrades: trades.length });

  for (const trade of trades) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: trade.hash as `0x${string}` });
      rpcRequestTracker.logRequest('getTransactionReceipt', { chain: 'bsc', success: true });
      const transfers = parseTransferEvents(receipt, trade.user);

      const tokensSent = new Set(
        transfers.filter(t => t.from.toLowerCase() === trade.user.toLowerCase()).map(t => t.token)
      );
      const tokensReceived = new Set(
        transfers.filter(t => t.to.toLowerCase() === trade.user.toLowerCase()).map(t => t.token)
      );

      // Process BUYs: tokens received that weren't also sent
      for (const token of tokensReceived) {
        if (IGNORE_TOKENS.has(token)) continue;
        
        const isBuy = !tokensSent.has(token);
        if (!isBuy) continue; // Skip if also sent (not a pure buy)
        
        if (!tokenStats.has(token)) {
          tokenStats.set(token, { buys: 0, sells: 0, users: new Set(), bots: new Set(), botActivity: new Map() });
        }
        
        const stats = tokenStats.get(token)!;
        stats.buys++;
        stats.users.add(trade.user.toLowerCase());
        stats.bots.add(trade.bot);
        
        // Track unique tokens per bot
        if (!botTokens.has(trade.bot)) {
          botTokens.set(trade.bot, new Set());
        }
        botTokens.get(trade.bot)!.add(token);
        
        // Track per-bot activity
        if (!stats.botActivity.has(trade.bot)) {
          stats.botActivity.set(trade.bot, { buys: 0, sells: 0 });
        }
        stats.botActivity.get(trade.bot)!.buys++;
        
        /*
        logger.debug('Detected BUY', {
          token,
          user: trade.user.substring(0, 10) + '...',
          bot: trade.bot,
          hash: trade.hash.substring(0, 10) + '...',
          totalBuys: stats.buys,
          uniqueUsers: stats.users.size,
        });
        */
      }
      
      // Process SELLS: tokens sent that weren't also received
      for (const token of tokensSent) {
        if (IGNORE_TOKENS.has(token)) continue;
        
        const isSell = !tokensReceived.has(token);
        if (!isSell) continue; // Skip if also received (not a pure sell)
        
        if (!tokenStats.has(token)) {
          tokenStats.set(token, { buys: 0, sells: 0, users: new Set(), bots: new Set(), botActivity: new Map() });
        }
        
        const stats = tokenStats.get(token)!;
        stats.sells++;
        stats.users.add(trade.user.toLowerCase());
        stats.bots.add(trade.bot);
        
        // Track unique tokens per bot (for sells too)
        if (!botTokens.has(trade.bot)) {
          botTokens.set(trade.bot, new Set());
        }
        botTokens.get(trade.bot)!.add(token);
        
        // Track per-bot activity
        if (!stats.botActivity.has(trade.bot)) {
          stats.botActivity.set(trade.bot, { buys: 0, sells: 0 });
        }
        stats.botActivity.get(trade.bot)!.sells++;
      }
    } catch (error) {
      const { statusCode, errorType } = extractHttpStatusFromError(error);
      rpcRequestTracker.logRequest('getTransactionReceipt', { chain: 'bsc', success: false, statusCode, errorType });
      continue;
    }
  }

  // Convert to sorted array
  const topTokens: TokenStats[] = Array.from(tokenStats.entries())
    .map(([token, stats]) => ({
      token,
      buys: stats.buys,
      sells: stats.sells,
      netBuys: stats.buys - stats.sells,
      users: stats.users,
      bots: stats.bots,
      totalActivity: stats.buys + stats.sells,
      botActivity: stats.botActivity,
    }))
    .filter(token => {
      // Lightweight pre-filter to reduce false positives
      // Stage 1: Remove obvious garbage before expensive security scans
      
      // Filter 1: Minimum activity (loose threshold)
      if (token.totalActivity < 3) return false; // At least 3 trades (catches early trends)
      
      // Filter 2: Multiple users (not just one person)
      if (token.users.size < 2) return false; // At least 2 users
      
      // Filter 3: Honeypot indicator (must have at least 1 sell)
      // Exception: If very new (< 5 buys), allow 0 sells
      if (token.sells === 0 && token.buys >= 5) return false; // 5+ buys, 0 sells = likely honeypot
      
      return true;
    })
    .sort((a, b) => b.totalActivity - a.totalActivity)
    .slice(0, 10); // Pick top 10 for security analysis

  // Fetch token metadata from Codex
  const tokenMetadata = new Map();
  
  const codexApiKey = process.env.CODEX_API_KEY;
  if (codexApiKey) {
    try {
      const codexApi = new CodexAPI(codexApiKey);
      const tokenAddresses = topTokens.map(t => t.token);
      
      logger.debug('Fetching Codex metadata', { tokenCount: tokenAddresses.length, tokens: tokenAddresses });
      
      const metadata = await codexApi.getTokenDataBatch(tokenAddresses);
      
      metadata.forEach((data, address) => {
        tokenMetadata.set(address, data);
      });
      
      logger.codexFetch(tokenAddresses.length, metadata.size);
      
      if (metadata.size > 0) {
        logger.debug('Codex metadata sample', {
          sample: Array.from(metadata.entries()).slice(0, 2).map(([addr, data]) => ({
            address: addr,
            name: data.name,
            symbol: data.symbol,
            price: data.priceUSD,
          }))
        });
      }
    } catch (error) {
      logger.error('Error fetching Codex metadata', error);
    }
  } else {
    logger.warn('No CODEX_API_KEY - skipping metadata fetch');
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.scanComplete(trades.length, topTokens.length, parseFloat(duration));
  
  // Convert botTokens Set sizes to botTokensBreakdown (unique tokens per bot)
  const botTokensBreakdown = new Map<string, number>();
  botTokens.forEach((tokenSet, botName) => {
    botTokensBreakdown.set(botName, tokenSet.size);
  });

  logger.debug('Scan results', {
    totalTrades: trades.length,
    uniqueUsers: new Set(trades.map(t => t.user)).size,
    topTokens: topTokens.slice(0, 3).map(t => ({ token: t.token, activity: t.totalActivity })),
    botBreakdown: Object.fromEntries(botBreakdown),
  });

  return {
    totalTrades: trades.length,
    uniqueUsers: new Set(trades.map(t => t.user)).size,
    topTokens,
    botBreakdown,
    botTokensBreakdown,
    tokenMetadata,
  };
}

/**
 * Helper function to parse ERC-20 transfer events from a transaction receipt
 */
function parseTransferEvents(receipt: TransactionReceipt, userAddress: string) {
  const transfers: Array<{ token: string; from: string; to: string }> = [];
  
  receipt.logs.forEach((log) => {
    if (log.topics[0] === TRANSFER_EVENT && log.topics.length >= 3) {
      const from = '0x' + (log.topics[1]?.slice(-40) ?? '');
      const to = '0x' + (log.topics[2]?.slice(-40) ?? '');
      const token = log.address.toLowerCase();
      
      transfers.push({ token, from, to });
    }
  });
  
  return transfers;
}
