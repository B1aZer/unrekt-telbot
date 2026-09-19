/**
 * Solana Token Scanner
 * 
 * Scans Solana trading bot fee accounts to find hot tokens
 * Monitors: Bonkbot, Maestro, Padre, Axiom, GMGN, Photon, Trojan
 * 
 * Strategy:
 * 1. Fetch recent transactions to bot fee accounts
 * 2. For each transaction, detect if it's a BUY (user receives tokens)
 * 3. Extract the token address
 * 4. Aggregate by token to find "hot" tokens with multiple buys
 * 
 * Note: This approach only tracks BUYS, not sells. Sells typically don't route
 * through bot fee accounts (they go direct to DEX or through Jito bundles),
 * so we focus on buy pressure as the primary signal for "hot" tokens.
 */

import { logger } from '../../utils/logger';
import {
  isSmartMoneyWallet, 
  getSmartMoneyTier, 
  getSmartMoneyWeight,
  loadSmartMoneyWallets,
  getAllSmartMoneyWallets
} from '../smart-money-loader';
import { rpcRequestTracker, extractHttpStatusFromError } from '../../utils/rpc-request-tracker';

// Known bot identifiers on Solana
// OPTIMIZED: Removed redundant patterns based on overlap analysis (see scripts/analyze-pattern-overlap.ts)
// - BONKBOT program: 96% overlap with fee account → REMOVED
// - MAESTRO program: 100% overlap with fee account → REMOVED
// - PHOTON program: 72% overlap → REMOVED (minor loss of 28% unique txs)
// - TROJAN bot address: 85% overlap → REMOVED (minor loss of 15% unique txs)
// - PADRE both: 0% overlap → KEPT (different fee accounts for different token types)
// - AXIOM both: 0% overlap → KEPT (completely different transactions)
const SOLANA_BOTS = {
  bonkbot: {
    patterns: [
      'ZG98FUCjb8mJ824Gbs6RsgVmr1FhXb2oNiJHa2dwmPd', // fee account (96% overlap with program - only need one)
      // 'CxvksNjwhdHDLr3qbCXNKVdeYACW8cs93vFqLqtgyFE5', // program - REMOVED: 96% overlap
    ],
  },
  maestro: {
    patterns: [
      'MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36', // fee account (100% overlap with program - only need one)
      // 'MaestroAAe9ge5HTc64VbBQZ6fP77pwvrhM8i1XWSAx', // program - REMOVED: 100% overlap
    ],
  },
  padre: {
    patterns: [
      'Z4BMozEdiqTGdzzXkKUURjhfbCGF9Fs3KyTxhfi2bZe', // fee account - 0% overlap, KEEP
      '3bhBmTtvhAN7A7gEBpgP9aG7SJ4KoToMthaxMry4yVa4', // aggregator fee account (for pumpfun tokens) - 0% overlap, KEEP
    ],
  },
  axiom: {
    patterns: [
      'C3P1pBs4tvWxBjcrwDu5m6v5AQPVLrL3X2M5qCTFZgjp', // fee account - 0% overlap, KEEP
      'FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9', // program - 0% overlap, KEEP
    ],
  },
  gmgn: {
    patterns: [
      'GMgnVFR8Jb39LoXsEVzb3DvBy3ywCmdmJquHUy1Lrkqb', // fee account (only pattern)
    ],
  },
  photon: {
    patterns: [
      'AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH', // fee account (72% overlap with program - minor loss of 28% unique)
      // 'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW', // program - REMOVED: 72% overlap
    ],
  },
  trojan: {
    patterns: [
      '9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco', // fee account (85% overlap with bot address - minor loss of 15% unique)
      // 'troY36YiPGqMyAYCNbEqYCdN2tb91Zf7bHcQt7KUi61', // bot address - REMOVED: 85% overlap
    ],
  },
};

// Ignored tokens (WSOL, USDC, etc.)
const IGNORE_TOKENS = new Set([
  'So11111111111111111111111111111111111111112', // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
]);

export interface TokenActivity {
  address: string;
  buyCount: number;
  totalVolume: number;
  uniqueBuyers: Set<string>;
  lastBuyTimestamp: number;
  recentBuys: {
    signature: string;
    buyer: string;
    amount: number;
    timestamp: number;
    botType: string;
    isSmartMoney?: boolean;
    smartMoneyTier?: 1 | 2 | 3;
  }[];
  // Bot activity breakdown
  botActivity: Map<string, number>; // botType -> count
  // Smart money tracking
  smartMoneyWallets: Set<string>;  // Unique smart money wallets that bought
  smartMoneyBuyCount: number;      // Total buys from smart money
  smartMoneyBuys: Array<{
    buyer: string; // Changed from 'wallet'
    amount: number;
    timestamp: number; // milliseconds
    tier: 1 | 2 | 3;
  }>;
  // DexScreener metadata (checked after scanning)
  hasLiquidity?: boolean;
  dexId?: string;
  liquidityUsd?: number;
  pairAddress?: string;
  quoteToken?: string;
  pairCreatedAt?: number; // timestamp in milliseconds
}

export interface SolanaToken {
  address: string;
  mint: string;
  symbol: string;
  name: string;
  decimals?: number;
  
  // Activity metrics (BUY-ONLY - sells not tracked via bot fee accounts)
  buys: number;
  sells: number;  // Always 0 - not tracked in current implementation
  netBuys: number;  // Same as buys since sells = 0
  volume: number;
  uniqueUsers: Set<string>;
  
  // Bot info
  bots: Set<string>;
  botActivity: Map<string, { buys: number; sells: number }>;
  
  // Pool info
  poolAddress?: string;
  quoteMint?: string; // Usually SOL or USDC
  
  // DexScreener metadata
  hasLiquidity?: boolean;
  dexId?: string;
  liquidityUsd?: number;
  pairAddress?: string;
  quoteToken?: string;
  pairCreatedAt?: number; // timestamp in milliseconds (from DexScreener)
  
  // Smart money metrics (NULL when no smart money activity, to distinguish from 0)
  smartMoneyWalletCount?: number | null;
  smartMoneyWalletAddresses?: string[] | null;
  smartMoneyBuyCount?: number | null;
  smartMoneyBuyPercentage?: number | null;
  smartMoneyConvictionScore?: number | null;
}

export interface SolanaScanResult {
  hotTokens: SolanaToken[];
  totalTrades: number;
  uniqueUsers: number;
  botBreakdown: Record<string, number>; // Plain object instead of Map
  botTokensBreakdown: Record<string, number>; // Plain object instead of Map
  timestamp: number;
  error?: string;
}

export class SolanaScanner {
  private rpcUrl: string;
  private scanLimit: number;
  private concurrency: number;
  private filterBondingCurve: boolean;
  private walletsInitialized: boolean = false;
  
  constructor(rpcUrl: string, options?: {
    scanLimit?: number;
    concurrency?: number;
    filterBondingCurve?: boolean;
  }) {
    this.rpcUrl = rpcUrl;
    this.scanLimit = options?.scanLimit || 300;
    this.concurrency = options?.concurrency || 5;
    this.filterBondingCurve = options?.filterBondingCurve !== false; // Default: true
    logger.info('🔷 Solana Scanner initialized');
    logger.info(`   - Scan Limit: ${this.scanLimit} tx per bot`);
    logger.info(`   - Concurrency: ${this.concurrency} parallel requests`);
    logger.info(`   - Filter Bonding Curve: ${this.filterBondingCurve}`);
  }
  
  /**
   * Scan recent Solana transactions for hot tokens
   */
  async scanRecentActivity(): Promise<SolanaScanResult> {
    const startTime = Date.now();
    logger.info('🔍 [Solana] Starting scan...');
    
    // Reload wallets from database before each scan (fast, ~few ms)
    await loadSmartMoneyWallets();
    
    if (!this.walletsInitialized) {
      this.walletsInitialized = true;
      const wallets = getAllSmartMoneyWallets();
      logger.info(`✅ Smart money: ${wallets.length} wallets loaded`);
    }
    
    const tokenActivity = new Map<string, TokenActivity>();
    let totalProcessed = 0;
    let totalBuys = 0;
    const botBreakdown = new Map<string, number>(); // Transaction counts per bot
    const botTokens = new Map<string, Set<string>>(); // Track unique tokens per bot

    for (const [botName, botInfo] of Object.entries(SOLANA_BOTS)) {
      logger.info(`🤖 [Solana] Scanning ${botName.toUpperCase()}...`);
      logger.info(`   Patterns: ${botInfo.patterns.join(', ')}`);

      try {
        // Scan all patterns for this bot and combine results
        const allSignatures = new Map<string, any>(); // Use Map to deduplicate by signature
        for (const pattern of botInfo.patterns) {
          // OPTIMIZATION: Use reduced limit if configured (defaults to scanLimit)
          const effectiveLimit = parseInt(process.env.SOLANA_PATTERN_SCAN_LIMIT || String(this.scanLimit), 10);
          const signatures = await this.fetchRecentTransactions(pattern, effectiveLimit);
          logger.info(`   ✅ Pattern ${pattern}: Found ${signatures.length} recent transactions (limit: ${effectiveLimit})`);
          
          // Add to map (deduplicates by signature)
          for (const sig of signatures) {
            allSignatures.set(sig.signature, sig);
          }
        }
        
        const signatures = Array.from(allSignatures.values());
        logger.info(`   ✅ Total unique transactions: ${signatures.length}`);
        
        // Filter to only last scan interval to avoid duplicate processing
        // Scanner runs every MONITOR_INTERVAL_MINUTES, so only process txs from that window
        const scanIntervalMinutes = parseInt(process.env.MONITOR_INTERVAL_MINUTES || '10', 10);
        const now = Date.now() / 1000; // Unix timestamp in seconds
        const timeWindowAgo = now - (scanIntervalMinutes * 60);
        const recentSignatures = signatures.filter((sig: any) => {
          return sig.blockTime && sig.blockTime >= timeWindowAgo;
        });
        
        logger.info(`   ⏰ Filtered to ${recentSignatures.length} transactions from last ${scanIntervalMinutes} minutes`);
        
        if (recentSignatures.length === 0) {
          logger.info(`   ⏭️  No transactions in last ${scanIntervalMinutes} minutes, skipping bot`);
          continue;
        }
        
        logger.info(`   ⚡ Fetching with ${this.concurrency} parallel requests...`);

        // Fetch all transactions in parallel with concurrency control
        const transactions = await this.fetchTransactionsParallel(
          recentSignatures.map((sig: any) => sig.signature),
          this.concurrency
        );

        let buysFound = 0;

        // Process each transaction
        for (let i = 0; i < transactions.length; i++) {
          const tx = transactions[i];
          const sig = recentSignatures[i]; // ✅ Fixed: Use recentSignatures instead of signatures
          
          totalProcessed++;

          if (!tx) continue; // Skip if transaction fetch failed

          const buy = this.extractTokenBuy(tx);
          
          if (buy) {
            buysFound++;
            totalBuys++;
            
            // Track transaction counts per bot
            botBreakdown.set(buy.botType, (botBreakdown.get(buy.botType) || 0) + 1);
            
            // Track unique tokens per bot
            if (!botTokens.has(buy.botType)) {
              botTokens.set(buy.botType, new Set());
            }
            botTokens.get(buy.botType)!.add(buy.tokenAddress);
            
            if (!tokenActivity.has(buy.tokenAddress)) {
              tokenActivity.set(buy.tokenAddress, {
                address: buy.tokenAddress,
                buyCount: 0,
                totalVolume: 0,
                uniqueBuyers: new Set(),
                lastBuyTimestamp: 0,
                recentBuys: [],
                botActivity: new Map(),
                smartMoneyWallets: new Set(),
                smartMoneyBuyCount: 0,
                smartMoneyBuys: []
              });
            }
            
            const activity = tokenActivity.get(buy.tokenAddress)!;
            activity.buyCount++;
            activity.totalVolume += buy.amount;
            activity.uniqueBuyers.add(buy.buyer);
            // Normalize all timestamps to milliseconds
            const timestampMs = (sig.blockTime || 0) * 1000;
            activity.lastBuyTimestamp = Math.max(activity.lastBuyTimestamp, timestampMs);
            activity.recentBuys.push({
              signature: sig.signature,
              buyer: buy.buyer,
              amount: buy.amount,
              timestamp: timestampMs, // Store in milliseconds
              botType: buy.botType,
              isSmartMoney: buy.isSmartMoney,
              smartMoneyTier: buy.smartMoneyTier
            });
            
            // Track smart money activity
            if (buy.isSmartMoney && buy.smartMoneyTier) {
              activity.smartMoneyWallets.add(buy.buyer);
              activity.smartMoneyBuyCount++;
              activity.smartMoneyBuys.push({
                buyer: buy.buyer, // Changed from 'wallet' to 'buyer' to match interface
                amount: buy.amount,
                timestamp: timestampMs, // Already normalized to milliseconds
                tier: buy.smartMoneyTier
              });
              logger.debug(`💰 Smart money buy detected: ${buy.buyer.substring(0, 16)}... (T${buy.smartMoneyTier}) bought ${buy.tokenAddress.substring(0, 16)}...`);
            } else if (process.env.DEBUG_SMART_MONEY === 'true') {
              // Log when a buy is NOT from smart money (for debugging)
              logger.debug(`   [Non-SM Buy] ${buy.buyer.substring(0, 16)}... bought ${buy.tokenAddress.substring(0, 16)}... (not smart money)`);
            }
            
            // Track bot activity
            activity.botActivity.set(
              buy.botType, 
              (activity.botActivity.get(buy.botType) || 0) + 1
            );
          }
        }

        logger.info(`   ✅ Processed ${recentSignatures.length} transactions, found ${buysFound} token buys`);
        
      } catch (error: any) {
        logger.error(`   ❌ Error scanning ${botName}: ${error.message}`);
      }
    }

    // Convert botTokens Set sizes to botTokensBreakdown (unique tokens per bot)
    const botTokensBreakdown = new Map<string, number>();
    botTokens.forEach((tokenSet, botName) => {
      botTokensBreakdown.set(botName, tokenSet.size);
    });

    // Sort by buy count (hottest tokens first)
    const MIN_BUYS = parseInt(process.env.SOLANA_MIN_BUYS || '3');
    const sortedTokens = Array.from(tokenActivity.values())
      .filter(t => t.buyCount >= MIN_BUYS)
      .sort((a, b) => b.buyCount - a.buyCount);

    if (sortedTokens.length === 0) {
      logger.info(`⚠️  No tokens found with ${MIN_BUYS}+ buys`);
      return {
        hotTokens: [],
        totalTrades: totalBuys,
        uniqueUsers: 0,
        botBreakdown: Object.fromEntries(botBreakdown),
        botTokensBreakdown: Object.fromEntries(botTokensBreakdown),
        timestamp: Date.now(),
      };
    }

    // Gather all token data in parallel: DexScreener + Smart Money scanning
    logger.info(`🔍 [Solana] Gathering token data (DexScreener + Smart Money) for ${sortedTokens.length} tokens...`);
    const scanIntervalMinutes = parseInt(process.env.MONITOR_INTERVAL_MINUTES || '10', 10);
    
    // OPTIMIZATION: Make direct smart money scanning optional and use lower limit
    const enableDirectSmartMoney = process.env.SOLANA_ENABLE_DIRECT_SMART_MONEY !== 'false'; // Default: true
    // Use much lower limit for direct scanning (200 instead of 700) to save RPC calls
    // Most smart money buys happen early, so we don't need to scan all 700 transactions
    const directSmartMoneyLimit = parseInt(process.env.SOLANA_DIRECT_SMART_MONEY_LIMIT || '200', 10);
    
    // Run DexScreener and Smart Money scanning in parallel for each token
    const dataGatheringPromises = sortedTokens.map(async (token) => {
      // Run both in parallel for each token
      const promises: Promise<any>[] = [
        this.checkDexScreener(token.address),
      ];
      
      // Only scan for direct smart money if enabled
      if (enableDirectSmartMoney) {
        promises.push(
          this.scanTokenForDirectSmartMoneyBuys(token, scanIntervalMinutes, directSmartMoneyLimit)
        );
      }
      
      const results = await Promise.all(promises);
      const dexInfo = results[0];
      
      // Update token with DexScreener data
      token.dexId = dexInfo.dexId;
      token.hasLiquidity = dexInfo.hasLiquidity;
      token.liquidityUsd = dexInfo.liquidityUsd !== null ? dexInfo.liquidityUsd : undefined;
      token.pairAddress = dexInfo.pairAddress || undefined;
      token.quoteToken = dexInfo.quoteToken || undefined;
      token.pairCreatedAt = dexInfo.pairCreatedAt || undefined;
    });
    
    // Wait for all data gathering to complete
    await Promise.all(dataGatheringPromises);
    logger.info(`✅ Token data gathering complete`);

    // Filter out bonding curve tokens if enabled
    let filteredTokens = sortedTokens;
    if (this.filterBondingCurve) {
      const beforeFilterCount = sortedTokens.length;
      filteredTokens = sortedTokens.filter(token => {
        // Filter out pump.fun tokens (bonding curve without LP)
        const isPumpfun = token.dexId === 'pumpfun';
        // Also filter out tokens without liquidity data (likely bonding curve or very new)
        const noLiquidity = !token.hasLiquidity && token.liquidityUsd === undefined;
        
        return !(isPumpfun || noLiquidity);
      });
      
      const filteredCount = beforeFilterCount - filteredTokens.length;
      if (filteredCount > 0) {
        logger.info(`Filtered out ${filteredCount} bonding curve token(s) (${beforeFilterCount} -> ${filteredTokens.length})`);
      }
    }

    // Convert to SolanaToken format
    const hotTokens: SolanaToken[] = filteredTokens.map(activity => {
      // Calculate smart money metrics
      const smartMoneyMetrics = this.calculateSmartMoneyMetrics(activity);
      
      // Log smart money metrics if found
      if (smartMoneyMetrics && smartMoneyMetrics.walletCount && smartMoneyMetrics.walletCount > 0) {
        logger.info(`📊 [Smart Money] Calculated metrics for ${activity.address.substring(0, 16)}...:`);
        logger.info(`   - walletCount: ${smartMoneyMetrics.walletCount}`);
        logger.info(`   - walletAddresses: ${smartMoneyMetrics.walletAddresses?.length || 0} addresses`);
        logger.info(`   - buyCount: ${smartMoneyMetrics.buyCount || 0}`);
        logger.info(`   - buyPercentage: ${smartMoneyMetrics.buyPercentage?.toFixed(2) || 'null'}%`);
        logger.info(`   - convictionScore: ${smartMoneyMetrics.convictionScore || 0}`);
      }
      
      return {
        address: activity.address,
        mint: activity.address,
        symbol: 'Unknown', // Will be enriched later
        name: 'Unknown', // Will be enriched later
        buys: activity.buyCount,
        sells: 0, // Not tracked in current implementation
        netBuys: activity.buyCount,
        volume: activity.totalVolume,
        uniqueUsers: activity.uniqueBuyers,
        bots: new Set(activity.botActivity.keys()),
        botActivity: new Map(
          Array.from(activity.botActivity.entries()).map(([bot, count]) => [bot, { buys: count, sells: 0 }])
        ),
        hasLiquidity: activity.hasLiquidity,
        dexId: activity.dexId,
        liquidityUsd: activity.liquidityUsd,
        pairAddress: activity.pairAddress,
        quoteToken: activity.quoteToken,
        pairCreatedAt: activity.pairCreatedAt,
        // Smart money metrics
        smartMoneyWalletCount: smartMoneyMetrics.walletCount,
        smartMoneyWalletAddresses: smartMoneyMetrics.walletAddresses,
        smartMoneyBuyCount: smartMoneyMetrics.buyCount,
        smartMoneyBuyPercentage: smartMoneyMetrics.buyPercentage,
        smartMoneyConvictionScore: smartMoneyMetrics.convictionScore,
      };
    });

    // Count tokens with smart money
    const tokensWithSmartMoney = hotTokens.filter(t => t.smartMoneyWalletCount && t.smartMoneyWalletCount > 0);
    const totalSmartMoneyWallets = tokensWithSmartMoney.reduce((sum, t) => sum + (t.smartMoneyWalletCount || 0), 0);
    const totalSmartMoneyBuys = tokensWithSmartMoney.reduce((sum, t) => sum + (t.smartMoneyBuyCount || 0), 0);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`✅ [Solana] Scan complete in ${duration}s`);
    logger.info(`   - Processed: ${totalProcessed} transactions`);
    logger.info(`   - Total Buys: ${totalBuys}`);
    logger.info(`   - Hot Tokens: ${hotTokens.length}`);
    if (tokensWithSmartMoney.length > 0) {
      logger.info(`   - Tokens with Smart Money: ${tokensWithSmartMoney.length} (${totalSmartMoneyWallets} unique wallets, ${totalSmartMoneyBuys} total buys)`);
    }

    return {
      hotTokens,
      totalTrades: totalBuys,
      uniqueUsers: new Set(sortedTokens.flatMap(t => Array.from(t.uniqueBuyers))).size,
      botBreakdown: Object.fromEntries(botBreakdown), // Convert Map to plain object
      botTokensBreakdown: Object.fromEntries(botTokensBreakdown), // Convert Map to plain object
      timestamp: Date.now(),
    };
  }

  private async fetchRecentTransactions(account: string, limit: number): Promise<any[]> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'get-signatures',
          method: 'getSignaturesForAddress',
          params: [
            account,
            {
              limit,
              commitment: 'confirmed'
            }
          ]
        })
      });

      const httpStatus = response.status;
      const data: any = await response.json();

      if (!response.ok || !data || data.error) {
        rpcRequestTracker.logRequest('getSignaturesForAddress', {
          chain: 'solana',
          success: false,
          statusCode: httpStatus,
          errorType: !response.ok ? `http_${httpStatus}` : 'rpc_error',
        });
        throw new Error(`RPC error (HTTP ${httpStatus}): ${JSON.stringify(data?.error ?? 'empty response')}`);
      }

      rpcRequestTracker.logRequest('getSignaturesForAddress', {
        chain: 'solana',
        success: true,
        statusCode: httpStatus,
      });
      return data.result || [];
    } catch (error) {
      const { statusCode, errorType } = extractHttpStatusFromError(error);
      rpcRequestTracker.logRequest('other', { chain: 'solana', success: false, statusCode, errorType });
      throw error;
    }
  }

  private async fetchTransaction(signature: string): Promise<any> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'get-tx',
          method: 'getTransaction',
          params: [
            signature,
            {
              encoding: 'jsonParsed',
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed'
            }
          ]
        })
      });

      const httpStatus = response.status;
      const data: any = await response.json();

      if (!response.ok || !data || data.error) {
        rpcRequestTracker.logRequest('getTransaction', {
          chain: 'solana',
          success: false,
          statusCode: httpStatus,
          errorType: !response.ok ? `http_${httpStatus}` : 'rpc_error',
        });
        throw new Error(`RPC error (HTTP ${httpStatus}): ${JSON.stringify(data?.error ?? 'empty response')}`);
      }

      rpcRequestTracker.logRequest('getTransaction', {
        chain: 'solana',
        success: true,
        statusCode: httpStatus,
      });
      return data.result;
    } catch (error) {
      const { statusCode, errorType } = extractHttpStatusFromError(error);
      rpcRequestTracker.logRequest('getTransaction', { chain: 'solana', success: false, statusCode, errorType });
      throw error;
    }
  }

  /**
   * OPTIMIZED: Fetch multiple transactions using JSON-RPC batch requests
   * Instead of 100 HTTP calls, we make 1 HTTP call with 100 batched RPC requests
   * This dramatically reduces HTTP overhead while maintaining same RPC credit usage
   */
  private async fetchTransactionsParallel(signatures: string[], concurrency: number): Promise<any[]> {
    // Use Map keyed by signature for robust result tracking
    const resultsBySig = new Map<string, any>();
    
    // OPTIMIZATION: Use batch size for grouping requests into single HTTP calls
    // Default batch size = 50 (QuickNode/Helius support up to 100)
    const batchSize = parseInt(process.env.SOLANA_RPC_BATCH_SIZE || '50', 10);
    
    // Process in batches (single HTTP call per batch)
    for (let i = 0; i < signatures.length; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);
      
      try {
        // Create batch request (array of JSON-RPC requests)
        const batchRequest = batch.map((sig, idx) => ({
          jsonrpc: '2.0',
          id: idx,
          method: 'getTransaction',
          params: [
            sig,
            {
              encoding: 'jsonParsed',
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed'
            }
          ]
        }));
        
        // Single HTTP call for entire batch
        const response = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batchRequest)
        });

        const httpStatus = response.status;
        const batchResults = await response.json() as any[];

        // Track actual RPC credits used (each request in batch counts separately)
        rpcRequestTracker.logRequest('getTransaction', {
          chain: 'solana',
          success: response.ok,
          count: batch.length, // Count ALL requests in the batch, not just 1
          statusCode: httpStatus,
          errorType: response.ok ? undefined : `http_${httpStatus}`,
        });

        // Process batch results
        if (Array.isArray(batchResults)) {
          batchResults.forEach((result, idx) => {
            const sig = batch[idx];
            if (sig && result && !result.error) {
              resultsBySig.set(sig, result.result);
            } else if (sig) {
              resultsBySig.set(sig, null);
            }
          });
        }

      } catch (error) {
        // Track failed batch with actual count
        const { statusCode, errorType } = extractHttpStatusFromError(error);
        rpcRequestTracker.logRequest('getTransaction', { chain: 'solana', success: false, count: batch.length, statusCode, errorType });
        // On batch failure, mark all signatures in batch as null
        batch.forEach(sig => resultsBySig.set(sig, null));
        logger.debug(`Batch request failed for ${batch.length} transactions: ${error}`);
      }
      
      // Small delay between batches to respect rate limits
      if (i + batchSize < signatures.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Return results in the same order as input signatures (maintains compatibility)
    return signatures.map(sig => resultsBySig.get(sig) || null);
  }

  private extractTokenBuy(tx: any): { 
    tokenAddress: string; 
    buyer: string; 
    amount: number; 
    botType: string;
    isSmartMoney: boolean;
    smartMoneyTier?: 1 | 2 | 3;
  } | null {
    if (!tx || !tx.transaction) {
      return null;
    }

    // Safer signer detection - find account with signer flag
    const accountKeys = tx.transaction.message.accountKeys;
    let signerAddress: string | undefined = undefined;
    
    if (Array.isArray(accountKeys)) {
      // Look for explicit signer flag (most reliable)
      const signerEntry = accountKeys.find((k: any) => {
        if (typeof k === 'object' && k !== null) {
          return k.signer === true;
        }
        return false;
      });
      
      if (signerEntry) {
        signerAddress = typeof signerEntry === 'string' ? signerEntry : signerEntry.pubkey;
      } else {
        // Fallback: if no explicit signer flag found, try first writable signer
        const writableSigner = accountKeys.find((k: any) => {
          if (typeof k === 'object' && k !== null) {
            return k.signer === true && k.writable === true;
          }
          return false;
        });
        
        if (writableSigner) {
          signerAddress = typeof writableSigner === 'string' ? writableSigner : writableSigner.pubkey;
        }
      }
    }

    if (!tx.meta || !signerAddress) {
      return null;
    }

    // Detect which bot was used by checking accounts
    let botType: string | null = null;
    const accountKeyAddresses = accountKeys.map((key: any) => 
      typeof key === 'string' ? key : key.pubkey
    );
    
    for (const [name, bot] of Object.entries(SOLANA_BOTS)) {
      const found = bot.patterns.some(pattern => accountKeyAddresses.includes(pattern));
      if (found) {
        botType = name;
        break;
      }
    }
    
    if (!botType) {
      return null; // Not a recognized bot transaction
    }

    // Check postTokenBalances for token buys
    // Only detects new token accounts (reverted from balance increase detection)
    if (tx.meta.postTokenBalances && tx.meta.postTokenBalances.length > 0) {
      for (const post of tx.meta.postTokenBalances) {
        if (post.owner !== signerAddress) {
          continue; // Skip tokens not owned by signer
        }
        
        const tokenAddress = post.mint;
        
        // Ignore WSOL and USDC
        if (IGNORE_TOKENS.has(tokenAddress)) {
          continue;
        }
        
        // Check if this is a new account (not in preTokenBalances)
        const pre = tx.meta.preTokenBalances?.find((p: any) => 
          p.accountIndex === post.accountIndex && p.mint === post.mint
        );
        
        // Check if buyer is smart money
        const isSmartMoney = isSmartMoneyWallet(signerAddress);
        const smartMoneyTier = isSmartMoney ? getSmartMoneyTier(signerAddress) : undefined;
        
        // Debug: Log buyer check for troubleshooting
        if (process.env.DEBUG_SMART_MONEY === 'true') {
          logger.debug(`   [Buyer Check] ${signerAddress.substring(0, 16)}... buying ${tokenAddress.substring(0, 16)}... - Smart Money: ${isSmartMoney ? `YES (T${smartMoneyTier})` : 'NO'}`);
        }
        
        if (!pre) {
          // New account for signer - this is the token being bought
          return {
            tokenAddress,
            buyer: signerAddress,
            amount: post.uiTokenAmount.uiAmount,
            botType,
            isSmartMoney,
            smartMoneyTier,
          };
        }
        // Note: Balance increases on existing accounts are no longer detected
        // This reverts to the original behavior of only detecting new token accounts
      }
    }

    return null;
  }

  /**
   * Calculate smart money metrics from token activity
   */
  private calculateSmartMoneyMetrics(activity: TokenActivity): {
    walletCount: number | null;
    walletAddresses: string[] | null; // Array of unique wallet addresses
    buyCount: number | null;
    buyPercentage: number | null;
    convictionScore: number | null;
  } {
    // If no smart money activity, return NULL values (not 0 or empty arrays)
    if (activity.smartMoneyWallets.size === 0) {
      logger.debug(`   [Smart Money] No smart money activity for ${activity.address.substring(0, 16)}... (${activity.buyCount} total buys)`);
      return {
        walletCount: null,
        walletAddresses: null,
        buyCount: null,
        buyPercentage: null,
        convictionScore: null,
      };
    }
    
    const walletCount = activity.smartMoneyWallets.size;
    const walletAddresses = Array.from(activity.smartMoneyWallets); // Convert Set to array
    const buyCount = activity.smartMoneyBuyCount;
    const buyPercentage = activity.buyCount > 0 
      ? (buyCount / activity.buyCount) * 100 
      : null; // NULL if no buys to calculate percentage from
    
    // Conviction score (weighted by tier: Tier 1 = 1x, Tier 2 = 2x, Tier 3 = 3x)
    let convictionScore = 0;
    activity.smartMoneyBuys.forEach(buy => {
      const weight = getSmartMoneyWeight(buy.tier);
      convictionScore += weight;
    });
    
    logger.debug(`   [Smart Money] Calculated for ${activity.address.substring(0, 16)}...: ${walletCount} wallets, ${buyCount} buys, ${buyPercentage?.toFixed(2) || 'null'}%, conviction=${convictionScore}`);
    
    return {
      walletCount,
      walletAddresses,
      buyCount,
      buyPercentage,
      convictionScore: convictionScore > 0 ? convictionScore : null,
    };
  }

  private async checkDexScreener(tokenAddress: string): Promise<{ 
    dexId: string; 
    hasLiquidity: boolean; 
    liquidityUsd: number | null;
    pairAddress: string | null;
    quoteToken: string | null;
    pairCreatedAt: number | null; // timestamp in milliseconds
  }> {
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
      const data: any = await response.json();
      
      if (data.pairs && data.pairs.length > 0) {
        // Sort by liquidity (highest first) to get the main pair
        const sortedPairs = data.pairs.sort((a: any, b: any) => {
          const liqA = a.liquidity?.usd || 0;
          const liqB = b.liquidity?.usd || 0;
          return liqB - liqA;
        });
        
        const pair = sortedPairs[0];
        return {
          dexId: pair.dexId || 'unknown',
          hasLiquidity: pair.liquidity?.usd != null,
          liquidityUsd: pair.liquidity?.usd || null,
          pairAddress: pair.pairAddress || null,
          quoteToken: pair.quoteToken?.symbol || null,
          pairCreatedAt: pair.pairCreatedAt || null
        };
      }
    } catch (error) {
      // Ignore errors, just return default
    }
    
    return { 
      dexId: 'unknown',
      hasLiquidity: false,
      liquidityUsd: null,
      pairAddress: null,
      quoteToken: null,
      pairCreatedAt: null
    };
  }

  /**
   * Scan a token directly for smart money buys (not through bots)
   * This catches smart money wallets that buy directly through DEXs
   */
  private async scanTokenForDirectSmartMoneyBuys(
    activity: TokenActivity,
    scanIntervalMinutes: number,
    limit: number
  ): Promise<void> {
    try {
      // Get recent transactions for this token mint
      const signatures = await this.fetchRecentTransactions(activity.address, limit);
      
      if (signatures.length === 0) {
        return;
      }
      
      // Filter to same time window as bot scan
      const now = Date.now() / 1000;
      const timeWindowAgo = now - (scanIntervalMinutes * 60);
      const recentSignatures = signatures.filter((sig: any) => {
        return sig.blockTime && sig.blockTime >= timeWindowAgo;
      });
      
      if (recentSignatures.length === 0) {
        return;
      }
      
      // Fetch transactions in parallel (with concurrency limit)
      const transactions = await this.fetchTransactionsParallel(
        recentSignatures.map((sig: any) => sig.signature),
        this.concurrency
      );
      
      let directSmartMoneyBuys = 0;
      
      // Process each transaction
      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        const sig = recentSignatures[i];
        
        if (!tx || !tx.transaction) continue;
        
        // Extract signer (buyer)
        const accountKeys = tx.transaction.message?.accountKeys || tx.transaction.message?.staticAccountKeys || [];
        let signerAddress: string | undefined = undefined;
        
        if (Array.isArray(accountKeys)) {
          const signerEntry = accountKeys.find((k: any) => {
            if (typeof k === 'object' && k !== null) {
              return k.signer === true;
            }
            return false;
          });
          
          if (signerEntry) {
            signerAddress = typeof signerEntry === 'string' ? signerEntry : signerEntry.pubkey;
          }
        }
        
        if (!signerAddress || !tx.meta) continue;
        
        // Check if this is a token buy (signer received tokens)
        if (tx.meta.postTokenBalances && tx.meta.postTokenBalances.length > 0) {
          for (const post of tx.meta.postTokenBalances) {
            // Only check tokens matching our target token
            if (post.mint !== activity.address) {
              continue;
            }
            
            // Check if signer owns this token account (received tokens)
            if (post.owner !== signerAddress) {
              continue;
            }
            
            // Check if this is a buy (new account only - reverted from balance increase detection)
            const pre = tx.meta.preTokenBalances?.find((p: any) => 
              p.accountIndex === post.accountIndex && p.mint === post.mint
            );
            
            // Only detect new accounts, not balance increases
            const isBuy = !pre;
            
            if (isBuy) {
              // Check if buyer is smart money
              const isSmartMoney = isSmartMoneyWallet(signerAddress);
              const smartMoneyTier = isSmartMoney ? getSmartMoneyTier(signerAddress) : undefined;
              
              if (isSmartMoney && smartMoneyTier) {
                // This is a direct smart money buy (not through bot)
                const timestampMs = (sig.blockTime || 0) * 1000;
                const buyAmount = post.uiTokenAmount.uiAmount; // New account, so use full amount
                
                // Add to smart money tracking
                activity.smartMoneyWallets.add(signerAddress);
                activity.smartMoneyBuyCount++;
                activity.smartMoneyBuys.push({
                  buyer: signerAddress,
                  amount: buyAmount,
                  timestamp: timestampMs,
                  tier: smartMoneyTier
                });
                
                directSmartMoneyBuys++;
                
                logger.debug(`💰 Direct smart money buy: ${signerAddress.substring(0, 16)}... (T${smartMoneyTier}) bought ${activity.address.substring(0, 16)}... directly`);
              }
            }
          }
        }
      }
      
      if (directSmartMoneyBuys > 0) {
        logger.info(`   ✅ ${activity.address.substring(0, 16)}...: Found ${directSmartMoneyBuys} direct smart money buy(s)`);
      }
      
    } catch (error: any) {
      // Don't fail the whole scan if direct scanning fails for one token
      logger.debug(`   ⚠️  Failed to scan ${activity.address.substring(0, 16)}... for direct smart money: ${error.message}`);
    }
  }
}

