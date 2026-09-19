/**
 * API Cache Manager
 * Centralized caching for all external API calls
 * Caches persist until bot restart (in-memory)
 */

import { logger } from '../utils/logger';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number | null; // null = never expires
}

export class APICache {
  private static instance: APICache;
  
  // Different caches for different data types
  private securityCache = new Map<string, CacheEntry<any>>();
  private contractCache = new Map<string, CacheEntry<any>>();
  private tokenMetadataCache = new Map<string, CacheEntry<any>>();
  private honeypotCache = new Map<string, CacheEntry<any>>();
  private rugcheckCache = new Map<string, CacheEntry<any>>(); // Solana RugCheck API
  
  // Cache TTLs (in milliseconds)
  private readonly TTL = {
    // Contract data rarely changes
    CONTRACT_VERIFICATION: null, // Never expires (until restart)
    SOURCE_CODE: null, // Never expires (until restart)
    CONTRACT_CREATION: null, // Never expires (until restart)
    
    // Security analysis - holder distribution can change rapidly for fresh tokens
    SECURITY_ANALYSIS: parseInt(process.env.SECURITY_CACHE_TTL_HOURS || '1', 10) * 60 * 60 * 1000, // Default: 1 hour
    HONEYPOT_CHECK: 60 * 60 * 1000, // 1 hour (honeypots might get fixed)
    RUGCHECK: 60 * 60 * 1000, // 1 hour (same as GoPlus - security data can change)
    
    // Token metadata changes frequently
    TOKEN_METADATA: 2 * 60 * 1000, // 2 minutes (price/volume changes)
    TOKEN_BASIC_INFO: null, // Name/symbol never changes
  };
  
  private constructor() {
    logger.info('🗄️  API Cache initialized');
  }
  
  static getInstance(): APICache {
    if (!APICache.instance) {
      APICache.instance = new APICache();
    }
    return APICache.instance;
  }
  
  /**
   * Generic get/set methods
   */
  private get<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string
  ): T | null {
    const entry = cache.get(key.toLowerCase());
    
    if (!entry) return null;
    
    // Check if expired
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      cache.delete(key.toLowerCase());
      return null;
    }
    
    return entry.data;
  }
  
  private set<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    data: T,
    ttl: number | null
  ): void {
    const timestamp = Date.now();
    const expiresAt = ttl !== null ? timestamp + ttl : null;
    
    cache.set(key.toLowerCase(), {
      data,
      timestamp,
      expiresAt,
    });
  }
  
  /**
   * Security Analysis Cache
   * Caches complete security analysis results
   */
  getSecurityAnalysis(tokenAddress: string): any | null {
    return this.get(this.securityCache, tokenAddress);
  }
  
  setSecurityAnalysis(tokenAddress: string, analysis: any): void {
    this.set(this.securityCache, tokenAddress, analysis, this.TTL.SECURITY_ANALYSIS);
  }
  
  /**
   * Contract Verification Cache
   * Caches BSCScan contract verification status
   */
  getContractVerification(tokenAddress: string): { verified: boolean; code: string; implementation?: string } | null {
    return this.get(this.contractCache, `verification:${tokenAddress}`);
  }
  
  setContractVerification(
    tokenAddress: string,
    data: { verified: boolean; code: string; implementation?: string }
  ): void {
    this.set(
      this.contractCache,
      `verification:${tokenAddress}`,
      data,
      this.TTL.CONTRACT_VERIFICATION
    );
  }
  
  /**
   * Contract Creation Info Cache
   * Caches contract creation time/block
   */
  getContractCreation(tokenAddress: string): { age: number } | null {
    return this.get(this.contractCache, `creation:${tokenAddress}`);
  }
  
  setContractCreation(tokenAddress: string, data: { age: number }): void {
    this.set(
      this.contractCache,
      `creation:${tokenAddress}`,
      data,
      this.TTL.CONTRACT_CREATION
    );
  }
  
  /**
   * Honeypot Check Cache
   * Caches GoPlus Security API results
   */
  getHoneypotCheck(tokenAddress: string): { isHoneypot: boolean } | null {
    return this.get(this.honeypotCache, tokenAddress);
  }
  
  setHoneypotCheck(tokenAddress: string, data: { isHoneypot: boolean }): void {
    this.set(this.honeypotCache, tokenAddress, data, this.TTL.HONEYPOT_CHECK);
  }
  
  /**
   * RugCheck Cache (Solana)
   * Caches RugCheck.xyz API results (1 hour TTL, same as GoPlus)
   */
  getRugCheck(tokenAddress: string): any | null {
    return this.get(this.rugcheckCache, tokenAddress);
  }
  
  setRugCheck(tokenAddress: string, data: any): void {
    this.set(this.rugcheckCache, tokenAddress, data, this.TTL.RUGCHECK);
  }
  
  /**
   * Token Metadata Cache (Codex API)
   * Short TTL because price/volume changes frequently
   */
  getTokenMetadata(tokenAddress: string): any | null {
    return this.get(this.tokenMetadataCache, tokenAddress);
  }
  
  setTokenMetadata(tokenAddress: string, data: any): void {
    this.set(this.tokenMetadataCache, tokenAddress, data, this.TTL.TOKEN_METADATA);
  }
  
  /**
   * Token Basic Info Cache
   * Name/symbol/decimals never change
   */
  getTokenBasicInfo(tokenAddress: string): { name: string; symbol: string; decimals: number } | null {
    return this.get(this.tokenMetadataCache, `basic:${tokenAddress}`);
  }
  
  setTokenBasicInfo(
    tokenAddress: string,
    data: { name: string; symbol: string; decimals: number }
  ): void {
    this.set(
      this.tokenMetadataCache,
      `basic:${tokenAddress}`,
      data,
      this.TTL.TOKEN_BASIC_INFO
    );
  }
  
  /**
   * Cache statistics
   */
  getStats(): {
    security: number;
    contract: number;
    metadata: number;
    honeypot: number;
    rugcheck: number;
    total: number;
  } {
    return {
      security: this.securityCache.size,
      contract: this.contractCache.size,
      metadata: this.tokenMetadataCache.size,
      honeypot: this.honeypotCache.size,
      rugcheck: this.rugcheckCache.size,
      total: this.securityCache.size + this.contractCache.size + this.tokenMetadataCache.size + this.honeypotCache.size + this.rugcheckCache.size,
    };
  }
  
  /**
   * Clear specific cache
   */
  clearSecurityCache(): void {
    this.securityCache.clear();
    logger.info('🗑️  Security cache cleared');
  }
  
  clearMetadataCache(): void {
    this.tokenMetadataCache.clear();
    logger.info('🗑️  Metadata cache cleared');
  }
  
  /**
   * Clear all caches
   */
  clearAll(): void {
    this.securityCache.clear();
    this.contractCache.clear();
    this.tokenMetadataCache.clear();
    this.honeypotCache.clear();
    this.rugcheckCache.clear();
    logger.info('🗑️  All caches cleared');
  }
  
  /**
   * Log cache stats
   */
  logStats(): void {
    const stats = this.getStats();
    logger.info(`📊 Cache stats: ${JSON.stringify(stats)}`);
  }
}

// Export singleton instance
export const apiCache = APICache.getInstance();

