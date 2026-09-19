/**
 * Watchlist Manager
 * 
 * Implements a 2-minute observation window before trade execution:
 * 1. Sonnet AI signals BUY → Add to watchlist (don't execute yet)
 * 2. Monitor price every 30s for 2 minutes
 * 3. Apply pre-filter to skip obvious losers (saves Haiku cost)
 * 4. Call Haiku AI for re-check → Execute or Skip
 * 
 * This strategy filters out bad trades while minimizing AI costs.
 */

import { query } from '../infra/database';
import { logger } from '../utils/logger';
import Anthropic from '@anthropic-ai/sdk';

export interface WatchlistConfig {
  enabled: boolean;
  useHaiku: boolean;                    // NEW: Toggle Haiku re-check
  observationSeconds: number;
  priceCheckInterval: number;
  skipDumpThreshold: number;        // e.g., -15
  skipNoMomentumThreshold: number;  // e.g., 5
  recoveryThreshold: number;        // e.g., 5
}

export interface WatchlistEntry {
  id: number;
  token_address: string;
  chain: string;
  symbol: string;
  decision_id: number;
  signal_price: number;
  signal_timestamp: Date;
  max_price_reached: number | null;
  max_gain_percent: number | null;
  min_price_reached: number | null;
  max_dump_percent: number | null;
  status: 'monitoring' | 'executed' | 'skipped';
  skip_reason: string | null;
  executed_at: Date | null;
  executed_price: number | null;
  haiku_checked: boolean;
  haiku_analysis: string | null;
  haiku_decision: 'BUY' | 'SKIP' | null;
}

export interface PriceAction {
  currentPrice: number;
  currentGain: number;
  maxPrice: number;
  maxGain: number;
  minPrice: number;
  maxDump: number;
}

interface TokenData {
  address: string;
  chain: string;
  symbol: string;
  price: number;
}

interface Decision {
  id: number;
  reasoning: string;
  confidence: number;
  opportunities: string[];
  risks: string[];
  warnings: string[];
  discoveredByBots?: string[];  // Bot performance tracking
  primaryBot?: string;           // Bot performance tracking
}

export class WatchlistManager {
  private config: WatchlistConfig;
  private anthropic: Anthropic | null = null;  // Now optional
  private monitoringTimers: Map<number, NodeJS.Timeout> = new Map();
  private priceSamples: Map<number, Array<{timestamp: number, price: number}>> = new Map();
  
  // Callback for fetching current price (injected dependency)
  private fetchPrice: (tokenAddress: string, chain: string) => Promise<number>;
  
  // Callback for executing trade (injected dependency)
  private executeTrade: (entry: WatchlistEntry, price: number) => Promise<void>;

  constructor(
    config: WatchlistConfig,
    anthropicApiKey: string | null,  // Now optional
    fetchPrice: (tokenAddress: string, chain: string) => Promise<number>,
    executeTrade: (entry: WatchlistEntry, price: number) => Promise<void>
  ) {
    this.config = config;
    
    // Only initialize Anthropic if Haiku is enabled
    if (config.useHaiku && anthropicApiKey) {
      this.anthropic = new Anthropic({ apiKey: anthropicApiKey });
      logger.info('✅ Watchlist Haiku re-check enabled');
    } else if (config.useHaiku && !anthropicApiKey) {
      logger.warn('⚠️  Haiku enabled but no API key - will skip Haiku checks');
    } else {
      logger.info('ℹ️  Watchlist Haiku re-check disabled (using pre-filters only)');
    }
    
    this.fetchPrice = fetchPrice;
    this.executeTrade = executeTrade;
  }

  /**
   * Initialize watchlist manager - recover any monitoring entries from DB
   * Called on service startup to resume monitoring after redeploy
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('📊 Watchlist disabled');
      return;
    }

    logger.info('📊 Initializing Watchlist Manager...');

    // Load active watchlist entries from DB
    // Recover entries from last 30 minutes (in case service was down)
    const result = await query(`
      SELECT * FROM watchlist_entries 
      WHERE status = 'monitoring'
      AND signal_timestamp >= NOW() - INTERVAL '30 minutes'
      ORDER BY signal_timestamp ASC
    `);

    const activeEntries = result.rows as WatchlistEntry[];
    logger.info(`🔄 Recovered ${activeEntries.length} active watchlist entries from DB`);

    // Also check for stuck entries (monitoring for more than 5 minutes - should be done by now)
    const stuckResult = await query(`
      SELECT * FROM watchlist_entries 
      WHERE status = 'monitoring'
      AND signal_timestamp < NOW() - INTERVAL '5 minutes'
      ORDER BY signal_timestamp ASC
    `);

    if (stuckResult.rows.length > 0) {
      logger.warn(`⚠️  Found ${stuckResult.rows.length} stuck watchlist entries (monitoring > 5 minutes)`);
      for (const stuckEntry of stuckResult.rows) {
        const elapsedMinutes = (Date.now() - new Date(stuckEntry.signal_timestamp).getTime()) / 60000;
        logger.warn(`   - Entry ${stuckEntry.id} (${stuckEntry.symbol}): monitoring for ${elapsedMinutes.toFixed(1)} minutes - processing now`);
        // Process stuck entries immediately
        await this.checkEntry(stuckEntry.id);
      }
    }

    // Resume monitoring each entry
    for (const entry of activeEntries) {
      await this.resumeMonitoring(entry);
    }

    logger.info('✅ Watchlist Manager initialized');
  }

  /**
   * Resume monitoring an entry after restart/redeploy
   */
  private async resumeMonitoring(entry: WatchlistEntry): Promise<void> {
    const elapsed = Date.now() - new Date(entry.signal_timestamp).getTime();
    const remaining = this.config.observationSeconds * 1000 - elapsed;

    if (remaining <= 0) {
      // Observation window already passed - check now
      logger.info(`⏰ Entry ${entry.id} (${entry.symbol}) observation complete - checking now`);
      await this.checkEntry(entry.id);
    } else {
      // Continue monitoring
      const nextCheckIn = Math.min(remaining, this.config.priceCheckInterval * 1000);
      logger.info(`🔄 Resuming monitoring for ${entry.symbol} (${(remaining / 1000).toFixed(0)}s remaining)`);
      this.scheduleNextCheck(entry.id, nextCheckIn);
    }
  }

  
  /**
   * Pre-filter for immediate check (simplified - no price samples needed)
   */
  private applyPreFilterImmediate(priceAction: PriceAction): { skip: boolean; reason: string } {
    // Rule 1: Dumped hard with no recovery
    if (
      priceAction.maxDump <= this.config.skipDumpThreshold &&
      priceAction.maxGain < this.config.recoveryThreshold
    ) {
      return { skip: true, reason: 'dump_no_recovery' };
    }

    // Rule 2: No momentum (flat or down)
    if (priceAction.maxGain < this.config.skipNoMomentumThreshold) {
      return { skip: true, reason: 'no_momentum' };
    }

    // Passed filter
    return { skip: false, reason: '' };
  }

  /**
   * Add a new token to watchlist (called when Sonnet signals BUY)
   * Handles both immediate (observationSeconds=0) and delayed modes
   */
  async addToWatchlist(
    token: TokenData,
    decision: Decision
  ): Promise<void> {
    if (!this.config.enabled) {
      // Watchlist disabled - execute immediately (fallback to old behavior)
      logger.info(`⚠️  Watchlist disabled - would execute ${token.symbol} immediately`);
      return;
    }

    try {
      // Check if token is already being monitored
      const existingCheck = await query(`
        SELECT id, status FROM watchlist_entries 
        WHERE token_address = $1 AND chain = $2 AND status = 'monitoring'
      `, [token.address, token.chain]);
      
      if (existingCheck.rows.length > 0) {
        logger.info(`⏭️  ${token.symbol} already on watchlist (ID: ${existingCheck.rows[0].id}), skipping`);
        return;
      }
      
      // Insert into DB
      const result = await query(`
        INSERT INTO watchlist_entries (
          token_address, chain, symbol,
          decision_id,
          signal_price, signal_timestamp,
          max_price_reached, max_gain_percent,
          min_price_reached, max_dump_percent,
          status
        ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, 0, $7, 0, 'monitoring')
        RETURNING id
      `, [
        token.address,      // $1
        token.chain,        // $2
        token.symbol,       // $3
        decision.id,        // $4
        token.price,        // $5
        token.price,        // $6 - max_price_reached (initial = signal price)
        token.price,        // $7 - min_price_reached (initial = signal price)
      ]);

      const entryId = result.rows[0].id;
      logger.info(`📝 Added ${token.symbol} to watchlist (ID: ${entryId}) at $${token.price}`);

      // Capture Sample 0: Initial price (before Sonnet)
      this.priceSamples.set(entryId, [{
        timestamp: Date.now(),
        price: token.price,
      }]);
      logger.info(`📊 Sample 0 captured (before Sonnet): $${token.price.toFixed(8)}`);

      // Immediately fetch Sample 1: Current price (when Sonnet responds)
      const currentPrice = await this.fetchPrice(token.address, token.chain);
      this.priceSamples.get(entryId)!.push({
        timestamp: Date.now(),
        price: currentPrice,
      });
      logger.info(`📊 Sample 1 captured (Sonnet responded): $${currentPrice.toFixed(8)}`);

      // Update DB stats with Sample 1 price
      const entry = await this.getEntry(entryId);
      if (entry) {
        await this.updatePriceStats(entryId, entry, currentPrice);
      }

      // Check if immediate mode (observationSeconds = 0)
      if (this.config.observationSeconds === 0) {
        logger.info(`⚡ Immediate mode enabled - checking ${token.symbol} with Haiku now...`);
        await this.checkEntry(entryId);
        return;
      }

      // Start monitoring - next check in priceCheckInterval for Sample 2
      logger.info(`⏱️  Observation mode - will monitor ${token.symbol} for ${this.config.observationSeconds}s`);
      this.scheduleNextCheck(entryId, this.config.priceCheckInterval * 1000);
    } catch (error) {
      logger.error(`Failed to add ${token.symbol} to watchlist:`, error);
      throw error;
    }
  }

  /**
   * Schedule next price check for an entry
   */
  private scheduleNextCheck(entryId: number, delayMs: number): void {
    // Clear existing timer if any
    const existingTimer = this.monitoringTimers.get(entryId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule next check
    const timer = setTimeout(async () => {
      await this.monitorEntry(entryId);
    }, delayMs);

    this.monitoringTimers.set(entryId, timer);
  }

  /**
   * Monitor an entry (check price, update stats, decide if observation complete)
   */
  private async monitorEntry(entryId: number): Promise<void> {
    try {
      const entry = await this.getEntry(entryId);
      if (!entry || entry.status !== 'monitoring') {
        this.monitoringTimers.delete(entryId);
        return;
      }

      // Check if observation window complete BEFORE capturing sample
      const elapsed = Date.now() - new Date(entry.signal_timestamp).getTime();
      
      if (elapsed >= this.config.observationSeconds * 1000) {
        // Time to decide! Don't capture another sample
        logger.info(`⏰ ${entry.symbol} observation complete (${(elapsed / 1000).toFixed(0)}s)`);
        await this.checkEntry(entryId);
        return;
      }

      // Fetch current price
      const currentPrice = await this.fetchPrice(entry.token_address, entry.chain);
      
      // Store price sample
      if (!this.priceSamples.has(entryId)) {
        this.priceSamples.set(entryId, []);
      }
      this.priceSamples.get(entryId)!.push({
        timestamp: Date.now(),
        price: currentPrice,
      });
      
      const sampleCount = this.priceSamples.get(entryId)!.length;
      logger.info(`💰 ${entry.symbol} price: $${currentPrice.toFixed(8)} (${sampleCount} samples collected)`);
      
      // Update price stats
      await this.updatePriceStats(entryId, entry, currentPrice);

      // Check if we have enough samples (5 total: initial + after AI + 3 scheduled)
      if (sampleCount >= 5) {
        // We have all samples - check immediately!
        logger.info(`⏰ ${entry.symbol} observation complete (${sampleCount} samples collected)`);
        await this.checkEntry(entryId);
        return;
      }

      // Continue monitoring
      this.scheduleNextCheck(entryId, this.config.priceCheckInterval * 1000);
    } catch (error) {
      logger.error(`Error monitoring entry ${entryId}:`, error);
      // Continue monitoring despite error
      this.scheduleNextCheck(entryId, this.config.priceCheckInterval * 1000);
    }
  }

  /**
   * Update price statistics for an entry
   */
  private async updatePriceStats(
    entryId: number,
    entry: WatchlistEntry,
    currentPrice: number
  ): Promise<void> {
    const gainPercent = ((currentPrice - entry.signal_price) / entry.signal_price) * 100;

    await query(`
      UPDATE watchlist_entries SET
        max_price_reached = GREATEST(COALESCE(max_price_reached, signal_price), $1),
        max_gain_percent = GREATEST(COALESCE(max_gain_percent, 0), $2),
        min_price_reached = LEAST(COALESCE(min_price_reached, signal_price), $3),
        max_dump_percent = LEAST(COALESCE(max_dump_percent, 0), $4),
        updated_at = NOW()
      WHERE id = $5
    `, [
      currentPrice,  // $1 - current price for max check
      gainPercent,   // $2 - current gain % for max check
      currentPrice,  // $3 - current price for min check
      gainPercent,   // $4 - current gain % for min check (can be negative = dump)
      entryId        // $5
    ]);
  }

  /**
   * Make final decision on an entry after observation window
   */
  private async checkEntry(entryId: number): Promise<void> {
    let entry: (WatchlistEntry & { sonnet_analysis?: string; sonnet_confidence?: number }) | null = null;
    try {
      entry = await this.getEntry(entryId);
      if (!entry || entry.status !== 'monitoring') {
        return;
      }

      // Get current price
      const currentPrice = await this.fetchPrice(entry.token_address, entry.chain);
      
      // Get price action summary
      const priceAction = this.getPriceAction(entry, currentPrice);

      logger.info(`📊 ${entry.symbol} price action: max +${priceAction.maxGain.toFixed(1)}%, dump ${priceAction.maxDump.toFixed(1)}%, current ${priceAction.currentGain.toFixed(1)}%`);

      // Apply pre-filter (always enabled)
      const filterResult = this.applyPreFilter(entry, priceAction);
      
      if (filterResult.skip) {
        logger.info(`⏭️  Skip ${entry.symbol}: ${filterResult.reason}`);
        await this.skipEntry(entryId, filterResult.reason);
        this.monitoringTimers.delete(entryId);
        this.priceSamples.delete(entryId); // Clean up samples
        return;
      }

      // Haiku re-check (if enabled)
      if (this.config.useHaiku && this.anthropic) {
        logger.info(`🤖 Asking Haiku about ${entry.symbol}...`);
        const priceSamples = this.priceSamples.get(entryId) || [];
        logger.info(`   Price samples: ${priceSamples.length} collected over ${this.config.observationSeconds}s`);
        
        const haikuStartTime = Date.now();
        const haikuDecision = await this.checkWithHaiku(entry, priceAction, priceSamples);
        const haikuDuration = Date.now() - haikuStartTime;
        
        logger.info(`🤖 Haiku responded in ${haikuDuration}ms: ${haikuDecision.action} - ${haikuDecision.reasoning}`);

        // Store Haiku decision
        await query(`
          UPDATE watchlist_entries SET
            haiku_checked = true,
            haiku_analysis = $1,
            haiku_decision = $2,
            updated_at = NOW()
          WHERE id = $3
        `, [
          haikuDecision.reasoning,
          haikuDecision.action,
          entryId
        ]);

        if (haikuDecision.action === 'SKIP') {
          logger.info(`🤖 Haiku says SKIP: ${haikuDecision.reasoning}`);
          await this.skipEntry(entryId, `haiku_skip: ${haikuDecision.reasoning}`);
          this.monitoringTimers.delete(entryId);
          this.priceSamples.delete(entryId); // Clean up samples
          return;
        }
        
        logger.info(`🤖 Haiku confirmed BUY - proceeding to execute`);
      } else {
        logger.info(`✅ Pre-filter passed - proceeding to execute (Haiku disabled)`);
      }

      // Execute trade
      await this.executeEntry(entryId, entry, currentPrice);

      this.monitoringTimers.delete(entryId);
      this.priceSamples.delete(entryId); // Clean up samples
    } catch (error) {
      logger.error(`❌ Error checking entry ${entryId}:`);
      logger.error(`   Token: ${entry?.symbol || 'unknown'}`);
      logger.error(`   Signal price: $${entry?.signal_price || 'N/A'}`);
      logger.error(`   Samples collected: ${this.priceSamples.get(entryId)?.length || 0}`);
      logger.error(`   Error:`, error);
      // Mark as skipped on error
      await this.skipEntry(entryId, 'error');
      this.monitoringTimers.delete(entryId);
      this.priceSamples.delete(entryId); // Clean up samples
    }
  }

  /**
   * Apply pre-filter rules to skip obvious losers
   * Always enabled - uses Haiku model for re-check
   */
  private applyPreFilter(entry: WatchlistEntry, priceAction: PriceAction): { skip: boolean; reason: string } {
    // Rule 1: Dumped hard with no recovery
    if (
      priceAction.maxDump <= this.config.skipDumpThreshold &&
      priceAction.maxGain < this.config.recoveryThreshold
    ) {
      return { skip: true, reason: 'dump_no_recovery' };
    }

    // Rule 2: No momentum (flat or down)
    if (priceAction.maxGain < this.config.skipNoMomentumThreshold) {
      return { skip: true, reason: 'no_momentum' };
    }

    // Passed filter
    return { skip: false, reason: '' };
  }

  /**
   * Call Haiku AI for re-check
   */
  private async checkWithHaiku(
    entry: WatchlistEntry & { sonnet_analysis?: string; sonnet_confidence?: number },
    priceAction: PriceAction,
    priceSamples: Array<{timestamp: number, price: number}>
  ): Promise<{ action: 'BUY' | 'SKIP'; reasoning: string }> {
    if (!this.anthropic) {
      // Fallback if Haiku not available
      return { action: 'BUY', reasoning: 'Haiku unavailable, proceeding with pre-filter result' };
    }
    
    // Format price bars for Haiku - show absolute prices and % change from first sample
    const firstPrice = priceSamples[0].price;
    const formattedBars = priceSamples.map((s, idx) => {
      const changeFromFirst = ((s.price - firstPrice) / firstPrice) * 100;
      const timeLabels = ['Initial', '+1m', '+90s', '+120s', '+150s'];
      const timeLabel = timeLabels[idx] || `+${idx * 30}s`;
      
      if (idx === 0) {
        // First sample - no % change needed
        return `  ${timeLabel}: $${s.price.toFixed(8)}`;
      } else {
        // Subsequent samples - show % change from initial
        const changeStr = changeFromFirst >= 0 ? `+${changeFromFirst.toFixed(1)}%` : `${changeFromFirst.toFixed(1)}%`;
        return `  ${timeLabel}: $${s.price.toFixed(8)} (${changeStr})`;
      }
    }).join('\n');
    
    const prompt = `You are a momentum re-validator. Our main AI recommended this token ~1-2 minutes ago. Here's what happened since. Should we enter NOW?

**PRICE MOVEMENT (2 samples over ~1-2 minutes):**
${formattedBars}

**SUMMARY:**
- Started at: $${firstPrice.toFixed(8)}
- Current: $${priceAction.currentPrice.toFixed(8)} (${priceAction.currentGain > 0 ? '+' : ''}${priceAction.currentGain.toFixed(1)}% from initial)
- Peak: $${priceAction.maxPrice.toFixed(8)} (+${priceAction.maxGain.toFixed(1)}% from initial)
- Lowest: $${priceAction.minPrice.toFixed(8)} (${priceAction.maxDump.toFixed(1)}% from initial)

**ORIGINAL AI ANALYSIS:**
${entry.sonnet_analysis || 'N/A'}
Confidence: ${entry.sonnet_confidence || 'N/A'}%

**YOUR TASK:**
Based on price action + original analysis, should we enter at $${priceAction.currentPrice.toFixed(8)}?

**BUY** if:
- Original analysis still valid

**SKIP** if: 
- Price decreased significantly

Respond ONLY in this JSON format (no markdown, no extra text):
{
  "action": "BUY" or "SKIP",
  "reasoning": "One concise sentence explaining why"
}`;

    try {
      // Always use Haiku model (fast and cheap)
      const model = 'claude-3-5-haiku-20241022';

      logger.info(`📝 Haiku prompt for ${entry.symbol}:`);
      logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      logger.info(prompt);
      logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      const response = await this.anthropic.messages.create({
        model,
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Anthropic');
      }

      logger.info(`📝 Haiku raw response for ${entry.symbol}:`);
      logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      logger.info(content.text);
      logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      // Parse JSON response
      const jsonMatch = content.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`No JSON found in response: ${content.text}`);
      }

      const decision = JSON.parse(jsonMatch[0]);
      
      logger.info(`🤖 Haiku parsed decision for ${entry.symbol}: ${decision.action} - ${decision.reasoning}`);
      
      return {
        action: decision.action,
        reasoning: decision.reasoning || 'No reasoning provided'
      };
    } catch (error) {
      logger.error(`Error calling Haiku for ${entry.symbol}:`, error);
      logger.error(`   Signal price: $${entry.signal_price}`);
      logger.error(`   Current price: $${priceAction.currentPrice}`);
      logger.error(`   Samples count: ${priceSamples.length}`);
      // Default to SKIP on error (safer)
      return {
        action: 'SKIP',
        reasoning: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Mark entry as skipped
   */
  private async skipEntry(entryId: number, reason: string): Promise<void> {
    await query(`
      UPDATE watchlist_entries SET
        status = 'skipped',
        skip_reason = $1,
        updated_at = NOW()
      WHERE id = $2
    `, [reason, entryId]);
  }

  /**
   * Execute trade for entry
   */
  private async executeEntry(entryId: number, entry: WatchlistEntry, price: number): Promise<void> {
    await query(`
      UPDATE watchlist_entries SET
        status = 'executed',
        executed_at = NOW(),
        executed_price = $1,
        updated_at = NOW()
      WHERE id = $2
    `, [price, entryId]);

    logger.info(`📤 Executing trade for ${entry.symbol} at $${price}`);
    
    // Call injected executeTrade callback
    await this.executeTrade(entry, price);
    
    logger.success(`✅ Trade executed successfully for ${entry.symbol}`);
  }

  /**
   * Get entry from DB (with decision data via JOIN)
   */
  private async getEntry(entryId: number): Promise<(WatchlistEntry & { sonnet_analysis?: string; sonnet_confidence?: number }) | null> {
    const result = await query(`
      SELECT 
        w.*,
        d.reasoning as sonnet_analysis,
        d.confidence as sonnet_confidence
      FROM watchlist_entries w
      LEFT JOIN decisions d ON d.id = w.decision_id
      WHERE w.id = $1
    `, [entryId]);

    return result.rows[0] || null;
  }

  /**
   * Get price action summary including individual samples
   */
  private getPriceAction(entry: WatchlistEntry, currentPrice: number): PriceAction {
    const currentGain = ((currentPrice - entry.signal_price) / entry.signal_price) * 100;

    return {
      currentPrice,
      currentGain,
      maxPrice: entry.max_price_reached || entry.signal_price,
      maxGain: entry.max_gain_percent || 0,
      minPrice: entry.min_price_reached || entry.signal_price,
      maxDump: entry.max_dump_percent || 0,
    };
  }

  /**
   * Clean up on shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('🛑 Shutting down Watchlist Manager...');
    
    // Clear all timers
    for (const [entryId, timer] of this.monitoringTimers.entries()) {
      clearTimeout(timer);
      logger.info(`  Cleared timer for entry ${entryId}`);
    }
    
    this.monitoringTimers.clear();
    this.priceSamples.clear();
    logger.info('✅ Watchlist Manager shut down');
  }
}

