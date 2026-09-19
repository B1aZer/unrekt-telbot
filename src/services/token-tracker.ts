/**
 * Token Tracker
 * 
 * Tracks prices for tokens from scanned_tokens that are "ready" or "filtered"
 * Calculates and stores peak_gain during the tracking period
 * 
 * This replaces the old skipped-token-tracker and works with scanned_tokens table
 */

import { logger } from '../utils/logger';
import { priceService } from './price-tracking';
import { query } from '../infra/database';

interface TrackedToken {
  scannedTokenId: number;
  tokenAddress: string;
  symbol: string;
  chain: string;
  scanPrice: number; // Price at scan time (baseline for gain calculation)
  scanTime: Date; // Scan timestamp (from scans table) - used for peak gain calculation
  timer: Timer;
  stopAt: Date;
  peakGain: number; // Track max gain during tracking period
  peakDrawdown: number; // Track min gain (max drawdown) during tracking period
}

export class TokenTracker {
  private enabled: boolean;
  private trackingDurationMinutes: number;
  private priceCheckIntervalSeconds: number;
  private trackingMode: string | null; // null = 'all', or specific filter_stage value like 'ai_ready'
  
  private activeTracking = new Map<number, TrackedToken>(); // Key: scanned_token_id
  private batchTimer: NodeJS.Timeout | null = null; // Global batch timer for all tokens
  
  constructor() {
    this.enabled = process.env.TOKEN_TRACKING_ENABLED === 'true';
    this.trackingDurationMinutes = parseInt(process.env.TOKEN_TRACKING_MINUTES || '60');
    this.priceCheckIntervalSeconds = parseInt(process.env.TOKEN_TRACKING_PRICE_CHECK_INTERVAL || '60');
    const modeEnv = process.env.TOKEN_TRACKING_MODE;
    this.trackingMode = modeEnv && modeEnv !== 'all' ? modeEnv : null; // null = track all
    
    if (this.enabled) {
      logger.info(`📊 Token Tracker enabled (${this.trackingDurationMinutes}min, every ${this.priceCheckIntervalSeconds}s, mode: ${this.trackingMode || 'all'})`);
      // Start global batch timer
      this.startBatchTimer();
    } else {
      logger.info('📊 Token Tracker disabled');
    }
  }
  
  /**
   * Start global batch timer for checking all token prices at once
   * This dramatically reduces Codex API calls (from 22,800/hour to ~120/hour)
   */
  private startBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }
    
    this.batchTimer = setInterval(async () => {
      await this.checkAllPrices();
    }, this.priceCheckIntervalSeconds * 1000);
  }
  
  /**
   * Check if a token should be tracked based on filter_stage and tracking mode
   */
  shouldTrack(filterStage: string | null): boolean {
    if (!this.enabled) {
      return false;
    }
    
    if (!filterStage) {
      return false; // No filter stage = reached AI, don't track
    }
    
    // If mode is null or 'all', track all filter stages
    if (!this.trackingMode) {
      return true;
    }
    
    // Otherwise, only track if filter_stage matches the mode
    return filterStage === this.trackingMode;
  }
  
  /**
   * Start tracking a token from scanned_tokens
   * Only tracks tokens that are "ready" or "filtered" (not tokens that reached AI and have decisions)
   * If token is past tracking window, calculates peak_gain from price_history instead
   */
  async startTracking(
    scannedTokenId: number,
    tokenAddress: string,
    symbol: string,
    chain: string,
    scanPrice: number,
    scanTime?: Date
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }
    
    // Don't track if already tracking
    if (this.activeTracking.has(scannedTokenId)) {
      return;
    }
    
    logger.debug(`[DEBUG PEAK] startTracking called for token ${scannedTokenId}:`);
    logger.debug(`[DEBUG PEAK]   scanPrice: ${scanPrice}`);
    logger.debug(`[DEBUG PEAK]   scanTime: ${scanTime ? scanTime.toISOString() : 'undefined'}`);
    
    // If scanTime not provided, fetch it from database using scan_id
    if (!scanTime) {
      const scanResult = await query(`
        SELECT s.timestamp as scan_timestamp
        FROM scanned_tokens st
        INNER JOIN scans s ON s.id = st.scan_id
        WHERE st.id = $1
      `, [scannedTokenId]);
      
      if (scanResult.rows[0]?.scan_timestamp) {
        scanTime = new Date(scanResult.rows[0].scan_timestamp);
        logger.debug(`[DEBUG PEAK]   Fetched scan_timestamp from database: ${scanTime.toISOString()}`);
      } else {
        logger.warn(`[DEBUG PEAK]   Could not find scan_timestamp for scanned_token ${scannedTokenId}, using current time`);
        scanTime = new Date();
      }
    }
    
    // Check if past tracking window
    const ageMs = Date.now() - scanTime.getTime();
    const trackingWindowMs = this.trackingDurationMinutes * 60 * 1000;
    
    logger.debug(`[DEBUG PEAK]   ageMs: ${ageMs}, trackingWindowMs: ${trackingWindowMs}`);
    
    if (ageMs >= trackingWindowMs) {
      // Past tracking window - calculate from history instead
      logger.debug(`[DEBUG PEAK]   Past tracking window, calling calculatePeakGainFromHistory`);
      await this.calculatePeakGainFromHistory(scannedTokenId, tokenAddress, chain, scanPrice, scanTime);
      return;
    }
    
    // Calculate stop time based on scan time (not current time)
    // This ensures tracking window is consistent for all tokens in the same scan
    const stopAt = new Date(scanTime.getTime() + this.trackingDurationMinutes * 60 * 1000);
    
    logger.info(`📊 [TokenTracker] Tracking ${symbol} (ID: ${scannedTokenId}) for ${this.trackingDurationMinutes}min from scan time`);
    
    // Set up timer for expiration tracking (not for price checks - those are batched)
    const timer = setInterval(async () => {
      // Check if expired
      const tracked = this.activeTracking.get(scannedTokenId);
      if (tracked && new Date() >= tracked.stopAt) {
        await this.stopTracking(scannedTokenId);
      }
    }, this.priceCheckIntervalSeconds * 1000);
    
    this.activeTracking.set(scannedTokenId, {
      scannedTokenId,
      tokenAddress,
      symbol,
      chain,
      scanPrice,
      scanTime, // Store scan time for peak gain calculation
      timer,
      stopAt,
      peakGain: -Infinity, // Start at -Infinity so we track the actual peak (even if negative)
      peakDrawdown: Infinity, // Start at Infinity so we track the actual drawdown (even if positive)
    });
    
    // Trigger immediate batch check (will include this new token)
    await this.checkAllPrices();
  }
  
  /**
   * Check prices for ALL tracked tokens in a single batched request
   * This reduces Codex API calls from 22,800/hour to ~120/hour (99.5% reduction!)
   */
  private async checkAllPrices(): Promise<void> {
    if (this.activeTracking.size === 0) {
      return;
    }
    
    // Group tokens by chain (for batch fetching)
    const tokensByChain = new Map<string, Array<{ scannedTokenId: number; tokenAddress: string; symbol: string; scanPrice: number; tracked: TrackedToken }>>();
    
    // Collect all active tokens
    for (const [scannedTokenId, tracked] of this.activeTracking.entries()) {
      // Check if expired
      if (new Date() >= tracked.stopAt) {
        await this.stopTracking(scannedTokenId);
        continue;
      }
      
      if (!tokensByChain.has(tracked.chain)) {
        tokensByChain.set(tracked.chain, []);
      }
      
      tokensByChain.get(tracked.chain)!.push({
        scannedTokenId,
        tokenAddress: tracked.tokenAddress,
        symbol: tracked.symbol,
        scanPrice: tracked.scanPrice,
        tracked,
      });
    }
    
    // Batch fetch prices for each chain
    for (const [chain, tokens] of tokensByChain.entries()) {
      if (tokens.length === 0) continue;
      
      try {
        // Batch fetch all prices at once
        const tokenAddresses = tokens.map(t => t.tokenAddress);
        const prices = await priceService.getPrices(tokenAddresses, chain);
        
        // Update each token's peak_gain
        for (const token of tokens) {
          try {
            const currentPrice = prices.get(token.tokenAddress);
            
            if (currentPrice && token.scanPrice > 0) {
              // Calculate gain from scan price
              const gain = ((currentPrice - token.scanPrice) / token.scanPrice) * 100;
              
              // Update peak gain if this is higher (peak_gain = maximum gain, even if negative)
              let peakGainUpdated = false;
              if (gain > token.tracked.peakGain) {
                token.tracked.peakGain = gain;
                peakGainUpdated = true;
                
                logger.debug(`[DEBUG PEAK] New peak gain for ${token.symbol} (ID: ${token.scannedTokenId}):`);
                logger.debug(`[DEBUG PEAK]   currentPrice: ${currentPrice}`);
                logger.debug(`[DEBUG PEAK]   scanPrice: ${token.scanPrice}`);
                logger.debug(`[DEBUG PEAK]   calculated gain: ${gain.toFixed(2)}% = ((${currentPrice} - ${token.scanPrice}) / ${token.scanPrice}) * 100`);
                
                // Update peak_gain in database (without timestamp - error-prone and not critical)
                // The peak_gain value is what matters for analytics and ML training
                await query(`
                  UPDATE scanned_tokens 
                  SET peak_gain = $1
                  WHERE id = $2
                `, [gain, token.scannedTokenId]);
              }
              
              // Update peak drawdown if this is lower (peak_drawdown = minimum gain, even if positive)
              let peakDrawdownUpdated = false;
              if (gain < token.tracked.peakDrawdown) {
                token.tracked.peakDrawdown = gain;
                peakDrawdownUpdated = true;
                
                logger.debug(`[DEBUG DRAWDOWN] New peak drawdown for ${token.symbol} (ID: ${token.scannedTokenId}):`);
                logger.debug(`[DEBUG DRAWDOWN]   currentPrice: ${currentPrice}`);
                logger.debug(`[DEBUG DRAWDOWN]   scanPrice: ${token.scanPrice}`);
                logger.debug(`[DEBUG DRAWDOWN]   calculated gain: ${gain.toFixed(2)}% = ((${currentPrice} - ${token.scanPrice}) / ${token.scanPrice}) * 100`);
                
                // Update peak_drawdown in database
                await query(`
                  UPDATE scanned_tokens 
                  SET peak_drawdown = $1
                  WHERE id = $2
                `, [gain, token.scannedTokenId]);
              }
              
              logger.debug(`📊 [TokenTracker] ${token.symbol}: $${currentPrice.toFixed(8)} (${gain >= 0 ? '+' : ''}${gain.toFixed(2)}% from scan, peak: ${token.tracked.peakGain >= 0 ? '+' : ''}${token.tracked.peakGain.toFixed(2)}%, drawdown: ${token.tracked.peakDrawdown >= 0 ? '+' : ''}${token.tracked.peakDrawdown.toFixed(2)}%)`);
            }
          } catch (tokenError) {
            // Log error for this specific token but continue with others
            logger.error(`[TokenTracker] Error processing token ${token.symbol} (${token.tokenAddress}):`, tokenError);
          }
        }
      } catch (error) {
        logger.error(`[TokenTracker] Error batch fetching prices for ${chain}:`, error);
        // Log more details for debugging
        if (error instanceof Error) {
          logger.error(`[TokenTracker] Error details: ${error.message}`);
          logger.error(`[TokenTracker] Stack: ${error.stack}`);
        }
      }
    }
  }
  
  /**
   * DEPRECATED: Individual price checking is now batched
   * Use checkAllPrices() instead
   * Kept for backwards compatibility but does nothing
   */
  private async checkPrice(scannedTokenId: number): Promise<void> {
    // Price checking is now batched globally via checkAllPrices()
    // This method is kept for backwards compatibility but is a no-op
    // Individual timers are only used for expiration tracking
  }
  
  /**
   * Stop tracking a token and finalize peak_gain
   * IMPORTANT: Recalculate peak_gain from price_history to catch any missed peaks
   */
  private async stopTracking(scannedTokenId: number): Promise<void> {
    const tracked = this.activeTracking.get(scannedTokenId);
    if (!tracked) {
      return;
    }
    
    clearInterval(tracked.timer);
    this.activeTracking.delete(scannedTokenId);
    
    // Final update to ensure peak_gain and peak_drawdown are saved
    // If peakGain is still -Infinity (no price checks succeeded), set to 0
    const inMemoryPeakGain = tracked.peakGain === -Infinity ? 0 : tracked.peakGain;
    // If peakDrawdown is still Infinity (no price checks succeeded), set to 0
    const inMemoryPeakDrawdown = tracked.peakDrawdown === Infinity ? 0 : tracked.peakDrawdown;
    
    logger.info(`📊 [TokenTracker] Stopping tracking for ${tracked.symbol} (ID: ${scannedTokenId}), in-memory peak gain: ${inMemoryPeakGain >= 0 ? '+' : ''}${inMemoryPeakGain.toFixed(2)}%, peak drawdown: ${inMemoryPeakDrawdown >= 0 ? '+' : ''}${inMemoryPeakDrawdown.toFixed(2)}%`);
    
    // Recalculate peak_gain and peak_drawdown from price_history to ensure we didn't miss any peaks/drawdowns
    // This is critical because:
    // 1. Price checks happen at intervals (might miss the exact peak/drawdown)
    // 2. Price caching can cause delays
    // 3. Price API might fail temporarily
    try {
      // Calculate tracking window from scan time (not from when tracking started)
      // This ensures we use the correct scan timestamp for peak gain/drawdown calculation
      const trackingStartTime = tracked.scanTime;
      const trackingEndTime = new Date(tracked.scanTime.getTime() + this.trackingDurationMinutes * 60 * 1000);
      
      logger.debug(`[DEBUG PEAK] Recalculating peak_gain and peak_drawdown for ${tracked.symbol} (ID: ${scannedTokenId}):`);
      logger.debug(`[DEBUG PEAK]   scanPrice: ${tracked.scanPrice}`);
      logger.debug(`[DEBUG PEAK]   trackingStartTime: ${trackingStartTime.toISOString()}`);
      logger.debug(`[DEBUG PEAK]   trackingEndTime: ${trackingEndTime.toISOString()}`);
      logger.debug(`[DEBUG PEAK]   in-memory peakGain: ${inMemoryPeakGain.toFixed(2)}%`);
      logger.debug(`[DEBUG PEAK]   in-memory peakDrawdown: ${inMemoryPeakDrawdown.toFixed(2)}%`);
      
      // Get max price for peak gain
      const maxResult = await query(`
        SELECT price_usd, timestamp
        FROM price_history
        WHERE token_address = $1
          AND chain = $2
          AND timestamp >= $3
          AND timestamp <= $4
        ORDER BY price_usd DESC
        LIMIT 1
      `, [tracked.tokenAddress, tracked.chain, trackingStartTime, trackingEndTime]);
      
      // Get min price for peak drawdown
      const minResult = await query(`
        SELECT price_usd, timestamp
        FROM price_history
        WHERE token_address = $1
          AND chain = $2
          AND timestamp >= $3
          AND timestamp <= $4
        ORDER BY price_usd ASC
        LIMIT 1
      `, [tracked.tokenAddress, tracked.chain, trackingStartTime, trackingEndTime]);
      
      if (maxResult.rows.length > 0 && minResult.rows.length > 0 && tracked.scanPrice > 0) {
        const maxPrice = parseFloat(maxResult.rows[0].price_usd);
        const minPrice = parseFloat(minResult.rows[0].price_usd);
        const recalculatedPeakGain = ((maxPrice - tracked.scanPrice) / tracked.scanPrice) * 100;
        const recalculatedPeakDrawdown = ((minPrice - tracked.scanPrice) / tracked.scanPrice) * 100;
        
        logger.debug(`[DEBUG PEAK]   maxPrice from history: ${maxPrice}`);
        logger.debug(`[DEBUG PEAK]   minPrice from history: ${minPrice}`);
        logger.debug(`[DEBUG PEAK]   recalculated peakGain: ${recalculatedPeakGain.toFixed(2)}%`);
        logger.debug(`[DEBUG PEAK]   recalculated peakDrawdown: ${recalculatedPeakDrawdown.toFixed(2)}%`);
        
        // Compare with in-memory values
        const gainDiff = Math.abs(recalculatedPeakGain - inMemoryPeakGain);
        const drawdownDiff = Math.abs(recalculatedPeakDrawdown - inMemoryPeakDrawdown);
        if (gainDiff > 0.01) {
          logger.warn(`[TokenTracker] Peak gain mismatch for ${tracked.symbol}: in-memory ${inMemoryPeakGain.toFixed(2)}%, from history ${recalculatedPeakGain.toFixed(2)}% (diff: ${gainDiff.toFixed(2)}%)`);
        }
        if (drawdownDiff > 0.01) {
          logger.warn(`[TokenTracker] Peak drawdown mismatch for ${tracked.symbol}: in-memory ${inMemoryPeakDrawdown.toFixed(2)}%, from history ${recalculatedPeakDrawdown.toFixed(2)}% (diff: ${drawdownDiff.toFixed(2)}%)`);
        }
        
        // Always use the recalculated values (more accurate)
        await query(`
          UPDATE scanned_tokens 
          SET peak_gain = $1, peak_drawdown = $2
          WHERE id = $3
        `, [recalculatedPeakGain, recalculatedPeakDrawdown, scannedTokenId]);
        
        logger.info(`📊 [TokenTracker] Stopped tracking ${tracked.symbol} (ID: ${scannedTokenId}) - Peak gain: ${recalculatedPeakGain >= 0 ? '+' : ''}${recalculatedPeakGain.toFixed(2)}%, Peak drawdown: ${recalculatedPeakDrawdown >= 0 ? '+' : ''}${recalculatedPeakDrawdown.toFixed(2)}% (recalculated from history)`);
      } else {
        // No price history found, use in-memory values
        logger.debug(`[DEBUG PEAK]   No price history found, keeping in-memory values`);
        
        await query(`
          UPDATE scanned_tokens 
          SET peak_gain = $1, peak_drawdown = $2
          WHERE id = $3
        `, [inMemoryPeakGain, inMemoryPeakDrawdown, scannedTokenId]);
        
        logger.info(`📊 [TokenTracker] Stopped tracking ${tracked.symbol} (ID: ${scannedTokenId}) - Peak gain: ${inMemoryPeakGain >= 0 ? '+' : ''}${inMemoryPeakGain.toFixed(2)}%, Peak drawdown: ${inMemoryPeakDrawdown >= 0 ? '+' : ''}${inMemoryPeakDrawdown.toFixed(2)}%`);
      }
    } catch (error) {
      logger.error(`[TokenTracker] Error recalculating peak_gain/peak_drawdown for ${tracked.symbol}:`, error);
      
      // Fallback to in-memory values
      await query(`
        UPDATE scanned_tokens 
        SET peak_gain = $1, peak_drawdown = $2
        WHERE id = $3
      `, [inMemoryPeakGain, inMemoryPeakDrawdown, scannedTokenId]);
      
      logger.info(`📊 [TokenTracker] Stopped tracking ${tracked.symbol} (ID: ${scannedTokenId}) - Peak gain: ${inMemoryPeakGain >= 0 ? '+' : ''}${inMemoryPeakGain.toFixed(2)}%, Peak drawdown: ${inMemoryPeakDrawdown >= 0 ? '+' : ''}${inMemoryPeakDrawdown.toFixed(2)}% (using in-memory values due to error)`);
    }
  }
  
  /**
   * Get number of currently tracked tokens
   */
  getActiveCount(): number {
    return this.activeTracking.size;
  }
  
  /**
   * Check if tracking is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
  
  /**
   * Initialize and recover tracking on service startup
   * - Resumes tracking for tokens still within tracking window
   * - Calculates peak_gain from price_history for tokens past tracking window
   */
  async initialize(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    
    // Ensure batch timer is running
    if (!this.batchTimer) {
      this.startBatchTimer();
    }
    
    logger.info('📊 Initializing Token Tracker - recovering tracking state...');
    
    // Find tokens that should be tracked but don't have peak_gain set
    const now = new Date();
    const trackingWindowMs = this.trackingDurationMinutes * 60 * 1000;
    
    // Build filter_stage condition based on tracking mode
    let filterStageCondition = '';
    if (this.trackingMode) {
      // Track only specific filter_stage
      filterStageCondition = `AND filter_stage = $${1}`;
    } else {
      // Track all filter_stages (but not NULL - those reached AI)
      filterStageCondition = `AND filter_stage IS NOT NULL`;
    }
    
    const params: any[] = [];
    if (this.trackingMode) {
      params.push(this.trackingMode);
    }
    
    // Find tokens that should be tracked
    const lookbackMinutes = this.trackingDurationMinutes + 10;
    const result = await query(`
      SELECT 
        st.id,
        st.token_address,
        st.symbol,
        st.chain,
        st.price_usd,
        st.filter_stage,
        st.created_at,
        s.timestamp as scan_timestamp,
        EXTRACT(EPOCH FROM (NOW() - s.timestamp)) * 1000 as age_ms_from_scan,
        EXTRACT(EPOCH FROM (st.created_at - s.timestamp)) * 1000 as delay_ms
      FROM scanned_tokens st
      INNER JOIN scans s ON s.id = st.scan_id
      WHERE st.price_usd IS NOT NULL
        AND st.peak_gain IS NULL
        ${filterStageCondition}
        AND s.timestamp >= NOW() - INTERVAL '${lookbackMinutes} minutes'
      ORDER BY s.timestamp DESC
    `, params);
    
    const tokensToRecover = result.rows;
    logger.info(`🔄 Found ${tokensToRecover.length} tokens to recover tracking for`);
    
    for (const token of tokensToRecover) {
      const scannedTokenId = token.id;
      const delayMs = Number(token.delay_ms || 0);
      const scanTimestamp = token.scan_timestamp ? new Date(token.scan_timestamp) : null;
      const createdAt = new Date(token.created_at);
      
      // Always use scan_timestamp for age calculation (not created_at)
      // This ensures we calculate peak gain from the correct scan time, not when the token was inserted
      if (!scanTimestamp) {
        logger.warn(`[DEBUG PEAK] Token ${token.symbol} (ID: ${scannedTokenId}) has no scan_timestamp, skipping`);
        continue;
      }
      
      const ageMs = Number(token.age_ms_from_scan);
      
      logger.debug(`[DEBUG PEAK] Token ${token.symbol} (ID: ${scannedTokenId}):`);
      logger.debug(`[DEBUG PEAK]   price_usd: ${token.price_usd}`);
      logger.debug(`[DEBUG PEAK]   created_at: ${createdAt.toISOString()}`);
      logger.debug(`[DEBUG PEAK]   scan_timestamp: ${scanTimestamp.toISOString()}`);
      logger.debug(`[DEBUG PEAK]   age_ms_from_scan: ${ageMs}ms (${(ageMs / 60000).toFixed(1)}min)`);
      logger.debug(`[DEBUG PEAK]   delay_ms: ${delayMs}ms (${(delayMs / 1000).toFixed(2)}s)`);
      
      if (ageMs < trackingWindowMs) {
        // Still within tracking window - resume tracking
        const scanPrice = parseFloat(token.price_usd);
        // Always use scan_timestamp (from scans table) for peak gain calculation
        logger.info(`🔄 Resuming tracking for ${token.symbol} (ID: ${scannedTokenId}, ${(ageMs / 60000).toFixed(1)}min old from scan)`);
        logger.debug(`[DEBUG PEAK]   Using scanPrice: ${scanPrice}, scanTime (scan_timestamp): ${scanTimestamp.toISOString()}`);
        await this.startTracking(
          scannedTokenId,
          token.token_address,
          token.symbol || token.token_address,
          token.chain,
          scanPrice,
          scanTimestamp
        );
      } else {
        // Past tracking window - calculate peak_gain from price_history
        const scanPrice = parseFloat(token.price_usd);
        // Always use scan_timestamp (from scans table) for peak gain calculation
        logger.info(`📊 Calculating peak_gain from price_history for ${token.symbol} (ID: ${scannedTokenId}, ${(ageMs / 60000).toFixed(1)}min old from scan)`);
        logger.debug(`[DEBUG PEAK]   Using scanPrice: ${scanPrice}, scanTime (scan_timestamp): ${scanTimestamp.toISOString()}`);
        if (scanTimestamp.getTime() !== createdAt.getTime()) {
          const timeDiff = (createdAt.getTime() - scanTimestamp.getTime()) / 1000;
          logger.debug(`[DEBUG PEAK]   Time difference: ${timeDiff.toFixed(2)}s (scan_timestamp is ${timeDiff > 0 ? 'earlier' : 'later'} than created_at)`);
        }
        await this.calculatePeakGainFromHistory(scannedTokenId, token.token_address, token.chain, scanPrice, scanTimestamp);
      }
    }
    
    logger.info('✅ Token Tracker initialization complete');
  }
  
  /**
   * Calculate peak_gain and peak_drawdown from existing price_history entries
   * Used for recovery when tracking window has passed
   */
  private async calculatePeakGainFromHistory(
    scannedTokenId: number,
    tokenAddress: string,
    chain: string,
    scanPrice: number,
    scanTime: Date
  ): Promise<void> {
    try {
      // Get max and min prices from price_history after scan time, within tracking window
      const trackingEndTime = new Date(scanTime.getTime() + this.trackingDurationMinutes * 60 * 1000);
      
      logger.debug(`[DEBUG PEAK] calculatePeakGainFromHistory called for token ${scannedTokenId}:`);
      logger.debug(`[DEBUG PEAK]   scanPrice: ${scanPrice}`);
      logger.debug(`[DEBUG PEAK]   scanTime: ${scanTime.toISOString()}`);
      logger.debug(`[DEBUG PEAK]   trackingEndTime: ${trackingEndTime.toISOString()}`);
      logger.debug(`[DEBUG PEAK]   timeWindow: ${this.trackingDurationMinutes} minutes`);
      
      // Get max price for peak gain
      const maxResult = await query(`
        SELECT price_usd, timestamp
        FROM price_history
        WHERE token_address = $1
          AND chain = $2
          AND timestamp >= $3
          AND timestamp <= $4
        ORDER BY price_usd DESC
        LIMIT 1
      `, [tokenAddress, chain, scanTime, trackingEndTime]);
      
      // Get min price for peak drawdown
      const minResult = await query(`
        SELECT price_usd, timestamp
        FROM price_history
        WHERE token_address = $1
          AND chain = $2
          AND timestamp >= $3
          AND timestamp <= $4
        ORDER BY price_usd ASC
        LIMIT 1
      `, [tokenAddress, chain, scanTime, trackingEndTime]);
      
      const maxPriceRow = maxResult.rows[0];
      const minPriceRow = minResult.rows[0];
      const maxPrice = maxPriceRow?.price_usd;
      const minPrice = minPriceRow?.price_usd;
      
      logger.debug(`[DEBUG PEAK]   maxPrice found: ${maxPrice || 'null'}`);
      logger.debug(`[DEBUG PEAK]   minPrice found: ${minPrice || 'null'}`);
      logger.debug(`[DEBUG PEAK]   price_history rows checked: max=${maxResult.rows.length}, min=${minResult.rows.length}`);
      
      if (maxPrice && minPrice && scanPrice > 0) {
        const peakGain = ((maxPrice - scanPrice) / scanPrice) * 100;
        const peakDrawdown = ((minPrice - scanPrice) / scanPrice) * 100;
        
        logger.debug(`[DEBUG PEAK]   calculated peakGain: ${peakGain.toFixed(2)}% = ((${maxPrice} - ${scanPrice}) / ${scanPrice}) * 100`);
        logger.debug(`[DEBUG PEAK]   calculated peakDrawdown: ${peakDrawdown.toFixed(2)}% = ((${minPrice} - ${scanPrice}) / ${scanPrice}) * 100`);
        
        // Update peak_gain and peak_drawdown in database
        await query(`
          UPDATE scanned_tokens 
          SET peak_gain = $1, peak_drawdown = $2
          WHERE id = $3
        `, [peakGain, peakDrawdown, scannedTokenId]);
        
        logger.info(`📊 [TokenTracker] Calculated peak_gain for token ${scannedTokenId}: ${peakGain >= 0 ? '+' : ''}${peakGain.toFixed(2)}%, peak_drawdown: ${peakDrawdown >= 0 ? '+' : ''}${peakDrawdown.toFixed(2)}% (from price_history)`);
      } else {
        // No price history or no gain - set to 0 or negative
        const currentGain = maxPrice ? ((maxPrice - scanPrice) / scanPrice) * 100 : 0;
        const currentDrawdown = minPrice ? ((minPrice - scanPrice) / scanPrice) * 100 : 0;
        
        logger.debug(`[DEBUG PEAK]   calculated currentGain: ${currentGain.toFixed(2)}% (no price history or no gain)`);
        logger.debug(`[DEBUG PEAK]   calculated currentDrawdown: ${currentDrawdown.toFixed(2)}% (no price history or no drawdown)`);
        
        await query(`
          UPDATE scanned_tokens 
          SET peak_gain = $1, peak_drawdown = $2
          WHERE id = $3
        `, [currentGain, currentDrawdown, scannedTokenId]);
        
        logger.info(`📊 [TokenTracker] Calculated peak_gain for token ${scannedTokenId}: ${currentGain >= 0 ? '+' : ''}${currentGain.toFixed(2)}%, peak_drawdown: ${currentDrawdown >= 0 ? '+' : ''}${currentDrawdown.toFixed(2)}% (no price history or no gain/drawdown)`);
      }
    } catch (error) {
      logger.error(`[TokenTracker] Error calculating peak_gain/peak_drawdown from history for token ${scannedTokenId}:`, error);
    }
  }
  
  /**
   * Clean up on shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('🛑 Shutting down Token Tracker...');
    
    // Stop batch timer
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    
    // Stop all active tracking
    for (const [scannedTokenId, tracked] of this.activeTracking.entries()) {
      clearInterval(tracked.timer);
      // Finalize peak_gain and peak_drawdown (handle -Infinity/Infinity cases)
      const finalPeakGain = tracked.peakGain === -Infinity ? 0 : tracked.peakGain;
      const finalPeakDrawdown = tracked.peakDrawdown === Infinity ? 0 : tracked.peakDrawdown;
      
      // Update peak_gain and peak_drawdown
      await query(`
        UPDATE scanned_tokens 
        SET peak_gain = $1, peak_drawdown = $2
        WHERE id = $3
      `, [finalPeakGain, finalPeakDrawdown, scannedTokenId]);
    }
    
    this.activeTracking.clear();
    logger.info('✅ Token Tracker shut down');
  }
}

// Singleton instance
export const tokenTracker = new TokenTracker();

