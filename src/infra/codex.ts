// Codex API service - Multi-chain support (BSC & Solana)
// https://docs.codex.io/

import { logger } from '../utils/logger';
import { apiCache } from '../services/api-cache';
import { getChainConfig, Chain } from '../config/chain';
import { codexRequestTracker } from '../utils/codex-request-tracker';

const BSC_NETWORK_ID = 56;
const SOLANA_NETWORK_ID = 1399811149;

export interface CodexTokenData {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  
  // Price & Market Data
  priceUSD: number;
  liquidity: number;
  volume24h: number;
  priceChange24h: number;
  marketCap: number;
  
  // Holder Data
  holders?: number;
  
  // Extended Volumes (multiple timeframes)
  volume5m?: number;
  volume1h?: number;
  volume4h?: number;
  volume24hCodex?: number; // Explicitly from Codex (vs DexScreener)
  
  // Transaction Counts (buy/sell)
  buyCount5m?: number;
  sellCount5m?: number;
  buyCount1h?: number;
  sellCount1h?: number;
  buyCount4h?: number;
  sellCount4h?: number;
  buyCount24h?: number;
  sellCount24h?: number;
  
  // Unique Buys/Sells
  uniqueBuys5m?: number;
  uniqueSells5m?: number;
  uniqueBuys1h?: number;
  uniqueSells1h?: number;
  uniqueBuys24h?: number;
  uniqueSells24h?: number;
  
  // Unique Transaction Wallets
  uniqueTransactions5m?: number;
  uniqueTransactions1h?: number;
  uniqueTransactions24h?: number;
  
  // Wallet Age Metrics
  swapPct1dOldWallet?: number;
  swapPct7dOldWallet?: number;
  walletAgeAvg?: number;
  walletAgeStd?: number;
  
  // Scam Flag
  isScam?: boolean;
  
  // Wallet Type Metrics (risk signals)
  bundlerCount?: number;
  sniperCount?: number;
  insiderCount?: number;
  bundlerHeldPercentage?: number;
  sniperHeldPercentage?: number;
  insiderHeldPercentage?: number;
  devHeldPercentage?: number;
}

// Legacy type alias for backwards compatibility
export type CodexBSCTokenData = CodexTokenData;

/**
 * Unified Codex API - works for both BSC and Solana
 * Automatically detects chain from configuration
 */
export class CodexAPI {
  private apiKey: string | null;
  private baseUrl = 'https://graph.codex.io/graphql';
  private networkId: number;
  private chainName: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.CODEX_API_KEY || null;
    
    // Detect chain from config
    const chainConfig = getChainConfig();
    this.networkId = chainConfig.chain === Chain.SOLANA ? SOLANA_NETWORK_ID : BSC_NETWORK_ID;
    this.chainName = chainConfig.chain === Chain.SOLANA ? 'Solana' : 'BSC';
    
    if (this.apiKey) {
      logger.info(`✅ Codex API (${this.chainName}) configured - Network ID: ${this.networkId}`);
    } else {
      logger.warn('⚠️ No CODEX_API_KEY found in environment');
    }
  }

  /**
   * Get comprehensive token data (INDIVIDUAL - use getTokenDataBatch() for multiple tokens!)
   * @deprecated Use getTokenDataBatch() for multiple tokens to reduce API calls
   */
  async getTokenData(tokenAddress: string): Promise<CodexTokenData | null> {
    if (!this.apiKey) {
      logger.warn('⚠️ No Codex API key - skipping metadata fetch');
      return null;
    }

    // Check cache first (2 minute TTL for price data)
    const cached = apiCache.getTokenMetadata(tokenAddress);
    if (cached) {
      return cached as CodexTokenData;
    }
    
    // WARNING: Individual request - should use batch for multiple tokens!
    logger.warn(`📡 [Codex] INDIVIDUAL metadata request: ${tokenAddress.substring(0, 8)}... (${this.chainName}) - Consider using getTokenDataBatch()!`);

    const query = `
      query FilterTokens($address: [String!], $network: [Int!]) {
        filterTokens(
          tokens: $address
          filters: {network: $network}
        ) {
          results {
            liquidity
            volume24
            volume5m
            volume1
            volume4
            priceUSD
            holders
            marketCap
            isScam
            buyCount5m
            sellCount5m
            buyCount1
            sellCount1
            buyCount4
            sellCount4
            buyCount24
            sellCount24
            uniqueBuys5m
            uniqueSells5m
            uniqueBuys1
            uniqueSells1
            uniqueBuys24
            uniqueSells24
            uniqueTransactions5m
            uniqueTransactions1
            uniqueTransactions24
            swapPct1dOldWallet
            swapPct7dOldWallet
            walletAgeAvg
            walletAgeStd
            bundlerCount
            sniperCount
            insiderCount
            bundlerHeldPercentage
            sniperHeldPercentage
            insiderHeldPercentage
            devHeldPercentage
            token {
              address
              name
              symbol
              decimals
            }
          }
        }
      }
    `;

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.apiKey,
        },
        body: JSON.stringify({
          query,
          variables: {
            address: [tokenAddress],
            network: [this.networkId],
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      codexRequestTracker.logRequest('individual_metadata', {
        tokenCount: 1,
        chain: this.chainName,
        statusCode: response.status,
        success: response.ok,
        errorType: response.ok ? undefined : `http_${response.status}`,
      });

      if (!response.ok) {
        logger.warn(`Codex API returned ${response.status} for ${tokenAddress.slice(0, 8)}`);
        return null;
      }

      const json = await response.json() as any;

      const filterResults = json.data?.filterTokens?.results?.[0];

      if (!filterResults) {
        if (json.errors) {
          logger.warn(`Codex error for ${tokenAddress.slice(0, 8)}:`, json.errors[0]?.message);
        }
        return null;
      }

      const defaultDecimals = this.networkId === SOLANA_NETWORK_ID ? 9 : 18;

      const result: CodexTokenData = this.parseCodexTokenData(filterResults, tokenAddress, defaultDecimals);

      // Cache the result (2 minute TTL)
      apiCache.setTokenMetadata(tokenAddress, result);

      return result;
    } catch (error: any) {
      codexRequestTracker.logRequest('individual_metadata', {
        tokenCount: 1,
        chain: this.chainName,
        success: false,
        errorType: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network',
      });
      logger.warn(`Codex API error for ${tokenAddress.slice(0, 8)}:`, error.message);
      return null;
    }
  }

  /**
   * Batch fetch token data for multiple tokens
   * Tracks all Codex API requests for monitoring
   */
  async getTokenDataBatch(tokenAddresses: string[]): Promise<Map<string, CodexTokenData>> {
    logger.info(`📡 [Codex] BATCH metadata request: ${tokenAddresses.length} tokens (${this.chainName})`);
    const results = new Map<string, CodexTokenData>();

    if (!this.apiKey) {
      logger.warn('⚠️ No Codex API key - skipping batch metadata fetch');
      return results;
    }

    if (tokenAddresses.length === 0) {
      return results;
    }

    // Check cache first
    const uncachedAddresses: string[] = [];
    for (const address of tokenAddresses) {
      const cached = apiCache.getTokenMetadata(address);
      if (cached) {
        results.set(address, cached as CodexTokenData);
      } else {
        uncachedAddresses.push(address);
      }
    }

    if (uncachedAddresses.length === 0) {
      logger.info(`✅ All ${tokenAddresses.length} tokens found in cache`);
      return results;
    }

    logger.info(`📊 Fetching ${uncachedAddresses.length} tokens from Codex (${this.chainName})`);

    const query = `
      query FilterTokens($address: [String!], $network: [Int!]) {
        filterTokens(
          tokens: $address
          filters: {network: $network}
        ) {
          results {
            liquidity
            volume24
            volume5m
            volume1
            volume4
            priceUSD
            holders
            marketCap
            isScam
            buyCount5m
            sellCount5m
            buyCount1
            sellCount1
            buyCount4
            sellCount4
            buyCount24
            sellCount24
            uniqueBuys5m
            uniqueSells5m
            uniqueBuys1
            uniqueSells1
            uniqueBuys24
            uniqueSells24
            uniqueTransactions5m
            uniqueTransactions1
            uniqueTransactions24
            swapPct1dOldWallet
            swapPct7dOldWallet
            walletAgeAvg
            walletAgeStd
            bundlerCount
            sniperCount
            insiderCount
            bundlerHeldPercentage
            sniperHeldPercentage
            insiderHeldPercentage
            devHeldPercentage
            token {
              address
              name
              symbol
              decimals
            }
          }
        }
      }
    `;

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.apiKey,
        },
        body: JSON.stringify({
          query,
          variables: {
            address: uncachedAddresses,
            network: [this.networkId],
          },
        }),
        signal: AbortSignal.timeout(15000),
      });

      codexRequestTracker.logRequest('batch_metadata', {
        tokenCount: uncachedAddresses.length,
        chain: this.chainName,
        statusCode: response.status,
        success: response.ok,
        errorType: response.ok ? undefined : `http_${response.status}`,
      });

      if (!response.ok) {
        let errorDetails = '';
        try {
          const errorText = await response.text();
          // Try to parse as JSON for GraphQL errors
          try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.errors) {
              errorDetails = errorJson.errors.map((e: any) => e.message).join('; ');
            } else if (errorJson.message) {
              errorDetails = errorJson.message;
            } else {
              errorDetails = errorText.substring(0, 500);
            }
          } catch {
            errorDetails = errorText.substring(0, 500);
          }
        } catch {
          errorDetails = `HTTP ${response.status} - Unable to read error response`;
        }
        logger.error(`❌ Codex batch API returned ${response.status} (${this.chainName}): ${errorDetails}`);
        return results;
      }

      const json = await response.json() as any;
      const filterResults = json.data?.filterTokens?.results || [];

      const defaultDecimals = this.networkId === SOLANA_NETWORK_ID ? 9 : 18;

      for (const filterResult of filterResults) {
        const tokenData = this.parseCodexTokenData(
          filterResult,
          filterResult.token?.address || '',
          defaultDecimals
        );

        results.set(tokenData.address, tokenData);
        
        // Cache each result
        apiCache.setTokenMetadata(tokenData.address, tokenData);
      }

      logger.info(`✅ Codex (${this.chainName}): ${filterResults.length}/${uncachedAddresses.length} tokens fetched (1 batched request)`);

    } catch (error: any) {
      codexRequestTracker.logRequest('batch_metadata', {
        tokenCount: uncachedAddresses.length,
        chain: this.chainName,
        success: false,
        errorType: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network',
      });
      logger.warn(`Codex batch API error (${this.chainName}):`, error.message);
    }

    return results;
  }

  /**
   * Parse Codex API response into CodexTokenData
   * Helper method to avoid code duplication
   */
  private parseCodexTokenData(
    filterResult: any,
    tokenAddress: string,
    defaultDecimals: number
  ): CodexTokenData {
    return {
      address: tokenAddress,
      name: filterResult.token?.name || 'Unknown',
      symbol: filterResult.token?.symbol || 'UNK',
      decimals: filterResult.token?.decimals || defaultDecimals,
      
      priceUSD: parseFloat(filterResult?.priceUSD || '0'),
      liquidity: parseFloat(filterResult?.liquidity || '0'),
      volume24h: parseFloat(filterResult?.volume24 || '0'),
      priceChange24h: 0, // Not available from Codex
      marketCap: parseFloat(filterResult?.marketCap || '0'),
      
      holders: filterResult?.holders || undefined,
      
      // Extended volumes
      volume5m: filterResult?.volume5m ? parseFloat(filterResult.volume5m) : undefined,
      volume1h: filterResult?.volume1 ? parseFloat(filterResult.volume1) : undefined,
      volume4h: filterResult?.volume4 ? parseFloat(filterResult.volume4) : undefined,
      volume24hCodex: filterResult?.volume24 ? parseFloat(filterResult.volume24) : undefined,
      
      // Transaction counts
      buyCount5m: filterResult?.buyCount5m ? parseInt(filterResult.buyCount5m) : undefined,
      sellCount5m: filterResult?.sellCount5m ? parseInt(filterResult.sellCount5m) : undefined,
      buyCount1h: filterResult?.buyCount1 ? parseInt(filterResult.buyCount1) : undefined,
      sellCount1h: filterResult?.sellCount1 ? parseInt(filterResult.sellCount1) : undefined,
      buyCount4h: filterResult?.buyCount4 ? parseInt(filterResult.buyCount4) : undefined,
      sellCount4h: filterResult?.sellCount4 ? parseInt(filterResult.sellCount4) : undefined,
      buyCount24h: filterResult?.buyCount24 ? parseInt(filterResult.buyCount24) : undefined,
      sellCount24h: filterResult?.sellCount24 ? parseInt(filterResult.sellCount24) : undefined,
      
      // Unique buys/sells
      uniqueBuys5m: filterResult?.uniqueBuys5m ? parseInt(filterResult.uniqueBuys5m) : undefined,
      uniqueSells5m: filterResult?.uniqueSells5m ? parseInt(filterResult.uniqueSells5m) : undefined,
      uniqueBuys1h: filterResult?.uniqueBuys1 ? parseInt(filterResult.uniqueBuys1) : undefined,
      uniqueSells1h: filterResult?.uniqueSells1 ? parseInt(filterResult.uniqueSells1) : undefined,
      uniqueBuys24h: filterResult?.uniqueBuys24 ? parseInt(filterResult.uniqueBuys24) : undefined,
      uniqueSells24h: filterResult?.uniqueSells24 ? parseInt(filterResult.uniqueSells24) : undefined,
      
      // Unique transactions
      uniqueTransactions5m: filterResult?.uniqueTransactions5m ? parseInt(filterResult.uniqueTransactions5m) : undefined,
      uniqueTransactions1h: filterResult?.uniqueTransactions1 ? parseInt(filterResult.uniqueTransactions1) : undefined,
      uniqueTransactions24h: filterResult?.uniqueTransactions24 ? parseInt(filterResult.uniqueTransactions24) : undefined,
      
      // Wallet age metrics
      swapPct1dOldWallet: filterResult?.swapPct1dOldWallet ? parseFloat(filterResult.swapPct1dOldWallet) : undefined,
      swapPct7dOldWallet: filterResult?.swapPct7dOldWallet ? parseFloat(filterResult.swapPct7dOldWallet) : undefined,
      walletAgeAvg: filterResult?.walletAgeAvg ? parseFloat(filterResult.walletAgeAvg) : undefined,
      walletAgeStd: filterResult?.walletAgeStd ? parseFloat(filterResult.walletAgeStd) : undefined,
      
      // Scam flag
      isScam: filterResult?.isScam || false,
      
      // Wallet type metrics
      bundlerCount: filterResult?.bundlerCount ? parseInt(filterResult.bundlerCount) : undefined,
      sniperCount: filterResult?.sniperCount ? parseInt(filterResult.sniperCount) : undefined,
      insiderCount: filterResult?.insiderCount ? parseInt(filterResult.insiderCount) : undefined,
      bundlerHeldPercentage: filterResult?.bundlerHeldPercentage ? parseFloat(filterResult.bundlerHeldPercentage) : undefined,
      sniperHeldPercentage: filterResult?.sniperHeldPercentage ? parseFloat(filterResult.sniperHeldPercentage) : undefined,
      insiderHeldPercentage: filterResult?.insiderHeldPercentage ? parseFloat(filterResult.insiderHeldPercentage) : undefined,
      devHeldPercentage: filterResult?.devHeldPercentage ? parseFloat(filterResult.devHeldPercentage) : undefined,
    };
  }

  /**
   * Fetch OHLCV candles for a token
   * NOTE: Codex API doesn't support batching candles, so each call = 1 request
   * @param tokenAddress - Token address (BSC) or mint (Solana)
   * @param resolution - Candle resolution ('1' = 1min, '5' = 5min)
   * @param count - Number of recent candles to fetch
   */
  async getCandles(tokenAddress: string, resolution: string, count: number): Promise<any[]> {
    if (!this.apiKey) {
      return [];
    }
    
    logger.debug(`📡 [Codex] CANDLE request: ${tokenAddress.substring(0, 8)}... ${resolution}m (${this.chainName})`);

    try {
      const timeNow = Math.floor(Date.now() / 1000);
      const minutesPerCandle = parseInt(resolution);
      const timeFrom = timeNow - (minutesPerCandle * 60 * count);
      
      // Codex symbol format: "tokenAddress:networkId"
      const symbol = `${tokenAddress}:${this.networkId}`;
      
      const query = `
        query ChartData($symbol: String!, $from: Int!, $to: Int!, $resolution: String!) {
          getBars(
            symbol: $symbol
            from: $from
            to: $to
            resolution: $resolution
            removeEmptyBars: true
            removeLeadingNullValues: true
            symbolType: TOKEN
            currencyCode: "USD"
          ) {
            o
            h
            l
            c
            t
            volume
          }
        }
      `;
      
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.apiKey,
        },
        body: JSON.stringify({
          query,
          variables: {
            symbol,
            from: timeFrom,
            to: timeNow,
            resolution,
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      codexRequestTracker.logRequest('candle', {
        resolution,
        chain: this.chainName,
        statusCode: response.status,
        success: response.ok,
        errorType: response.ok ? undefined : `http_${response.status}`,
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as any;
      return data.data?.getBars || [];

    } catch (error: any) {
      codexRequestTracker.logRequest('candle', {
        resolution,
        chain: this.chainName,
        success: false,
        errorType: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network',
      });
      logger.warn(`Codex candles error (${this.chainName}):`, error.message);
      return [];
    }
  }

  /**
   * Test if API key is valid
   */
  async testConnection(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }

    const query = `
      query {
        __schema {
          types {
            name
          }
        }
      }
    `;

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.apiKey,
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(5000),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

// Legacy class name for backwards compatibility
export class CodexBSCAPI extends CodexAPI {}
export class CodexSolanaAPI extends CodexAPI {}
