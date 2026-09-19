/**
 * Price Tracking Service
 * 
 * Unified service for fetching token prices from Codex API
 * - Batch fetching support (efficient)
 * - Optional caching (configurable via env)
 * - Historical price storage (for analytics)
 */

import { logger } from '../utils/logger';
import { getChainConfig } from '../config/chain';
import { query } from '../infra/database';
import { codexRequestTracker } from '../utils/codex-request-tracker';

interface PriceServiceConfig {
  enableCache: boolean;
  cacheTtlSeconds: number;
}

interface PriceCache {
  price: number;
  timestamp: number;
}

export class PriceTrackingService {
  private config: PriceServiceConfig;
  private cache: Map<string, PriceCache> = new Map();
  
  constructor(config?: Partial<PriceServiceConfig>) {
    this.config = {
      enableCache: process.env.PRICE_ENABLE_CACHE !== 'false',
      cacheTtlSeconds: parseInt(process.env.PRICE_CACHE_TTL_SECONDS || '30'),
      ...config,
    };
    
    logger.info(`💰 Price Tracking Service initialized (cache: ${this.config.enableCache ? 'enabled' : 'disabled'}, TTL: ${this.config.cacheTtlSeconds}s)`);
  }
  
  /**
   * Get price for a single token
   */
  async getPrice(tokenAddress: string, chain?: string): Promise<number> {
    const prices = await this.getPrices([tokenAddress], chain);
    return prices.get(tokenAddress) || 0;
  }
  
  /**
   * Get prices for multiple tokens (batched & cached)
   * This is the main entry point
   */
  async getPrices(
    tokenAddresses: string[],
    chain?: string
  ): Promise<Map<string, number>> {
    if (tokenAddresses.length === 0) {
      return new Map();
    }
    
    const chainConfig = getChainConfig();
    const targetChain = chain || chainConfig.chain;
    
    const results = new Map<string, number>();
    const missingTokens: string[] = [];
    
    // Step 1: Check cache (if enabled)
    if (this.config.enableCache) {
      for (const token of tokenAddresses) {
        const cacheKey = `${targetChain}:${token}`;
        const cached = this.cache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < this.config.cacheTtlSeconds * 1000) {
          results.set(token, cached.price);
          logger.debug(`💰 [PriceService] Cache HIT: ${token.substring(0, 8)}... = $${cached.price.toFixed(8)}`);
        } else {
          missingTokens.push(token);
        }
      }
    } else {
      missingTokens.push(...tokenAddresses);
    }
    
    // Step 2: Fetch missing tokens from Codex
    if (missingTokens.length > 0) {
      logger.debug(`💰 [PriceService] Fetching ${missingTokens.length} prices from Codex`);
      
      const fetchedPrices = await this.fetchFromCodex(missingTokens, targetChain);
      
      // Update cache and results
      for (const [token, price] of fetchedPrices.entries()) {
        if (this.config.enableCache) {
          const cacheKey = `${targetChain}:${token}`;
          this.cache.set(cacheKey, { price, timestamp: Date.now() });
        }
        results.set(token, price);
      }
      
      // Store all fetched prices to DB for historical tracking
      await this.storePricesInDB(fetchedPrices, targetChain);
    }
    
    return results;
  }
  
  /**
   * Fetch prices from Codex GraphQL (batch support)
   * Tracks all Codex API requests for monitoring
   */
  private async fetchFromCodex(
    tokenAddresses: string[],
    chain: string
  ): Promise<Map<string, number>> {
    logger.info(`📡 [Codex] BATCH request: ${tokenAddresses.length} tokens (${chain})`);
    const priceMap = new Map<string, number>();
    
    const codexApiKey = process.env.CODEX_API_KEY;
    if (!codexApiKey) {
      throw new Error('[PriceService] CODEX_API_KEY not configured');
    }
    
    const networkId = chain === 'BNB' ? 56 : 1399811149; // BSC or Solana
    
    const graphqlQuery = `
      query FilterTokensByAddressMin($tokenAddress: [String!], $network: [Int!]) {
        tokens: filterTokens(tokens: $tokenAddress, filters: {network: $network}) {
          results {
            priceUSD
            token {
              address
            }
          }
        }
      }
    `;
    
    try {
      const response = await fetch('https://graph.codex.io/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': codexApiKey,
        },
        body: JSON.stringify({
          query: graphqlQuery,
          variables: {
            tokenAddress: tokenAddresses,
            network: [networkId],
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      codexRequestTracker.logRequest('batch_price', {
        tokenCount: tokenAddresses.length,
        chain,
        statusCode: response.status,
        success: response.ok,
        errorType: response.ok ? undefined : `http_${response.status}`,
      });

      if (!response.ok) {
        throw new Error(`Codex API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as any;

      if (data.errors) {
        throw new Error(`Codex GraphQL error: ${data.errors[0]?.message || 'Unknown error'}`);
      }

      const results = data.data?.tokens?.results || [];

      for (const result of results) {
        if (result?.token?.address && result?.priceUSD) {
          const address = result.token.address;
          const price = parseFloat(result.priceUSD);
          priceMap.set(address, price);
        }
      }

      logger.info(`💰 [PriceService] Codex: ${priceMap.size}/${tokenAddresses.length} prices fetched (1 batched request)`);

      return priceMap;

    } catch (error: any) {
      // Avoid double-logging if we already recorded the HTTP status above.
      if (!(error?.message && /Codex API returned \d+/.test(error.message))) {
        codexRequestTracker.logRequest('batch_price', {
          tokenCount: tokenAddresses.length,
          chain,
          success: false,
          errorType: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network',
        });
      }
      logger.error('[PriceService] Failed to fetch prices from Codex:', error);
      throw error; // Re-throw to fail fast
    }
  }
  
  /**
   * Store prices in database for historical tracking
   */
  private async storePricesInDB(
    prices: Map<string, number>,
    chain: string
  ): Promise<void> {
    if (prices.size === 0) {
      return;
    }
    
    try {
      for (const [tokenAddress, price] of prices.entries()) {
        await query(`
          INSERT INTO price_history (token_address, chain, price_usd, timestamp)
          VALUES ($1, $2, $3, NOW())
        `, [tokenAddress, chain, price]);
      }
      
      logger.debug(`💰 [PriceService] Stored ${prices.size} prices in DB`);
    } catch (error) {
      // Don't fail the whole operation if DB write fails
      logger.warn('[PriceService] Failed to store prices in DB:', error);
    }
  }
  
  /**
   * Get price at a specific timestamp (from historical data)
   */
  async getPriceAt(
    tokenAddress: string,
    timestamp: Date,
    chain?: string
  ): Promise<number | null> {
    const chainConfig = getChainConfig();
    const targetChain = chain || chainConfig.chain;
    
    try {
      const result = await query(`
        SELECT price_usd FROM price_history
        WHERE token_address = $1
          AND chain = $2
          AND timestamp <= $3
        ORDER BY timestamp DESC
        LIMIT 1
      `, [tokenAddress, targetChain, timestamp]);
      
      if (result.rows.length > 0) {
        return result.rows[0].price_usd;
      }
      
      return null;
    } catch (error) {
      logger.warn('[PriceService] Failed to fetch historical price:', error);
      return null;
    }
  }
  
  /**
   * Clear cache (useful for testing or manual refresh)
   */
  clearCache(tokenAddress?: string, chain?: string): void {
    if (tokenAddress && chain) {
      const cacheKey = `${chain}:${tokenAddress}`;
      this.cache.delete(cacheKey);
      logger.debug(`💰 [PriceService] Cache cleared for ${tokenAddress}`);
    } else {
      this.cache.clear();
      logger.info('💰 [PriceService] Cache fully cleared');
    }
  }
  
  /**
   * Get cache stats (for monitoring)
   */
  getCacheStats() {
    return {
      enabled: this.config.enableCache,
      size: this.cache.size,
      ttlSeconds: this.config.cacheTtlSeconds,
    };
  }
}

// Singleton instance
export const priceService = new PriceTrackingService();

