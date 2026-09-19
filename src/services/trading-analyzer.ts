/**
 * Unified Trading Analyzer
 * 
 * Single AI call that:
 * - Analyzes all tokens from scanner
 * - Checks security
 * - Gathers price action, volume, wallet data
 * - Returns direct BUY/SKIP decisions
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';
import type { ScanResult } from '../utils/scanner';
import type { SecurityAnalysis } from './contract-security-scanner';
import { ContractSecurityScanner } from './contract-security-scanner';
import { SolanaSecurityScanner, type SolanaSecurityAnalysis } from './solana/security-scanner';
import type { SolanaToken } from './solana/scanner';
import { Chain, getChainConfig, getCurrentChain } from '../config/chain';

// Import data gatherers
import { VolumeAnalyzer } from './data-gatherers/volume-analyzer';
import { PriceActionAnalyzer } from './data-gatherers/price-action-analyzer';
// import { LiquidityDepthAnalyzer } from './data-gatherers/liquidity-depth-analyzer'; // Disabled

// Import decision logger
import { DecisionLogger } from './decision-logger';
import type { DecisionLog } from './decision-logger';
import { scanLogger } from './scan-logger';
import { scannedTokensLogger } from './scanned-tokens-logger';
import { query } from '../infra/database';

// Import point-based analyzer V3 (signal-focused)
import { PointBasedAnalyzerV3 } from './point-based-analyzer-v3';

// Import ML prediction client
import { MLPredictionClient, type TokenFeatures } from './ml-prediction-client';

// Import strategy config
import { getStrategyId } from '../config/strategy';

// ============================================================================
// Types
// ============================================================================

export interface TradingDecision {
  token: string;
  symbol: string;
  name: string;
  
  // Decision
  shouldBuy: boolean;
  confidence: number;        // 0-100
  reasoning: string;
  
  // ML Prediction Metrics (for analytics and position sizing)
  mlPredictedReturn?: number;   // E[R|win] - predicted return if trade wins (%)
  mlExpectedValue?: number;      // P(win) × E[R|win] - expected value used for position sizing (%)
  
  // Strategy (if shouldBuy = true)
  positionSize?: {
    percentage: number;      // % of wallet
    maxUsdAmount: number;
  };
  
  riskManagement?: {
    stopLoss: number;        // %
    takeProfitLevels: Array<{
      percentage: number;
      sellPercent: number;
    }>;
  };
  
  // Analysis
  opportunities: string[];
  risks: string[];
  warnings: string[];
  
  // Raw data (for display)
  marketData: {
    price: number;
    marketCap: number;
    liquidity: number;
    volume24h: number;
    buys: number;            // DexScreener (5min) if available, else bot-tracked (15min)
    sells: number;           // DexScreener (5min) if available, else bot-tracked (15min)
    users: number;
    buyVsSellRatio?: number; // Buy/sell ratio from DexScreener
  };
  
  securityAnalysis?: SecurityAnalysis;
  
  // Bot Discovery (for performance tracking)
  discoveredByBots?: string[];  // Array of bot names that found this token
  primaryBot?: string;          // Primary bot (first in array)
}

export interface TradingAnalysis {
  decisions: TradingDecision[];
  summary: string;
  timestamp: number;
}

// ============================================================================
// Hard Stop Filters
// ============================================================================

const HARD_STOPS = {
  // Market filters
  // SOL-denominated liquidity threshold (stable across SOL price changes)
  // 79 SOL = pump.fun graduation amount (bonding curve completion)
  // Falls back to USD threshold if SOL price unavailable
  MIN_LIQUIDITY_SOL: parseFloat(process.env.HARD_STOP_MIN_LIQUIDITY_SOL || '79'),
  MIN_LIQUIDITY_USD: parseInt(process.env.HARD_STOP_MIN_LIQUIDITY || '10000', 10),
  MIN_VOLUME_5M: parseInt(process.env.HARD_STOP_MIN_VOLUME_5M || '50', 10),
  MIN_UNIQUE_USERS: parseInt(process.env.MIN_UNIQUE_USERS || '2', 10),
  MIN_TOTAL_TRADES: parseInt(process.env.MIN_TOTAL_TRADES || '3', 10),
  
  // Price Pump Filter - RE-ENABLED based on backtest results
  // Blocks very young tokens (< 2h) that already pumped hard (> 150% in 1h)
  // MATCHES: token_filters.py PRICE_PUMP_FILTER['enabled'] = True
  PRICE_PUMP_ENABLED: process.env.PRICE_PUMP_FILTER_ENABLED !== 'false', // ENABLED by default (matches Python)
  PRICE_PUMP_AGE_HOURS_THRESHOLD: parseFloat(process.env.PRICE_PUMP_AGE_HOURS_THRESHOLD || '2.0'),
  PRICE_PUMP_PRICE_CHANGE_1H_THRESHOLD: parseFloat(process.env.PRICE_PUMP_PRICE_CHANGE_1H_THRESHOLD || '150.0'),
  
  // Young Pump Filter - RE-ENABLED based on backtest results
  // Blocks very young tokens (< 30 min) that already pumped hard (> 100% in 1h)
  // MATCHES: token_filters.py YOUNG_PUMP_FILTER['enabled'] = True
  YOUNG_PUMP_ENABLED: process.env.YOUNG_PUMP_FILTER_ENABLED !== 'false', // ENABLED by default (matches Python)
  YOUNG_PUMP_AGE_HOURS_MAX: parseFloat(process.env.YOUNG_PUMP_AGE_HOURS_MAX || '0.5'),
  YOUNG_PUMP_PRICE_CHANGE_1H_MIN: parseFloat(process.env.YOUNG_PUMP_PRICE_CHANGE_1H_MIN || '100.0'),
  
  // Birth Spike Filter - Catches tokens that spiked massively at birth but cooled down by scan time
  // Pattern: Very young token (< 3h) with extreme 24h gain (> 1000%)
  // MATCHES: backtest_filters.yaml "Birth Spike" filter
  BIRTH_SPIKE_ENABLED: process.env.BIRTH_SPIKE_FILTER_ENABLED !== 'false', // ENABLED by default
  BIRTH_SPIKE_AGE_HOURS_MAX: parseFloat(process.env.BIRTH_SPIKE_AGE_HOURS_MAX || '3.0'), // Block if age < 3h
  BIRTH_SPIKE_PRICE_CHANGE_24H_MIN: parseFloat(process.env.BIRTH_SPIKE_PRICE_CHANGE_24H_MIN || '1000.0'), // AND price_change_24h >= 1000%
  
  // High Volume-to-Mcap Ratio Filter - GENERALIZED (Nov 2025 - Jan 2026)
  // Tokens with volume > 2.5x market cap are suspicious (artificial pump)
  // Full dataset analysis (85,678 samples): Threshold 2.5 blocks 89 tokens (0.10%), Mean return: -43.16%, Precision: 82.02%
  // Original threshold 3.0: Blocks 56 tokens (0.07%), Mean return: -37.46%, Precision: 78.57%
  // MATCHES: backtest_filters.yaml "High Vol/Mcap" filter (generalized)
  HIGH_VOL_MCAP_RATIO_ENABLED: process.env.HIGH_VOL_MCAP_RATIO_FILTER_ENABLED !== 'false', // ENABLED by default
  HIGH_VOL_MCAP_RATIO_THRESHOLD: parseFloat(process.env.HIGH_VOL_MCAP_RATIO_THRESHOLD || '2.5'), // Block if volume_5m / market_cap >= 2.5 (optimized from 3.0)
  
  // Young Honeypot Filter - GENERALIZED (Nov 2025 - Jan 2026)
  // Very young tokens (<30min) with significant price change (>=40%) are high risk
  // Full dataset analysis (85,678 samples): age<=0.5h AND price>=40% blocks 2,983 tokens (3.48%), Mean: -5.12%, Precision: 59.10%
  // Original (age<=1h AND price>=50%): Blocks 4,845 tokens (5.65%), Mean: -3.84%, Precision: 57.89%
  // MATCHES: backtest_filters.yaml "Young Honeypot" filter (generalized)
  YOUNG_HONEYPOT_ENABLED: process.env.YOUNG_HONEYPOT_FILTER_ENABLED !== 'false', // ENABLED by default
  YOUNG_HONEYPOT_AGE_HOURS_MAX: parseFloat(process.env.YOUNG_HONEYPOT_AGE_HOURS_MAX || '0.5'), // Block if age < 0.5h (optimized from 1.0h)
  YOUNG_HONEYPOT_PRICE_CHANGE_1H_MIN: parseFloat(process.env.YOUNG_HONEYPOT_PRICE_CHANGE_1H_MIN || '40.0'), // AND price_change_1h >= 40% (optimized from 50%)
  
  // Volume Anomaly Filter (matches ml-training/shared/token_filters.py)
  // Detect liquidity grab scams: very young tokens with extreme volume spikes
  // Pattern: $50K+ volume in 5min for token <30min old, with volume/age > $400K/hour
  // Analysis: Problem tokens had 371K-4.7M/hour, successful tokens median 94K/hour
  // Threshold lowered from 500K to 400K to catch all problem tokens
  VOLUME_ANOMALY_ENABLED: process.env.VOLUME_ANOMALY_FILTER_ENABLED !== 'false',
  VOLUME_ANOMALY_AGE_HOURS_MAX: parseFloat(process.env.VOLUME_ANOMALY_AGE_HOURS_MAX || '0.5'),
  VOLUME_ANOMALY_VOLUME_5M_MIN: parseFloat(process.env.VOLUME_ANOMALY_VOLUME_5M_MIN || '50000.0'),
  VOLUME_ANOMALY_VOLUME_PER_HOUR_THRESHOLD: parseFloat(process.env.VOLUME_ANOMALY_VOLUME_PER_HOUR_THRESHOLD || '400000.0'),
  
  // Legacy filter removed - redundant with Price Pump and Young Pump filters
  // Old: MAX_PRICE_CHANGE_1H (1000% for tokens < 1h) - too lenient, not used in ML training
  
  // Market cap: Now handled via scoring system (50-250k preferred), not a hard stop
  // This allows tracking all tokens for peak gain analysis
  // MIN_MARKET_CAP: Removed - using scoring instead
  // MAX_MARKET_CAP: Removed - using scoring instead
  
  // Security filters (specific checks, NOT risk score)
  // These are ABSOLUTE red lines - AI doesn't see these tokens
  // Risk score is passed to AI for evaluation
  
  // Axiom Trap Filter - Detects fake "liquidity trap" tokens
  // These tokens pump briefly then pull liquidity, causing stale prices in Codex
  // Pattern identified from 50+ confirmed trap tokens (Jan 2026):
  // - Single bot (total_bots_count = 1)
  // - Discovered by axiom specifically
  // - Very young (< 1h)
  // - High volume_5m ($200K-$400K) for very young token
  // - Tight liquidity range ($20K-$35K)
  // - Tight market_cap range ($25K-$40K)
  // - High price_change_1h (60-130%)
  // MATCHES: token_filters.py AXIOM_TRAP_FILTER['enabled'] = True
  AXIOM_TRAP_ENABLED: process.env.AXIOM_TRAP_FILTER_ENABLED !== 'false', // ENABLED by default
  AXIOM_TRAP_BOT_COUNT_MAX: parseInt(process.env.AXIOM_TRAP_BOT_COUNT_MAX || '1', 10),
  AXIOM_TRAP_DISCOVERED_BY_BOTS: (process.env.AXIOM_TRAP_DISCOVERED_BY_BOTS || 'axiom').split(',').map(s => s.trim().toLowerCase()),
  AXIOM_TRAP_AGE_HOURS_MAX: parseFloat(process.env.AXIOM_TRAP_AGE_HOURS_MAX || '1.0'),
  AXIOM_TRAP_VOLUME_5M_MIN: parseFloat(process.env.AXIOM_TRAP_VOLUME_5M_MIN || '200000.0'),
  AXIOM_TRAP_VOLUME_5M_MAX: parseFloat(process.env.AXIOM_TRAP_VOLUME_5M_MAX || '400000.0'),
  AXIOM_TRAP_LIQUIDITY_MIN: parseFloat(process.env.AXIOM_TRAP_LIQUIDITY_MIN || '20000.0'),
  AXIOM_TRAP_LIQUIDITY_MAX: parseFloat(process.env.AXIOM_TRAP_LIQUIDITY_MAX || '35000.0'),
  AXIOM_TRAP_MARKET_CAP_MIN: parseFloat(process.env.AXIOM_TRAP_MARKET_CAP_MIN || '25000.0'),
  AXIOM_TRAP_MARKET_CAP_MAX: parseFloat(process.env.AXIOM_TRAP_MARKET_CAP_MAX || '40000.0'),
  AXIOM_TRAP_PRICE_CHANGE_1H_MIN: parseFloat(process.env.AXIOM_TRAP_PRICE_CHANGE_1H_MIN || '60.0'),
  
  // Trap Detection Filter - DISABLED by default (matches Python token_filters.py)
  // Uses scoring system (0-9 points) to detect trap tokens
  // Can be enabled via TRAP_DETECTION_FILTER_ENABLED env var
  TRAP_DETECTION_ENABLED: process.env.TRAP_DETECTION_FILTER_ENABLED === 'true', // DISABLED by default (matches Python)
  TRAP_SUSPICION_THRESHOLD: parseInt(process.env.TRAP_SUSPICION_THRESHOLD || '4'), // Matches Python: 4
  
  // Young High Risk Filter - GROUND TRUTH OPTIMIZED (Jan 2026)
  // MATCHES: token_filters.py YOUNG_HIGH_RISK_FILTER (enabled=True)
  // Detects very young tokens (<1h) with high risk scores (>=50) — honeypot/trap pattern.
  // Shadow trading analysis: Blocked trades avg -39.6% real PnL, 23.8% win rate.
  // Catches 42.9% of exit_failed trades. Saves ~37% of total real losses.
  YOUNG_HIGH_RISK_ENABLED: process.env.YOUNG_HIGH_RISK_FILTER_ENABLED !== 'false', // ENABLED by default (matches Python)
  YOUNG_HIGH_RISK_RISK_SCORE_MIN: parseFloat(process.env.YOUNG_HIGH_RISK_RISK_SCORE_MIN || '50.0'),
  YOUNG_HIGH_RISK_AGE_HOURS_MAX: parseFloat(process.env.YOUNG_HIGH_RISK_AGE_HOURS_MAX || '1.0'),
  
  // Low Market Cap High Volume Filter - GROUND TRUTH OPTIMIZED (Jan 2026)
  // MATCHES: token_filters.py LOW_MCAP_HIGH_VOL_FILTER (enabled=True)
  // Detects tokens with low market cap (<$40K) but high volume (>=$50K) — artificial pump pattern.
  // Note: Uses FDV as fallback when market_cap is null.
  LOW_MCAP_HIGH_VOL_ENABLED: process.env.LOW_MCAP_HIGH_VOL_FILTER_ENABLED !== 'false', // ENABLED by default (matches Python)
  LOW_MCAP_HIGH_VOL_MARKET_CAP_MAX: parseFloat(process.env.LOW_MCAP_HIGH_VOL_MARKET_CAP_MAX || '40000.0'),
  LOW_MCAP_HIGH_VOL_VOLUME_5M_MIN: parseFloat(process.env.LOW_MCAP_HIGH_VOL_VOLUME_5M_MIN || '50000.0'),
  
  // Previously Blocked Filter - tokens blocked by these filters are PERMANENTLY blocked
  // Based on data analysis: these filter stages indicate permanent issues that don't "heal" over time
  // 
  // NOTE: trap_filter removed - analysis shows tokens can "heal" (1375 scans show tokens as non-trap after trap_filter)
  // trap_filter pattern (pump pattern) changes over time, so it's not truly permanent
  // Use trap_detection filter (real-time) instead, which is already in backtest
  // 
  // Currently empty - no filters are truly permanent (all patterns can change over time)
  // If needed in future, only include filters where pattern NEVER changes
  // 
  // EXCLUDED:
  // - trap_filter: Pattern changes over time (tokens can heal) - use real-time trap_detection instead
  // - axiom_trap: Replaced by YOUNG_HIGH_RISK + LOW_MCAP_HIGH_VOL permanent filters
  // - volume_anomaly: Removed from permanent filters (matches Python)
  // - security_hardstop: Security checks (honeypot, blacklist, etc.) run EVERY scan anyway
  //   If it's a real scam, it will be blocked every time. No need to cache.
  //   Including it causes false positives from transient API failures.
  PREVIOUSLY_BLOCKED_ENABLED: process.env.PREVIOUSLY_BLOCKED_FILTER_ENABLED !== 'false',
  PREVIOUSLY_BLOCKED_FILTERS: (process.env.PREVIOUSLY_BLOCKED_FILTERS || '').split(',').map(f => f.trim()).filter(f => f.length > 0) as string[], // Configurable via env var, empty by default
};

// Cache for previously blocked tokens to avoid repeated DB queries
const previouslyBlockedCache = new Map<string, { blocked: boolean; filter: string | null; timestamp: number }>();
const PREVIOUSLY_BLOCKED_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache

/**
 * Check if a token was previously blocked by permanent filters
 * Uses caching to minimize DB queries
 */
async function checkPreviouslyBlocked(tokenAddresses: string[]): Promise<Map<string, { blocked: boolean; filter: string | null }>> {
  const results = new Map<string, { blocked: boolean; filter: string | null }>();
  const now = Date.now();
  const addressesToQuery: string[] = [];
  
  // Check cache first
  for (const address of tokenAddresses) {
    const cached = previouslyBlockedCache.get(address);
    if (cached && (now - cached.timestamp) < PREVIOUSLY_BLOCKED_CACHE_TTL_MS) {
      results.set(address, { blocked: cached.blocked, filter: cached.filter });
    } else {
      addressesToQuery.push(address);
    }
  }
  
  // Query DB for uncached tokens
  if (addressesToQuery.length > 0 && HARD_STOPS.PREVIOUSLY_BLOCKED_ENABLED && HARD_STOPS.PREVIOUSLY_BLOCKED_FILTERS.length > 0) {
    try {
      const filterList = HARD_STOPS.PREVIOUSLY_BLOCKED_FILTERS.map(f => `'${f}'`).join(',');
      const placeholders = addressesToQuery.map((_, i) => `$${i + 1}`).join(',');
      
      const result = await query(`
        SELECT DISTINCT token_address, filter_stage
        FROM scanned_tokens
        WHERE token_address IN (${placeholders})
          AND filter_stage IN (${filterList})
        ORDER BY token_address
      `, addressesToQuery);
      
      // Create a map of blocked tokens
      const blockedMap = new Map<string, string>();
      for (const row of result.rows) {
        blockedMap.set(row.token_address, row.filter_stage);
      }
      
      // Update results and cache
      for (const address of addressesToQuery) {
        const filter = blockedMap.get(address) || null;
        const blocked = filter !== null;
        results.set(address, { blocked, filter });
        previouslyBlockedCache.set(address, { blocked, filter, timestamp: now });
      }
    } catch (error: any) {
      logger.error(`Failed to check previously blocked tokens: ${error.message}`);
      // On error, assume not blocked to avoid false positives
      for (const address of addressesToQuery) {
        results.set(address, { blocked: false, filter: null });
      }
    }
  } else {
    // If filter disabled or no addresses to query, mark as not blocked
    for (const address of addressesToQuery) {
      results.set(address, { blocked: false, filter: null });
    }
  }
  
  return results;
}

logger.info('📋 Trading Analyzer Hard Stops:');
logger.info(`  Min Liquidity: ${HARD_STOPS.MIN_LIQUIDITY_SOL} SOL (fallback: $${HARD_STOPS.MIN_LIQUIDITY_USD.toLocaleString()})`);
logger.info(`  Min Volume (5m): $${HARD_STOPS.MIN_VOLUME_5M.toLocaleString()}`);
logger.info(`  Min Users: ${HARD_STOPS.MIN_UNIQUE_USERS}`);
logger.info(`  Min Trades: ${HARD_STOPS.MIN_TOTAL_TRADES}`);
logger.info(`  Price Pump Filter: ${HARD_STOPS.PRICE_PUMP_ENABLED ? 'ENABLED' : 'DISABLED'} (age < ${HARD_STOPS.PRICE_PUMP_AGE_HOURS_THRESHOLD}h AND pc_1h > ${HARD_STOPS.PRICE_PUMP_PRICE_CHANGE_1H_THRESHOLD}%)`);
logger.info(`  Young Pump Filter: ${HARD_STOPS.YOUNG_PUMP_ENABLED ? 'ENABLED' : 'DISABLED'} (age < ${HARD_STOPS.YOUNG_PUMP_AGE_HOURS_MAX}h AND pc_1h > ${HARD_STOPS.YOUNG_PUMP_PRICE_CHANGE_1H_MIN}%)`);
logger.info(`  High Vol/Mcap Ratio Filter: ${HARD_STOPS.HIGH_VOL_MCAP_RATIO_ENABLED ? 'ENABLED' : 'DISABLED'} (vol_5m / mcap >= ${HARD_STOPS.HIGH_VOL_MCAP_RATIO_THRESHOLD}x)`);
logger.info(`  Young Honeypot Filter: ${HARD_STOPS.YOUNG_HONEYPOT_ENABLED ? 'ENABLED' : 'DISABLED'} (age < ${HARD_STOPS.YOUNG_HONEYPOT_AGE_HOURS_MAX}h AND pc_1h >= ${HARD_STOPS.YOUNG_HONEYPOT_PRICE_CHANGE_1H_MIN}%)`);
logger.info(`  Birth Spike Filter: ${HARD_STOPS.BIRTH_SPIKE_ENABLED ? 'ENABLED' : 'DISABLED'} (age < ${HARD_STOPS.BIRTH_SPIKE_AGE_HOURS_MAX}h AND pc_24h >= ${HARD_STOPS.BIRTH_SPIKE_PRICE_CHANGE_24H_MIN}%)`);
logger.info(`  Trap Detection Filter: ${HARD_STOPS.TRAP_DETECTION_ENABLED ? 'ENABLED' : 'DISABLED'} (trap suspicion score >= ${HARD_STOPS.TRAP_SUSPICION_THRESHOLD})`);
logger.info(`  Young High Risk Filter: ${HARD_STOPS.YOUNG_HIGH_RISK_ENABLED ? 'ENABLED' : 'DISABLED'} (risk >= ${HARD_STOPS.YOUNG_HIGH_RISK_RISK_SCORE_MIN} AND age < ${HARD_STOPS.YOUNG_HIGH_RISK_AGE_HOURS_MAX}h)`);
logger.info(`  Low Mcap High Vol Filter: ${HARD_STOPS.LOW_MCAP_HIGH_VOL_ENABLED ? 'ENABLED' : 'DISABLED'} (mcap < $${HARD_STOPS.LOW_MCAP_HIGH_VOL_MARKET_CAP_MAX} AND vol >= $${HARD_STOPS.LOW_MCAP_HIGH_VOL_VOLUME_5M_MIN})`);
logger.info(`  Previously Blocked Filter: ${HARD_STOPS.PREVIOUSLY_BLOCKED_ENABLED ? 'ENABLED' : 'DISABLED'} (permanent ban: ${HARD_STOPS.PREVIOUSLY_BLOCKED_FILTERS.join(', ')})`);
logger.info(`    - Excludes security_hardstop (runs every scan anyway, would cause false positives)`);
logger.info(`  Market Cap: Scoring preference (50-250k), not a hard stop (allows tracking)`);
logger.info(`  Security: Specific checks (honeypot, scams, etc) - NOT risk score`);

// ============================================================================
// Main Analyzer
// ============================================================================

export class TradingAnalyzer {
  private client: Anthropic | null = null
  private trapFilteredTokens: Set<string> = new Set(); // Track tokens filtered by trap score
  private volumeAnomalyFilteredTokens: Set<string> = new Set(); // Track tokens filtered by volume anomaly
  private axiomTrapFilteredTokens: Set<string> = new Set(); // Track tokens filtered by axiom trap (liquidity trap)
  private youngHighRiskFilteredTokens: Set<string> = new Set(); // Track tokens filtered by young high risk
  private lowMcapHighVolFilteredTokens: Set<string> = new Set(); // Track tokens filtered by low mcap high vol
  private pricePumpFilteredTokens: Set<string> = new Set(); // Track tokens filtered by price pump
  private youngPumpFilteredTokens: Set<string> = new Set(); // Track tokens filtered by young pump
  private highVolMcapFilteredTokens: Set<string> = new Set(); // Track tokens filtered by high vol/mcap ratio
  private youngHoneypotFilteredTokens: Set<string> = new Set(); // Track tokens filtered by young honeypot
  private birthSpikeFilteredTokens: Set<string> = new Set(); // Track tokens filtered by birth spike
  private mlTokensForBatch: Array<{
    token: any;
    metadata: any;
    security: SecurityAnalysis | SolanaSecurityAnalysis;
    additionalData: any;
    scannedToken: any;
  }> | null = null;;
  private enabled: boolean;
  private useAI: boolean;
  private pointBasedAnalyzer: PointBasedAnalyzerV3 | null = null;
  private mlClient: MLPredictionClient;
  private bscSecurityScanner: ContractSecurityScanner;
  private solanaSecurityScanner: SolanaSecurityScanner | null = null;
  private volumeAnalyzer: VolumeAnalyzer;
  private priceAnalyzer: PriceActionAnalyzer;
  // private liquidityAnalyzer: LiquidityDepthAnalyzer; // Disabled - causes data mismatch with Codex liquidity
  private decisionLogger: DecisionLogger;
  private decisionIdMap: Map<string, number> = new Map(); // Track decision IDs by token address
  private additionalDataMap: Map<string, any> = new Map(); // Store additional data for enrichment
  private currentSolPriceUsd: number | null = null; // SOL price for dynamic liquidity threshold

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    this.useAI = process.env.USE_AI_ANALYSIS !== 'false'; // Default to true for backwards compatibility
    
    if (this.useAI) {
      // AI Mode
      if (apiKey && apiKey.startsWith('sk-ant-')) {
        this.client = new Anthropic({ apiKey });
        this.enabled = true;
        logger.success('✅ Trading Analyzer enabled (AI Mode - Claude Sonnet)');
      } else {
        this.enabled = false;
        logger.warn('Trading Analyzer disabled (AI mode requested but no ANTHROPIC_API_KEY)');
        // Fallback to point-based if AI fails and fallback is enabled
        if (process.env.AI_FALLBACK_ON_ERROR === 'true') {
          logger.info('   Falling back to point-based analyzer V3 (signal-focused)');
          this.useAI = false;
          this.pointBasedAnalyzer = new PointBasedAnalyzerV3();
          this.enabled = true;
        }
      }
    } else {
      // Point-Based Mode V3 (Signal-Focused)
      this.pointBasedAnalyzer = new PointBasedAnalyzerV3();
      this.enabled = true;
      logger.success('✅ Trading Analyzer enabled (Point-Based V3 Mode - Signal-Focused)');
    }
    
    // Initialize BSC security scanner
    this.bscSecurityScanner = new ContractSecurityScanner();
    
    // Initialize Solana security scanner if on Solana chain
    const chainConfig = getChainConfig();
    if (chainConfig.chain === Chain.SOLANA) {
      this.solanaSecurityScanner = new SolanaSecurityScanner(chainConfig.rpcUrl);
      logger.success('🔷 Solana security scanner initialized');
    }
    
    this.volumeAnalyzer = new VolumeAnalyzer();
    this.priceAnalyzer = new PriceActionAnalyzer();
    // this.liquidityAnalyzer = new LiquidityDepthAnalyzer(); // Disabled
    this.decisionLogger = new DecisionLogger(); // Initialize decision logger
    this.mlClient = new MLPredictionClient(); // Initialize ML prediction client
    
    // Pre-fetch model info on startup (with caching)
    if (this.mlClient.isEnabled()) {
      this.mlClient.getModelInfo().then(modelInfo => {
        if (modelInfo) {
          logger.info(`🤖 Model info loaded: ${modelInfo.model_version}, ${modelInfo.features.length} features`);
        }
      }).catch(err => {
        logger.warn(`Failed to load model info on startup: ${err.message}`);
      });
    }
    
    logger.success('✅ Decision Logger enabled');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Calculate trap suspicion score from metadata and price action (for use in Step 3.5 filtering)
   * This version works with data available before tokens are logged to database
   */
  private calculateTrapSuspicionFromData(
    metadata: any,
    priceAction: any
  ): { score: number; patterns: string[] } {
    let suspicion = 0;
    const patterns: string[] = [];
    
    // Get trap thresholds from env or use defaults (match ML pipeline)
    const TRAP_PRICE_24H_HIGH = parseFloat(process.env.TRAP_PRICE_24H_HIGH || '1000');
    const TRAP_PRICE_24H_LOW = parseFloat(process.env.TRAP_PRICE_24H_LOW || '500');
    const TRAP_HOLDERS_THRESHOLD = parseFloat(process.env.TRAP_HOLDERS_THRESHOLD || '5000');
    const TRAP_LIQUIDITY_THRESHOLD = parseFloat(process.env.TRAP_LIQUIDITY_THRESHOLD || '100000');
    const TRAP_CONSEC_GREEN_HIGH = parseInt(process.env.TRAP_CONSEC_GREEN_HIGH || '12');
    const TRAP_CONSEC_GREEN_LOW = parseInt(process.env.TRAP_CONSEC_GREEN_LOW || '8');
    const TRAP_WICK_RATIO_VERY_LOW = parseFloat(process.env.TRAP_WICK_RATIO_VERY_LOW || '0.20');
    const TRAP_WICK_RATIO_LOW = parseFloat(process.env.TRAP_WICK_RATIO_LOW || '0.30');
    
    // =========================================================================
    // FEATURE-BASED SIGNALS (0-5 points)
    // =========================================================================
    
    // 1. Extreme 24h pump (MOST IMPORTANT - double weight)
    const priceChange24h = metadata.price_change_24h ?? metadata.priceChange24h ?? 0;
    if (priceChange24h > TRAP_PRICE_24H_HIGH) {
      suspicion += 2;
      patterns.push(`extreme 24h pump (${priceChange24h.toFixed(0)}% > ${TRAP_PRICE_24H_HIGH}%)`);
    } else if (priceChange24h > TRAP_PRICE_24H_LOW) {
      suspicion += 1;
      patterns.push(`high 24h pump (${priceChange24h.toFixed(0)}% > ${TRAP_PRICE_24H_LOW}%)`);
    }
    
    // 2. Very high holders (often fake/wash traded)
    const holders = metadata.holders ?? 0;
    if (holders > TRAP_HOLDERS_THRESHOLD) {
      suspicion += 1;
      patterns.push(`very high holders (${holders} > ${TRAP_HOLDERS_THRESHOLD})`);
    }
    
    // 3. No pullbacks (artificial smooth line) - calculate from 5m candles
    // m5_pullback_depth = minimum return among last 3 candles * 100
    // (matches price-action-features.ts calculation exactly)
    // If positive, means all returns were positive = no pullback (straight line up) = suspicious
    let m5PullbackDepth = -999;
    if (priceAction?.candles5m && priceAction.candles5m.length >= 3) {
      // Use last 3 candles (matches price-action-features.ts line 280-286)
      const last3 = priceAction.candles5m.slice(-3);
      const returns: number[] = [];
      for (let i = 1; i < last3.length; i++) {
        const prevCandle = last3[i - 1];
        const currCandle = last3[i];
        // Validate candles have required properties
        if (!prevCandle || !currCandle || 
            typeof prevCandle.close !== 'number' || typeof currCandle.close !== 'number') {
          continue; // Skip invalid candles
        }
        const prevClose = prevCandle.close;
        const currClose = currCandle.close;
        if (prevClose > 0) {
          // Calculate return as decimal (e.g., 0.01 = 1%)
          returns.push((currClose - prevClose) / prevClose);
        }
      }
      if (returns.length > 0) {
        // m5_pullback_depth is the minimum return * 100 (matches price-action-features.ts line 286)
        // If positive, means all returns were positive = no pullback (straight line up)
        m5PullbackDepth = Math.min(...returns) * 100;
      }
    }
    // If m5PullbackDepth > 0, it means no pullback (all candles went up) = suspicious
    if (m5PullbackDepth !== null && m5PullbackDepth !== undefined && m5PullbackDepth > 0) {
      suspicion += 1;
      patterns.push(`no pullbacks (${m5PullbackDepth.toFixed(1)})`);
    }
    
    // 4. High liquidity (unusual for new tokens)
    const liquidity = metadata.liquidity ?? 0;
    if (liquidity > TRAP_LIQUIDITY_THRESHOLD) {
      suspicion += 1;
      patterns.push(`high liquidity ($${(liquidity/1000).toFixed(0)}k > $${(TRAP_LIQUIDITY_THRESHOLD/1000).toFixed(0)}k)`);
    }
    
    // =========================================================================
    // CANDLE-BASED SIGNALS (0-4 points) - "straight line up" pattern
    // =========================================================================
    
    // 5. Many consecutive green candles (from 5m candles)
    let m5ConsecutiveGreen = 0;
    if (priceAction?.candles5m && priceAction.candles5m.length > 0) {
      // Count consecutive green candles from the end
      for (let i = priceAction.candles5m.length - 1; i >= 0; i--) {
        const candle = priceAction.candles5m[i];
        // Validate candle has required properties
        if (!candle || typeof candle.close !== 'number' || typeof candle.open !== 'number') {
          break; // Stop counting if invalid candle
        }
        if (candle.close > candle.open) {
          m5ConsecutiveGreen++;
        } else {
          break;
        }
      }
    }
    if (m5ConsecutiveGreen >= TRAP_CONSEC_GREEN_HIGH) {
      suspicion += 2;
      patterns.push(`extreme consec green (${m5ConsecutiveGreen} >= ${TRAP_CONSEC_GREEN_HIGH})`);
    } else if (m5ConsecutiveGreen >= TRAP_CONSEC_GREEN_LOW) {
      suspicion += 1;
      patterns.push(`high consec green (${m5ConsecutiveGreen} >= ${TRAP_CONSEC_GREEN_LOW})`);
    }
    
    // 6. Low wick ratio (smooth price action = artificial) - calculate from 1m candles
    // Matches price-action-features.ts: uses last 5 candles (shapeCandlesCount = Math.min(5, candles.length))
    let totalWickRatio = 1.0; // Default to high (not suspicious)
    if (priceAction?.candles1m && priceAction.candles1m.length > 0) {
      // Use last 5 candles (matches price-action-features.ts calculateAvgUpperWickRatio)
      const shapeCandlesCount = Math.min(5, priceAction.candles1m.length);
      const shapeCandles = priceAction.candles1m.slice(-shapeCandlesCount);
      
      // Calculate average wick ratios (matches price-action-features.ts getUpperWickRatio/getLowerWickRatio)
      let totalUpperWick = 0;
      let totalLowerWick = 0;
      let count = 0;
      
      for (const candle of shapeCandles) {
        // Validate candle has required properties
        if (!candle || typeof candle.high !== 'number' || typeof candle.low !== 'number' || 
            typeof candle.open !== 'number' || typeof candle.close !== 'number') {
          continue; // Skip invalid candles
        }
        
        const range = candle.high - candle.low;
        if (range > 0) {
          // Upper wick ratio = (high - max(open, close)) / range
          const upperWick = candle.high - Math.max(candle.open, candle.close);
          // Lower wick ratio = (min(open, close) - low) / range
          const lowerWick = Math.min(candle.open, candle.close) - candle.low;
          totalUpperWick += upperWick / range;
          totalLowerWick += lowerWick / range;
          count++;
        }
      }
      
      if (count > 0) {
        const avgUpperWick = totalUpperWick / count;
        const avgLowerWick = totalLowerWick / count;
        totalWickRatio = avgUpperWick + avgLowerWick;
      }
    }
    
    if (totalWickRatio < TRAP_WICK_RATIO_VERY_LOW) {
      suspicion += 2;
      patterns.push(`very low wicks (${totalWickRatio.toFixed(2)} < ${TRAP_WICK_RATIO_VERY_LOW})`);
    } else if (totalWickRatio < TRAP_WICK_RATIO_LOW) {
      suspicion += 1;
      patterns.push(`low wicks (${totalWickRatio.toFixed(2)} < ${TRAP_WICK_RATIO_LOW})`);
    }
    
    return { score: suspicion, patterns };
  }

  /**
   * Calculate trap suspicion score for a token (0-9 scale)
   * 
   * Feature-based signals (0-5 points):
   * - Extreme 24h pump (>1000%): +2, High pump (>500%): +1
   * - High holders (>5000): +1
   * - No pullbacks (m5_pullback_depth > 0): +1
   * - High liquidity (>100k): +1
   * 
   * Candle-based signals (0-4 points):
   * - Many consecutive green candles (>12): +2, (>8): +1
   * - Low wick ratio (<0.20): +2, (<0.30): +1
   * 
   * Based on analysis of confirmed trap tokens (inuwifhat, etc.)
   * that show artificial "straight line up" price action before rug pull.
   * 
   * NOTE: This version works with scannedToken from database (for backward compatibility)
   */
  private calculateTrapSuspicion(scannedToken: any): { score: number; patterns: string[] } {
    let suspicion = 0;
    const patterns: string[] = [];
    
    // Get trap thresholds from env or use defaults (match ML pipeline)
    const TRAP_PRICE_24H_HIGH = parseFloat(process.env.TRAP_PRICE_24H_HIGH || '1000');
    const TRAP_PRICE_24H_LOW = parseFloat(process.env.TRAP_PRICE_24H_LOW || '500');
    const TRAP_HOLDERS_THRESHOLD = parseFloat(process.env.TRAP_HOLDERS_THRESHOLD || '5000');
    const TRAP_LIQUIDITY_THRESHOLD = parseFloat(process.env.TRAP_LIQUIDITY_THRESHOLD || '100000');
    const TRAP_CONSEC_GREEN_HIGH = parseInt(process.env.TRAP_CONSEC_GREEN_HIGH || '12');
    const TRAP_CONSEC_GREEN_LOW = parseInt(process.env.TRAP_CONSEC_GREEN_LOW || '8');
    const TRAP_WICK_RATIO_VERY_LOW = parseFloat(process.env.TRAP_WICK_RATIO_VERY_LOW || '0.20');
    const TRAP_WICK_RATIO_LOW = parseFloat(process.env.TRAP_WICK_RATIO_LOW || '0.30');
    
    // =========================================================================
    // FEATURE-BASED SIGNALS (0-5 points)
    // =========================================================================
    
    // 1. Extreme 24h pump (MOST IMPORTANT - double weight)
    const priceChange24h = scannedToken.price_change_24h ?? 0;
    if (priceChange24h > TRAP_PRICE_24H_HIGH) {
      suspicion += 2;
      patterns.push(`extreme 24h pump (${priceChange24h.toFixed(0)}% > ${TRAP_PRICE_24H_HIGH}%)`);
    } else if (priceChange24h > TRAP_PRICE_24H_LOW) {
      suspicion += 1;
      patterns.push(`high 24h pump (${priceChange24h.toFixed(0)}% > ${TRAP_PRICE_24H_LOW}%)`);
    }
    
    // 2. Very high holders (often fake/wash traded)
    const holders = scannedToken.holders ?? 0;
    if (holders > TRAP_HOLDERS_THRESHOLD) {
      suspicion += 1;
      patterns.push(`very high holders (${holders} > ${TRAP_HOLDERS_THRESHOLD})`);
    }
    
    // 3. No pullbacks (artificial smooth line)
    const m5PullbackDepth = scannedToken.m5_pullback_depth ?? -999;
    if (m5PullbackDepth !== null && m5PullbackDepth > 0) {
      suspicion += 1;
      patterns.push(`no pullbacks (${m5PullbackDepth.toFixed(1)})`);
    }
    
    // 4. High liquidity (unusual for new tokens)
    const liquidity = scannedToken.liquidity ?? 0;
    if (liquidity > TRAP_LIQUIDITY_THRESHOLD) {
      suspicion += 1;
      patterns.push(`high liquidity ($${(liquidity/1000).toFixed(0)}k > $${(TRAP_LIQUIDITY_THRESHOLD/1000).toFixed(0)}k)`);
    }
    
    // =========================================================================
    // CANDLE-BASED SIGNALS (0-4 points) - "straight line up" pattern
    // =========================================================================
    
    // 5. Many consecutive green candles
    const m5ConsecutiveGreen = scannedToken.m5_consecutive_green ?? 0;
    if (m5ConsecutiveGreen >= TRAP_CONSEC_GREEN_HIGH) {
      suspicion += 2;
      patterns.push(`extreme consec green (${m5ConsecutiveGreen} >= ${TRAP_CONSEC_GREEN_HIGH})`);
    } else if (m5ConsecutiveGreen >= TRAP_CONSEC_GREEN_LOW) {
      suspicion += 1;
      patterns.push(`high consec green (${m5ConsecutiveGreen} >= ${TRAP_CONSEC_GREEN_LOW})`);
    }
    
    // 6. Low wick ratio (smooth price action = artificial)
    const upperWick = scannedToken.m1_upper_wick_ratio_5m ?? 0.5;
    const lowerWick = scannedToken.m1_lower_wick_ratio_5m ?? 0.5;
    const totalWickRatio = upperWick + lowerWick;
    
    if (totalWickRatio < TRAP_WICK_RATIO_VERY_LOW) {
      suspicion += 2;
      patterns.push(`very low wicks (${totalWickRatio.toFixed(2)} < ${TRAP_WICK_RATIO_VERY_LOW})`);
    } else if (totalWickRatio < TRAP_WICK_RATIO_LOW) {
      suspicion += 1;
      patterns.push(`low wicks (${totalWickRatio.toFixed(2)} < ${TRAP_WICK_RATIO_LOW})`);
    }
    
    return { score: suspicion, patterns };
  }

  /**
   * Main entry point: Analyze all tokens and return BUY/SKIP decisions
   */
  async analyzeTokens(scanResult: ScanResult): Promise<TradingAnalysis> {
    // Check if analyzer is enabled (either AI or point-based)
    if (!this.enabled) {
      logger.warn('Trading analysis skipped - service disabled');
      return {
        decisions: [],
        summary: 'Trading analyzer is disabled',
        timestamp: Date.now(),
      };
    }
    
    // Check if we have the required analyzer for current mode
    if (this.useAI && !this.client) {
      logger.error('AI mode enabled but no Anthropic client available');
      return {
        decisions: [],
        summary: 'AI analyzer unavailable',
        timestamp: Date.now(),
      };
    }
    
    if (!this.useAI && !this.pointBasedAnalyzer) {
      logger.error('Point-based mode enabled but analyzer not initialized');
      return {
        decisions: [],
        summary: 'Point-based analyzer unavailable',
        timestamp: Date.now(),
      };
    }

    try {
      logger.info(`🤖 Starting unified trading analysis for ${scanResult.topTokens.length} tokens...`);
      
      // ========================================================================
      // Step 1: Run security scans (chain-aware: BSC or Solana)
      // ========================================================================
      logger.info('🔒 Running security scans...');
      const securityResults = new Map<string, SecurityAnalysis>();
      
      const chainConfig = getChainConfig();
      
      if (chainConfig.chain === Chain.SOLANA && this.solanaSecurityScanner) {
        // Solana path: batch analyze with token data
        logger.info('[Solana] Running batch security analysis...');
        
        // Build token data map for security analysis
        const tokenDataMap = new Map<string, SolanaToken>();
        scanResult.topTokens.forEach(token => {
          // Create minimal SolanaToken from metadata
          const metadata = scanResult.tokenMetadata.get(token.token);
          if (metadata) {
            tokenDataMap.set(token.token, {
              address: token.token,
              mint: token.token,
              symbol: metadata.symbol || 'Unknown',
              name: metadata.name || 'Unknown',
              buys: token.buys,
              sells: token.sells,
              netBuys: token.netBuys,
              volume: 0,
              uniqueUsers: token.users,
              bots: token.bots,
              botActivity: token.botActivity,
              liquidityUsd: metadata.liquidity,
              hasLiquidity: metadata.liquidity > 0,
              dexId: token.dexId || 'unknown',
              pairAddress: token.pairAddress,
              quoteToken: token.quoteToken,
              pairCreatedAt: token.pairCreatedAt, // FIXED: Pass through for age calculation
            } as SolanaToken);
          }
        });
        
        const solanaResults = await this.solanaSecurityScanner.analyzeTokens(tokenDataMap);
        
        // Convert Solana security results to unified SecurityAnalysis format
        solanaResults.forEach((solanaAnalysis: SolanaSecurityAnalysis, mint: string) => {
          securityResults.set(mint, {
            isSafe: solanaAnalysis.isSafe,
            riskScore: solanaAnalysis.riskScore,
            risks: solanaAnalysis.risks,
            warnings: solanaAnalysis.warnings,
            contractVerified: solanaAnalysis.metadataVerified, // Jupiter + freeze check + RugCheck
            honeypotDetected: false, // Not applicable to Solana (Jupiter quote checks this)
            ownershipRisk: solanaAnalysis.mintAuthority !== null && solanaAnalysis.mintAuthority !== 'unknown',
            hiddenFunctionsDetected: false, // Not applicable to Solana
            maxTxAmountRestricted: false, // Not applicable to Solana
            blacklistDetected: solanaAnalysis.freezeAuthority !== null && solanaAnalysis.freezeAuthority !== 'unknown',
            contractAge: solanaAnalysis.tokenAge,
            contractAgeDays: solanaAnalysis.tokenAge ? solanaAnalysis.tokenAge / 86400 : undefined,
            contractAgeHours: solanaAnalysis.tokenAge ? solanaAnalysis.tokenAge / 3600 : undefined,
            // Jupiter quote data (for ML training - pre-trade liquidity check at 1 SOL)
            // BUY quote (entry liquidity)
            jupiterBuyQuoteSuccess: solanaAnalysis.jupiterBuyQuoteSuccess,
            jupiterBuyQuotePriceImpact: solanaAnalysis.jupiterBuyQuotePriceImpact,
            jupiterBuyQuoteOutAmount: solanaAnalysis.jupiterBuyQuoteOutAmount,
            jupiterBuyQuoteRoutesCount: solanaAnalysis.jupiterBuyQuoteRoutesCount,
            jupiterBuyQuoteError: solanaAnalysis.jupiterBuyQuoteError,
            // SELL quote (exit liquidity)
            jupiterSellQuoteSuccess: solanaAnalysis.jupiterSellQuoteSuccess,
            jupiterSellQuotePriceImpact: solanaAnalysis.jupiterSellQuotePriceImpact,
            jupiterSellQuoteOutAmount: solanaAnalysis.jupiterSellQuoteOutAmount,
            jupiterSellQuoteRoutesCount: solanaAnalysis.jupiterSellQuoteRoutesCount,
            jupiterSellQuoteError: solanaAnalysis.jupiterSellQuoteError,
          });
        });
        
        logger.info(`✅ Solana security scans complete for ${securityResults.size} tokens`);
        
      } else {
        // BSC path: sequential with rate limiting
        logger.info('[BSC] Running sequential security scans...');
        
        // Process tokens sequentially to avoid BSCScan rate limits
        // With 10 req/s limit, we can process ~2-3 tokens per second safely
        for (let i = 0; i < scanResult.topTokens.length; i++) {
          const token = scanResult.topTokens[i];
          const analysis = await this.bscSecurityScanner.analyzeToken(token.token);
          securityResults.set(token.token, analysis);
          
          // Small delay between tokens to respect rate limits (200ms = 5 tokens/sec max)
          // Skip delay after the last token
          if (i < scanResult.topTokens.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
        
        logger.info(`✅ BSC security scans complete for ${securityResults.size} tokens`);
      }
      
      // ========================================================================
      // Step 1.25: Check price variance (manipulation detection)
      // ========================================================================
      // Check price variance for tokens that passed security checks
      // This is async, so we do it before the synchronous filter
      const priceVarianceBlocked = new Set<string>();
      
      // First, filter tokens that passed basic security (for efficiency)
      const tokensForVarianceCheck = scanResult.topTokens.filter(token => {
        const security = securityResults.get(token.token);
        return security && security.isSafe;
      });
      
      if (tokensForVarianceCheck.length > 0) {
        const chain = getCurrentChain(); // Returns Chain enum ('BNB' or 'SOLANA')
        const chainString = chain; // Chain enum values are already strings
        const priceVarianceChecks = await Promise.all(
          tokensForVarianceCheck.map(async (token) => {
            const varianceCheck = await this.checkPriceVariance(token.token, chainString);
            if (varianceCheck.shouldBlock) {
              priceVarianceBlocked.add(token.token);
              const metadata = scanResult.tokenMetadata.get(token.token);
              logger.warn(`🚨 Hard stop: ${metadata?.symbol || token.token} - EXTREME PRICE VOLATILITY (${varianceCheck.variancePct.toFixed(0)}% variance, ${varianceCheck.scanCount} scans)`);
            }
            return varianceCheck;
          })
        );
        
        const varianceBlockedCount = priceVarianceBlocked.size;
        if (varianceBlockedCount > 0) {
          logger.info(`🚨 Price variance check blocked ${varianceBlockedCount} tokens`);
        }
      }
      
      // Filter using SPECIFIC security hard stops (same as old AI analyzer)
      // Risk score is NOT a hard stop - AI will evaluate it
      const safeTokens = scanResult.topTokens.filter(token => {
        const security = securityResults.get(token.token);
        if (!security) {
          logger.warn(`No security data for ${token.token} - skipping`);
          return false;
        }
        
        // DATA QUALITY HARD STOP: Skip if critical security data is missing
        // We need at least ONE of these to verify it's not a scam
        const hasCriticalData = 
          security.contractAge !== undefined || 
          security.buyTax !== undefined || 
          security.sellTax !== undefined ||
          security.honeypotDetected !== undefined;
          
        if (!hasCriticalData) {
          logger.warn(`🚨 Hard stop: ${token.token} - No security data available (all API calls failed). Cannot verify safety - SKIPPING.`);
          return false;
        }
        
        // HARD STOP 0: Overall safety check (catches unverified contracts, etc.)
        // The security scanner sets isSafe=false for critical issues like unverified contracts
        if (!security.isSafe) {
          const metadata = scanResult.tokenMetadata.get(token.token);
          const risks = security.risks.slice(0, 2).join(', '); // Show first 2 risks
          logger.warn(`🚨 Hard stop: ${metadata?.symbol || token.token} - ${risks}`);
          return false;
        }

        /*
        // HARD STOP 0.5: Major dump in progress (4h down >30% + recent negative momentum)
        // Prevents buying tokens in free fall
        const priceAction = additionalDataMap.get(token.token)?.priceAction;
        if (priceAction) {
          const dump4h = priceAction.priceChange4h < -30; // Down >30% in 4h
          const falling5m = priceAction.priceChange5m < -3; // Still falling in 5m
          const falling1m = priceAction.priceChange1m < 0; // Declining in 1m
          
          if (dump4h && falling5m && falling1m) {
            const metadata = scanResult.tokenMetadata.get(token.token);
            logger.warn(`🚨 Hard stop: ${metadata?.symbol || token.token} - Major dump in progress (4h: ${priceAction.priceChange4h.toFixed(1)}%, 5m: ${priceAction.priceChange5m.toFixed(1)}%, 1m: ${priceAction.priceChange1m.toFixed(1)}%)`);
            return false;
          }
        }
        */
        
        // HARD STOP 1: Honeypot detected
        if (security.honeypotDetected) {
          logger.warn(`🚨 Hard stop: ${token.token} - HONEYPOT DETECTED`);
          return false;
        }
        
        // HARD STOP 2: Hidden transfer functions (can't sell)
        if (security.hiddenFunctionsDetected) {
          logger.warn(`🚨 Hard stop: ${token.token} - HIDDEN FUNCTIONS (can't sell)`);
          return false;
        }
        
        // HARD STOP 3: Blacklist function (can ban wallets)
        if (security.blacklistDetected) {
          logger.warn(`🚨 Hard stop: ${token.token} - BLACKLIST FUNCTION (can ban users)`);
          return false;
        }
        
        // HARD STOP 4: Airdrop scam detected
        if (security.isAirdropScam) {
          logger.warn(`🚨 Hard stop: ${token.token} - AIRDROP SCAM`);
          return false;
        }
        
        // HARD STOP 5: Can reclaim ownership (fake renouncement)
        if (security.canTakeBackOwnership) {
          logger.warn(`🚨 Hard stop: ${token.token} - CAN RECLAIM OWNERSHIP (fake renouncement)`);
          return false;
        }
        
        // HARD STOP 6: Extreme centralization - Top 10 holders own >95%
        // This is a CRITICAL rug pull indicator - if top 10 holders own almost everything,
        // they can coordinate to dump on everyone else
        if (security.top10HolderPercent && security.top10HolderPercent > 95) {
          logger.warn(`🚨 Hard stop: ${token.token} - EXTREME CENTRALIZATION (Top 10 holders own ${security.top10HolderPercent.toFixed(1)}%)`);
          return false;
        }
        
        // HARD STOP 7: Owner holds >40% of supply
        // Owner holding a large percentage = high dump risk
        // Even if renounced, they can still dump their holdings
        if (security.ownerPercent && security.ownerPercent > 50) {
          logger.warn(`🚨 Hard stop: ${token.token} - OWNER CONCENTRATION (Owner holds ${security.ownerPercent.toFixed(1)}% of supply)`);
          return false;
        }
        
        // HARD STOP 8: Extreme price volatility (manipulation pattern)
        // Block tokens with >10,000% price variance (extreme volatility = manipulation)
        // This detects pump & dump patterns before they cause losses
        if (priceVarianceBlocked.has(token.token)) {
          // Already logged above, just block it
          return false;
        }
        
        // Risk score, taxes, LP lock, moderate holder concentration, etc.
        // are NOT hard stops - AI will evaluate them
        return true;
      });
      
      logger.info(`✅ ${safeTokens.length}/${scanResult.topTokens.length} tokens passed security hard stops`);
      
      if (safeTokens.length === 0) {
        // Update scan metrics before returning
        scanLogger.updateFiltering(0, 0, 0, 0);
        scanLogger.updateDecisions(0, 0);
        return {
          decisions: [],
          summary: 'No tokens passed security filters',
          timestamp: Date.now(),
        };
      }
      
      // ========================================================================
      // Step 1.5: Filter out tokens with INSUFFICIENT ACTIVITY
      // ========================================================================
      const activeTokens = safeTokens.filter(token => {
        const totalActivity = token.buys + token.sells;
        const uniqueUsers = token.users.size;
        
        if (uniqueUsers < HARD_STOPS.MIN_UNIQUE_USERS) {
          logger.warn(`🚨 Hard stop: ${token.token} - Insufficient users (${uniqueUsers} < ${HARD_STOPS.MIN_UNIQUE_USERS})`);
          return false;
        }
        
        if (totalActivity < HARD_STOPS.MIN_TOTAL_TRADES) {
          logger.warn(`🚨 Hard stop: ${token.token} - Low activity (${totalActivity} trades < ${HARD_STOPS.MIN_TOTAL_TRADES})`);
          return false;
        }
        
        return true;
      });
      
      logger.info(`✅ ${activeTokens.length}/${safeTokens.length} tokens have sufficient activity`);
      
      if (activeTokens.length === 0) {
        // Update scan metrics before returning
        scanLogger.updateFiltering(safeTokens.length, 0, 0, 0);
        scanLogger.updateDecisions(0, 0);
        return {
          decisions: [],
          summary: 'No tokens with sufficient trading activity',
          timestamp: Date.now(),
        };
      }
      
      // ========================================================================
      // Step 2: Apply QUICK hard stops (liquidity, volume) before expensive candle fetches
      // ========================================================================

      // Fetch SOL price for dynamic liquidity threshold (SOL-denominated)
      // This ensures the filter stays consistent regardless of SOL price fluctuations
      try {
        const { priceService } = await import('./price-tracking');
        const solPrice = await priceService.getPrice('So11111111111111111111111111111111111111112');
        if (solPrice > 0) {
          this.currentSolPriceUsd = solPrice;
        }
      } catch (error) {
        logger.warn(`[LiqFilter] Failed to fetch SOL price, using USD fallback: ${error}`);
      }

      // Dynamic liquidity threshold: stricter of (SOL-denominated floor, USD floor).
      // SOL-denominated tracks 79 SOL (pump.fun graduation), stays stable in SOL terms.
      // USD floor ($10k) acts as a hard minimum so SOL-price drops can't open the gate
      // to a lower-liquidity sub-population the ML models were never trained on.
      // See ml-training/docs/LIQUIDITY_THRESHOLD_79_SOL.md for why this matters.
      const solFloorUsd = this.currentSolPriceUsd
        ? HARD_STOPS.MIN_LIQUIDITY_SOL * this.currentSolPriceUsd
        : 0;
      const minLiquidityUsd = Math.max(solFloorUsd, HARD_STOPS.MIN_LIQUIDITY_USD);
      logger.info(`📋 Liquidity threshold: max(${HARD_STOPS.MIN_LIQUIDITY_SOL} SOL × $${this.currentSolPriceUsd?.toFixed(2) || 'N/A'} = $${Math.round(solFloorUsd).toLocaleString()}, $${HARD_STOPS.MIN_LIQUIDITY_USD.toLocaleString()} USD floor) = $${Math.round(minLiquidityUsd).toLocaleString()}`);

      const tokensPassingHardStops = activeTokens.filter(token => {
        const metadata = scanResult.tokenMetadata.get(token.token);
        if (!metadata) return false;

        // Check liquidity (SOL-denominated threshold, stable across SOL price changes)
        if (metadata.liquidity < minLiquidityUsd) {
          logger.warn(`🚨 Hard stop: ${metadata.symbol} (Liquidity: $${metadata.liquidity.toLocaleString()} < $${Math.round(minLiquidityUsd).toLocaleString()} [${HARD_STOPS.MIN_LIQUIDITY_SOL} SOL])`);
          return false;
        }
        
        // Check volume 5m using Codex data (available now, no API call needed)
        // Use Codex volume5m if available, otherwise estimate from volume24h
        const volume5m = metadata.volume5m || (metadata.volume24h ? (metadata.volume24h / (24 * 12)) : 0);
        if (volume5m < HARD_STOPS.MIN_VOLUME_5M) {
          logger.warn(`🚨 Hard stop: ${metadata.symbol} (Volume 5m: $${Math.round(volume5m)} < $${HARD_STOPS.MIN_VOLUME_5M})`);
          return false;
        }
        
        // Market cap: Now handled via scoring system (50-250k preferred), not a hard stop
        // This allows tracking all tokens for peak gain analysis
        
        return true;
      });
      
      logger.info(`✅ ${tokensPassingHardStops.length}/${activeTokens.length} tokens passed hard stop filters (liquidity, volume)`);
      
      if (tokensPassingHardStops.length === 0) {
        scanLogger.updateFiltering(safeTokens.length, activeTokens.length, 0, 0);
        scanLogger.updateDecisions(0, 0);
        return {
          decisions: [],
          summary: 'No tokens passed liquidity filters',
          timestamp: Date.now(),
        };
      }
      
      // ========================================================================
      // Step 3: Fetch candles for tokens that passed all hard stops
      // REFACTORED: Candles are fetched LAST, only for tokens that passed all previous checks
      // This saves API calls - we don't fetch candles for tokens that fail liquidity/volume checks
      // ========================================================================
      logger.info(`📊 Fetching candles for ${tokensPassingHardStops.length} tokens that passed all hard stops...`);
      
      // Clear and rebuild additionalDataMap for this scan
      this.additionalDataMap.clear();
      
      const dataPromises = tokensPassingHardStops.map(async (token) => {
        const metadata = scanResult.tokenMetadata.get(token.token);
        if (!metadata) {
          // No metadata - skip this token
          return;
        }
        
        try {
          // Gather data in parallel
          const [priceAction, volumeMetrics] = await Promise.all([
            this.priceAnalyzer.analyze(token.token).catch(err => {
              logger.warn(`Failed to get price action for ${token.token}:`, err.message);
              return null;
            }),
            this.volumeAnalyzer.getVolumeMetrics(token.token).catch(err => {
              logger.warn(`Failed to get volume for ${token.token}:`, err.message);
              return null;
            }),
          ]);
          
          // Store data
          this.additionalDataMap.set(token.token, {
            priceAction,
            volumeMetrics,
          });
        } catch (error) {
          logger.warn(`Failed to gather data for ${token.token}:`, error);
          // Don't add to map if fetching failed - will be filtered out
        }
      });
      
      await Promise.all(dataPromises);
      
      // ========================================================================
      // Step 3.5: Filter tokens that successfully got data + apply price change hard stop
      // Note: Price action features handle data quality validation (OHLC integrity, order, etc.)
      // Quality checks removed - ML model learns from features, not warnings
      // ========================================================================
      // Check for previously blocked tokens (batch query for performance)
      const tokenAddressesForBlockCheck = tokensPassingHardStops.map(t => t.token);
      const previouslyBlockedMap = await checkPreviouslyBlocked(tokenAddressesForBlockCheck);
      
      // Clear filter tracking sets for this scan
      this.trapFilteredTokens.clear();
      this.volumeAnomalyFilteredTokens.clear();
      this.axiomTrapFilteredTokens.clear();
      this.youngHighRiskFilteredTokens.clear();
      this.lowMcapHighVolFilteredTokens.clear();
      this.pricePumpFilteredTokens.clear();
      this.youngPumpFilteredTokens.clear();
      this.highVolMcapFilteredTokens.clear();
      this.youngHoneypotFilteredTokens.clear();
      this.birthSpikeFilteredTokens.clear();
      
      const analyzableTokens = tokensPassingHardStops.filter(token => {
        // Must have data (same as original logic)
        if (!this.additionalDataMap.has(token.token)) {
          return false;
        }
        
        // CRITICAL: Require priceAction for trap detection to work
        // Tokens without priceAction cannot be properly evaluated for traps
        const tokenData = this.additionalDataMap.get(token.token);
        if (!tokenData?.priceAction) {
          const metadata = scanResult.tokenMetadata.get(token.token);
          logger.warn(`⚠️  Skipping ${metadata?.symbol || token.token}: priceAction is required for trap detection`);
          return false;
        }
        
        // HARD STOP: Previously Blocked Filter
        // Tokens that were previously blocked by permanent filters are permanently banned
        const previouslyBlocked = previouslyBlockedMap.get(token.token);
        if (previouslyBlocked?.blocked) {
          const metadata = scanResult.tokenMetadata.get(token.token);
          logger.warn(`🚨 Hard stop (Previously Blocked): ${metadata?.symbol || token.token} - was blocked by ${previouslyBlocked.filter}`);
          return false;
        }
        
        // HARD STOP: Price Pump Filter (RE-ENABLED - backtest shows we need this)
        // Block very young tokens (< 2h) that already pumped hard (> 150% in 1h)
        const additionalData = this.additionalDataMap.get(token.token);
        const volumeMetrics = additionalData?.volumeMetrics;
        
        if (volumeMetrics?.priceChange1h !== undefined) {
          const metadata = scanResult.tokenMetadata.get(token.token);
          if (metadata) {
            const security = securityResults.get(token.token);
            const ageFromSecurity = security?.contractAge ? security.contractAge / 3600 : undefined;
            const ageFromMetadata = (metadata as any).ageHours;
            const ageHours = ageFromSecurity ?? ageFromMetadata ?? 0;
            const priceChange1h = volumeMetrics.priceChange1h;
            
            // Price Pump Filter: age < 2h AND price_change_1h > 150%
            if (HARD_STOPS.PRICE_PUMP_ENABLED &&
                ageHours < HARD_STOPS.PRICE_PUMP_AGE_HOURS_THRESHOLD &&
                priceChange1h > HARD_STOPS.PRICE_PUMP_PRICE_CHANGE_1H_THRESHOLD) {
              logger.warn(`🚨 Hard stop (Price Pump): ${metadata.symbol} (${token.token}) - age=${ageHours.toFixed(2)}h < ${HARD_STOPS.PRICE_PUMP_AGE_HOURS_THRESHOLD}h AND pc_1h=+${priceChange1h.toFixed(0)}% > +${HARD_STOPS.PRICE_PUMP_PRICE_CHANGE_1H_THRESHOLD}%`);
              this.pricePumpFilteredTokens.add(token.token);
              return false;
            }
            
            // Young Pump Filter: age < 0.5h AND price_change_1h > 100%
            if (HARD_STOPS.YOUNG_PUMP_ENABLED &&
                ageHours < HARD_STOPS.YOUNG_PUMP_AGE_HOURS_MAX &&
                priceChange1h > HARD_STOPS.YOUNG_PUMP_PRICE_CHANGE_1H_MIN) {
              logger.warn(`🚨 Hard stop (Young Pump): ${metadata.symbol} (${token.token}) - age=${ageHours.toFixed(2)}h < ${HARD_STOPS.YOUNG_PUMP_AGE_HOURS_MAX}h AND pc_1h=+${priceChange1h.toFixed(0)}% > +${HARD_STOPS.YOUNG_PUMP_PRICE_CHANGE_1H_MIN}%`);
              this.youngPumpFilteredTokens.add(token.token);
              return false;
            }
            
            // High Vol/Mcap Ratio Filter: volume_5m / market_cap >= 2.5 (generalized from 3.0)
            // Tokens with volume > 2.5x market cap are suspicious (artificial pump)
            if (HARD_STOPS.HIGH_VOL_MCAP_RATIO_ENABLED) {
              const volume5m = volumeMetrics.volume5m || 0;
              const marketCap = metadata.marketCap || 0;
              if (marketCap > 0) {
                const volMcapRatio = volume5m / marketCap;
                if (volMcapRatio >= HARD_STOPS.HIGH_VOL_MCAP_RATIO_THRESHOLD) {
                  logger.warn(`🚨 Hard stop (High Vol/Mcap): ${metadata.symbol} (${token.token}) - vol/mcap=${volMcapRatio.toFixed(2)}x >= ${HARD_STOPS.HIGH_VOL_MCAP_RATIO_THRESHOLD}x (vol_5m=$${volume5m.toFixed(0)}, mcap=$${marketCap.toFixed(0)})`);
                  this.highVolMcapFilteredTokens.add(token.token);
                  return false;
                }
              }
            }
            
            // Young Honeypot Filter: age < 0.5h AND price_change_1h >= 40% (generalized from age<1h AND price>=50%)
            // Very young tokens with significant price change are high risk (honeypot pattern)
            if (HARD_STOPS.YOUNG_HONEYPOT_ENABLED &&
                ageHours < HARD_STOPS.YOUNG_HONEYPOT_AGE_HOURS_MAX &&
                priceChange1h >= HARD_STOPS.YOUNG_HONEYPOT_PRICE_CHANGE_1H_MIN) {
              logger.warn(`🚨 Hard stop (Young Honeypot): ${metadata.symbol} (${token.token}) - age=${ageHours.toFixed(2)}h < ${HARD_STOPS.YOUNG_HONEYPOT_AGE_HOURS_MAX}h AND pc_1h=+${priceChange1h.toFixed(0)}% >= +${HARD_STOPS.YOUNG_HONEYPOT_PRICE_CHANGE_1H_MIN}%`);
              this.youngHoneypotFilteredTokens.add(token.token);
              return false;
            }
            
            // Birth Spike Filter: age < 3h AND price_change_24h >= 1000%
            // Catches tokens that spiked massively at birth but cooled down by scan time
            if (HARD_STOPS.BIRTH_SPIKE_ENABLED) {
              const priceChange24h = volumeMetrics.priceChange24h || 0;
              if (ageHours < HARD_STOPS.BIRTH_SPIKE_AGE_HOURS_MAX &&
                  priceChange24h >= HARD_STOPS.BIRTH_SPIKE_PRICE_CHANGE_24H_MIN) {
                logger.warn(`🚨 Hard stop (Birth Spike): ${metadata.symbol} (${token.token}) - age=${ageHours.toFixed(2)}h < ${HARD_STOPS.BIRTH_SPIKE_AGE_HOURS_MAX}h AND pc_24h=+${priceChange24h.toFixed(0)}% >= +${HARD_STOPS.BIRTH_SPIKE_PRICE_CHANGE_24H_MIN}%`);
                this.birthSpikeFilteredTokens.add(token.token);
                return false;
              }
            }
            
            // Volume Anomaly Filter: Detect liquidity grab scams
            // Very young tokens with extreme volume spikes (volume density > $500K/hour)
            const volume5m = volumeMetrics.volume5m || 0;
            if (HARD_STOPS.VOLUME_ANOMALY_ENABLED && 
                ageHours < HARD_STOPS.VOLUME_ANOMALY_AGE_HOURS_MAX && 
                volume5m >= HARD_STOPS.VOLUME_ANOMALY_VOLUME_5M_MIN) {
              // Calculate volume density (volume per hour of age)
              // Prevent division by zero for tokens <1 minute old
              const ageHoursSafe = Math.max(ageHours, 0.02); // Cap at ~1 minute
              const volumePerHour = volume5m / ageHoursSafe;
              
              if (volumePerHour > HARD_STOPS.VOLUME_ANOMALY_VOLUME_PER_HOUR_THRESHOLD) {
                logger.warn(`🚨 Hard stop (Volume Anomaly): ${metadata.symbol} (${token.token}) - age=${ageHours.toFixed(2)}h, vol_5m=$${volume5m.toFixed(0)}, density=$${(volumePerHour/1000).toFixed(0)}K/hr > $${(HARD_STOPS.VOLUME_ANOMALY_VOLUME_PER_HOUR_THRESHOLD/1000).toFixed(0)}K/hr`);
                this.volumeAnomalyFilteredTokens.add(token.token); // Track for filter stage determination
                return false;
              }
            }
            
// Legacy filter removed - redundant with Price Pump and Young Pump filters
          }
        }
        
        // HARD STOP: Trap Token Detection (before logging as ai_ready)
        // Matches ML pipeline hard stops for consistent evaluation
        // This ensures trap tokens are filtered BEFORE they reach shadow tracker
        // ⚠️ CRITICAL: Threshold MUST match ml-training/shared/token_filters.py TRAP_DETECTION_FILTER['trap_suspicion_threshold']
        if (HARD_STOPS.TRAP_DETECTION_ENABLED) {
          const priceAction = additionalData?.priceAction;
          const metadata = scanResult.tokenMetadata.get(token.token);
          if (priceAction && metadata) {
            try {
              const trapCheck = this.calculateTrapSuspicionFromData(metadata, priceAction);
              
              if (trapCheck.score >= HARD_STOPS.TRAP_SUSPICION_THRESHOLD) {
                logger.warn(`🚨 Hard stop (Trap Detection): ${metadata.symbol} (${token.token}) - TRAP DETECTED (suspicion: ${trapCheck.score}/9) - ${trapCheck.patterns.join(', ')}`);
                this.trapFilteredTokens.add(token.token); // Track for filter stage determination
                return false;
              }
            } catch (error: any) {
              // If trap score calculation fails, log but don't block the token
              // This prevents unhandled errors from breaking the entire scan
              logger.warn(`⚠️  Failed to calculate trap score for ${metadata.symbol} (${token.token}): ${error?.message || String(error)}`);
              // Continue - allow token through if trap check fails (fail-open for safety)
            }
          }
        }
        
        // HARD STOP: Axiom Trap Detection (liquidity trap tokens)
        // Detects fake tokens that pump briefly then pull liquidity
        // Pattern: Single axiom bot, very young, high volume, tight liquidity/market cap ranges
        // Codex returns stale prices after liquidity removal = model sees fake gains
        if (HARD_STOPS.AXIOM_TRAP_ENABLED) {
          const security = securityResults.get(token.token);
          const metadata = scanResult.tokenMetadata.get(token.token);
          const volumeMetrics = additionalData?.volumeMetrics;
          
          if (metadata) {
            const botCount = token.bots.size;
            const discoveredByBots = Array.from(token.bots);
            
            // Get ageHours from multiple sources (same as other filters)
            const ageFromSecurity = security?.contractAge ? security.contractAge / 3600 : undefined;
            const ageFromMetadata = (metadata as any).ageHours;
            const ageHours = ageFromSecurity ?? ageFromMetadata ?? 0;
            
            const volume5m = volumeMetrics?.volume5m || 0;
            const liquidity = metadata.liquidity || 0;
            const marketCap = metadata.marketCap || 0;
            const priceChange1h = volumeMetrics?.priceChange1h || 0;
            
            // Check all axiom trap conditions
            const isAxiomTrap = (
              botCount <= HARD_STOPS.AXIOM_TRAP_BOT_COUNT_MAX &&
              discoveredByBots.some(bot => HARD_STOPS.AXIOM_TRAP_DISCOVERED_BY_BOTS.includes(bot.toLowerCase())) &&
              ageHours < HARD_STOPS.AXIOM_TRAP_AGE_HOURS_MAX &&
              volume5m >= HARD_STOPS.AXIOM_TRAP_VOLUME_5M_MIN &&
              volume5m <= HARD_STOPS.AXIOM_TRAP_VOLUME_5M_MAX &&
              liquidity >= HARD_STOPS.AXIOM_TRAP_LIQUIDITY_MIN &&
              liquidity <= HARD_STOPS.AXIOM_TRAP_LIQUIDITY_MAX &&
              marketCap >= HARD_STOPS.AXIOM_TRAP_MARKET_CAP_MIN &&
              marketCap <= HARD_STOPS.AXIOM_TRAP_MARKET_CAP_MAX &&
              priceChange1h >= HARD_STOPS.AXIOM_TRAP_PRICE_CHANGE_1H_MIN
            );
            
            if (isAxiomTrap) {
              logger.warn(`🚨 Hard stop (Axiom Trap): ${metadata.symbol} (${token.token}) - LIQUIDITY TRAP DETECTED`);
              logger.warn(`   Pattern: bot=${botCount}, bots=${discoveredByBots.join(',')}, age=${ageHours.toFixed(2)}h, vol_5m=$${volume5m.toFixed(0)}, liq=$${liquidity.toFixed(0)}, mcap=$${marketCap.toFixed(0)}, pc_1h=+${priceChange1h.toFixed(0)}%`);
              this.axiomTrapFilteredTokens.add(token.token);
              return false;
            }
          }
        }
        
        // HARD STOP: Young High Risk Filter
        // MATCHES: token_filters.py YOUNG_HIGH_RISK_FILTER (risk_score >= 50, age < 1h)
        // Very young tokens with high risk scores are likely traps that pass standard security checks
        if (HARD_STOPS.YOUNG_HIGH_RISK_ENABLED) {
          const security = securityResults.get(token.token);
          const metadata = scanResult.tokenMetadata.get(token.token);
          if (metadata && security) {
            const ageFromSecurity = security?.contractAge ? security.contractAge / 3600 : undefined;
            const ageFromMetadata = (metadata as any).ageHours;
            const ageHours = ageFromSecurity ?? ageFromMetadata ?? 999;
            const riskScore = security.riskScore ?? 0;

            if (riskScore >= HARD_STOPS.YOUNG_HIGH_RISK_RISK_SCORE_MIN &&
                ageHours < HARD_STOPS.YOUNG_HIGH_RISK_AGE_HOURS_MAX) {
              logger.warn(`🚨 Hard stop (Young High Risk): ${metadata.symbol} (${token.token}) - risk=${riskScore} >= ${HARD_STOPS.YOUNG_HIGH_RISK_RISK_SCORE_MIN} AND age=${ageHours.toFixed(2)}h < ${HARD_STOPS.YOUNG_HIGH_RISK_AGE_HOURS_MAX}h`);
              this.youngHighRiskFilteredTokens.add(token.token);
              return false;
            }
          }
        }
        
        // HARD STOP: Low Market Cap High Volume Filter
        // MATCHES: token_filters.py LOW_MCAP_HIGH_VOL_FILTER (mcap < $40K, vol >= $50K)
        // Low market cap tokens with high volume indicate artificial pumping before rug/honeypot
        // Uses FDV as fallback when market_cap is null
        if (HARD_STOPS.LOW_MCAP_HIGH_VOL_ENABLED) {
          const metadata = scanResult.tokenMetadata.get(token.token);
          const volumeMetrics = additionalData?.volumeMetrics;
          if (metadata && volumeMetrics) {
            const marketCap = metadata.marketCap || (metadata as any).fdv || 0;
            const volume5m = volumeMetrics.volume5m || 0;
            
            if (marketCap > 0 && marketCap < HARD_STOPS.LOW_MCAP_HIGH_VOL_MARKET_CAP_MAX && 
                volume5m >= HARD_STOPS.LOW_MCAP_HIGH_VOL_VOLUME_5M_MIN) {
              logger.warn(`🚨 Hard stop (Low Mcap High Vol): ${metadata.symbol} (${token.token}) - mcap=$${marketCap.toFixed(0)} < $${HARD_STOPS.LOW_MCAP_HIGH_VOL_MARKET_CAP_MAX.toFixed(0)} AND vol_5m=$${volume5m.toFixed(0)} >= $${HARD_STOPS.LOW_MCAP_HIGH_VOL_VOLUME_5M_MIN.toFixed(0)}`);
              this.lowMcapHighVolFilteredTokens.add(token.token);
              return false;
            }
          }
        }
        
        return true;
      });
      
      logger.info(`✅ ${analyzableTokens.length}/${tokensPassingHardStops.length} tokens ready for analysis`);
      
      if (analyzableTokens.length === 0) {
        scanLogger.updateFiltering(safeTokens.length, activeTokens.length, tokensPassingHardStops.length, 0);
        scanLogger.updateDecisions(0, 0);
        return {
          decisions: [],
          summary: 'No tokens passed volume/candle checks',
          timestamp: Date.now(),
        };
      }
      
      // ========================================================================
      // Step 4: Calculate selection scores for all tokens (for logging/analytics)
      // REMOVED: Selection limit - we analyze ALL analyzableTokens to match training distribution
      // This ensures training (all ai_ready tokens) matches production (all analyzed tokens)
      // ========================================================================
      const tokensForAI = analyzableTokens; // Analyze all tokens (no limit)
      const tokenScoresMap = new Map<string, number>();
      
      // Calculate scores for all tokens (for logging/analytics, not for filtering)
      analyzableTokens.forEach(token => {
        const metadata = scanResult.tokenMetadata.get(token.token);
        if (!metadata) return;
        
        const securityResult = securityResults.get(token.token);
        const riskScore = securityResult?.riskScore || 50;
        const botDiscoveryCount = token.bots.size;
        const buyVsSellRatio = token.buys / Math.max(token.sells, 1);
        const volume24h = metadata.volume24h || 0;
        
        const { calculateTokenSelectionScore } = require('../utils/scoring-formulas');
        const score = calculateTokenSelectionScore({
          botCount: botDiscoveryCount,
          volume24h,
          buyVsSellRatio,
          riskScore,
          uniqueUsers: token.users.size,
        });
        
        tokenScoresMap.set(token.token, score);
      });
      
      logger.info(`📊 Analyzing all ${tokensForAI.length} analyzable tokens (no selection limit - matches training distribution)`);
      
      // Update scan metrics with filtering results
      scanLogger.updateFiltering(
        safeTokens.length,              // After security checks
        activeTokens.length,            // After activity checks
        tokensPassingHardStops.length,  // After liquidity/volume checks (passed all hard stops)
        tokensForAI.length              // ai_ready tokens (passed all checks AND got candle data)
      );
      
      // ========================================================================
      // Step 5: Log ALL tokens to scanned_tokens (for missed opportunity tracking)
      // ========================================================================
      await this.logAllScannedTokens(
        scanResult, 
        securityResults,
        safeTokens,
        activeTokens,
        analyzableTokens,  // ai_ready tokens (all that passed hard stops and got data)
        tokensForAI,       // tokens analyzed (same as analyzableTokens since no selection limit)
        tokenScoresMap
      );
      
      // ========================================================================
      // Step 6: Fetch portfolio context for duplicate prevention (both AI and Point-Based)
      // ========================================================================
      const portfolioContext = await this.getPortfolioContext();
      
      // ========================================================================
      // Step 7: Build comprehensive AI prompt with ALL data (including portfolio context)
      // ========================================================================
      const prompt = this.buildTradingPrompt(
        tokensForAI,
        scanResult,
        securityResults,
        this.additionalDataMap,
        portfolioContext
      );
      
      //logger.debug('=== AI PROMPT START ===');
      //logger.debug(prompt);
      //logger.debug('=== AI PROMPT END ===');
      
      // ========================================================================
      // Step 8: Analysis (AI or Point-Based)
      // ========================================================================
      let analysis: TradingAnalysis;
      
      if (this.useAI && this.client) {
        // AI Mode
        logger.info('🤖 Sending to Claude for unified analysis...');
        
        const message = await this.client.messages.create({
          // Model options:
          model: 'claude-sonnet-4-20250514', // Sonnet 4 - Superior reasoning, better pattern recognition (recommended)
          // model: 'claude-3-5-haiku-20241022', // Haiku - Fast & cheap for testing (20x cheaper, but less accurate)
          max_tokens: 4000, // Sufficient for 3-5 tokens with detailed analysis
          temperature: 0.5, // Balanced - allows nuanced pattern recognition while staying consistent
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        });

        const content = message.content[0];
        if (content.type !== 'text') {
          logger.warn('Unexpected AI response type');
          return {
            decisions: [],
            summary: 'Analysis failed - unexpected response format',
            timestamp: Date.now(),
          };
        }
        
        // Parse AI response
        //logger.debug('=== AI RESPONSE START ===');
        //logger.debug(content.text);
        //logger.debug('=== AI RESPONSE END ===');
        
        analysis = await this.parseAnalysis(content.text, scanResult, securityResults);
        
      } else if (this.pointBasedAnalyzer) {
        // Point-Based Mode
        logger.info('📊 Analyzing with point-based system...');
        
        analysis = await this.analyzeWithPointSystem(tokensForAI, scanResult, securityResults);
        
        // Log data quality summary
        this.logDataQualitySummary(tokensForAI, scanResult, securityResults);
        
      } else {
        logger.error('No analyzer available (neither AI nor point-based)');
        return {
          decisions: [],
          summary: 'No analyzer available',
          timestamp: Date.now(),
        };
      }
      
      // Note: Tokens that fail hard stops (including extreme price change) are filtered out
      // and logged to DB with filter_stage/filter_reason. They don't create skip decisions
      // because hard stops are pre-analysis filters, not analysis decisions.
      // The extreme price change check happens after data fetching, but it's still a hard stop
      // and should be treated the same as other hard stops (filter + log to DB, no decision).
      
      const buyCount = analysis.decisions.filter(d => d.shouldBuy).length;
      logger.success(`✅ Analysis complete: ${buyCount}/${tokensForAI.length} tokens recommended to BUY`);
      
      return analysis;
      
    } catch (error: any) {
      logger.error('Trading analysis failed', error);
      return {
        decisions: [],
        summary: `Analysis failed: ${error.message}`,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Build the unified trading prompt
   */
  private buildTradingPrompt(
    tokens: any[],
    scanResult: ScanResult,
    securityResults: Map<string, SecurityAnalysis>,
    additionalDataMap: Map<string, any>,
    portfolioContext?: { openPositions: any[], recentExits: any[], stats: any }
  ): string {
    const tokenAnalyses = tokens.map((token, idx) => {
      const metadata = scanResult.tokenMetadata.get(token.token);
      const security = securityResults.get(token.token);
      const data = additionalDataMap.get(token.token);
      
      // Note: data may have null priceAction/volumeMetrics (if fetching failed)
      // Quality checks are informational only - tokens with quality issues are still analyzed
      if (!metadata || !security || !data) return '';
      
      // Calculate token age and freshness
      const ageHours = security.contractAgeDays ? security.contractAgeDays * 24 : null;
      const ageDays = security.contractAgeDays || null;
      let ageLabel = '';
      let freshnessScore = 0;
      
      if (ageHours !== null) {
        if (ageHours < 6) {
          ageLabel = '🔥 ULTRA FRESH (launched <6h ago - PRIME ENTRY)';
          freshnessScore = 100;
        } else if (ageHours < 12) {
          ageLabel = '⚡ VERY FRESH (launched <12h ago - early entry)';
          freshnessScore = 85;
        } else if (ageHours < 24) {
          ageLabel = '✨ FRESH (launched <24h ago - good entry)';
          freshnessScore = 70;
        } else if (ageDays !== null && ageDays < 2) {
          ageLabel = '📅 Recent (1-2 days old)';
          freshnessScore = 50;
        } else if (ageDays !== null && ageDays < 7) {
          ageLabel = '📆 Established (2-7 days)';
          freshnessScore = 30;
        } else {
          ageLabel = '⏰ Mature (>7 days old - upside limited)';
          freshnessScore = 10;
        }
      }
      
      // Format holder concentration if available
      let holderInfo = '';
      if (metadata.holders) {
        holderInfo = `- Holders: ${metadata.holders}`;
        // If mcap and holders available, estimate concentration
        if (metadata.marketCap > 0 && metadata.holders > 0) {
          const avgHolding = metadata.marketCap / metadata.holders;
          if (avgHolding > metadata.marketCap * 0.1) {
            holderInfo += ' (High concentration risk - large avg holdings)';
          } else if (avgHolding > metadata.marketCap * 0.05) {
            holderInfo += ' (Moderate concentration)';
          } else {
            holderInfo += ' (Good distribution)';
          }
        }
      }
      
      return `
### Token ${idx + 1}: ${metadata.symbol} (${metadata.name})
**Address**: ${token.token}

**🕐 TOKEN AGE**: ${ageHours !== null ? `${ageHours.toFixed(1)} hours (${ageDays !== null ? ageDays.toFixed(1) : 'N/A'} days)` : 'Unknown'} ${ageLabel}
${freshnessScore > 0 ? `**⭐ FRESHNESS SCORE: ${freshnessScore}/100**` : ''}

**Trading Activity**:
${data.volumeMetrics && (data.volumeMetrics.txnBuys5m || data.volumeMetrics.txnSells5m) ? 
`- DexScreener (Last 5min): ${data.volumeMetrics.txnBuys5m || 0} Buys | ${data.volumeMetrics.txnSells5m || 0} Sells | Net: ${(data.volumeMetrics.txnBuys5m || 0) - (data.volumeMetrics.txnSells5m || 0) > 0 ? '+' : ''}${(data.volumeMetrics.txnBuys5m || 0) - (data.volumeMetrics.txnSells5m || 0)}
- DexScreener (Last 1h): ${data.volumeMetrics.txnBuys1h || 0} Buys | ${data.volumeMetrics.txnSells1h || 0} Sells
- Buy/Sell Ratio (5m): ${data.volumeMetrics.buyVsSellVolume}:1
- Unique Bot Users (15min): ${token.users.size}` : 
`- Bot-Tracked (Last 15min): ${token.buys} Buys | ${token.sells} Sells | Net: ${token.netBuys > 0 ? '+' : ''}${token.netBuys}
- Unique Bot Users: ${token.users.size}
- Buy/Sell Ratio: ${data.volumeMetrics?.buyVsSellVolume || 'N/A'}:1`}

**Market Data**:
- Price: $${metadata.priceUSD}
- Market Cap: $${metadata.marketCap.toLocaleString()}
- Liquidity: $${metadata.liquidity.toLocaleString()}
- Volume 24h: $${metadata.volume24h.toLocaleString()}
${holderInfo}

**Security** (Risk: ${security.riskScore}/100):
**IMPORTANT**: Security pre-filtering already done. Critical issues (honeypot, hidden functions, blacklist, airdrop scam) have been filtered out.
- Contract Verified: ${security.contractVerified ? 'YES' : 'NO'}
- Honeypot: ${security.honeypotDetected ? 'YES' : 'NO'}
- Ownership: ${security.ownershipRisk ? 'Not renounced' : 'Renounced'}
- LP Lock: ${security.lpLockedPercent ? `${security.lpLockedPercent}% locked` : 'Not locked'}
- Contract Age: ${security.contractAgeDays ? `${security.contractAgeDays.toFixed(1)} days` : 'Unknown'}
${security.risks.length > 0 ? `- RISKS: ${security.risks.join(', ')}` : ''}
${security.warnings.length > 0 ? `- WARNINGS: ${security.warnings.join(', ')}` : ''}


**Candle Data**:
${data.priceAction ? `
**1-Minute Candles (Last ${data.priceAction.candles1m?.length || 0} bars, newest first)**:
${data.priceAction.candles1m && data.priceAction.candles1m.length > 0 ? data.priceAction.candles1m.slice(-15).reverse().map((c: any, i: number) => {
  const timeAgo = Math.floor((Date.now() / 1000 - c.timestamp) / 60);
  const change = ((c.close - c.open) / c.open * 100).toFixed(2);
  const dir = c.close > c.open ? 'GREEN' : c.close < c.open ? 'RED' : 'FLAT';
  const price = c.close >= 0.0001 ? c.close.toFixed(6) : c.close.toFixed(9);
  return `${i+1}. ${dir} ${change}% Close:$${price} Vol:$${Math.round(c.volume)} (${timeAgo}min ago)`;
}).join('\n') : 'No candle data'}
${data.priceAction.patterns1m ? `
Pattern: ${data.priceAction.patterns1m}` : ''}

**5-Minute Candles (Last ${data.priceAction.candles5m?.length || 0} bars, newest first)**:
${data.priceAction.candles5m && data.priceAction.candles5m.length > 0 ? data.priceAction.candles5m.slice(-12).reverse().map((c: any, i: number) => {
  const timeAgo = Math.floor((Date.now() / 1000 - c.timestamp) / 60);
  const change = ((c.close - c.open) / c.open * 100).toFixed(2);
  const dir = c.close > c.open ? 'GREEN' : c.close < c.open ? 'RED' : 'FLAT';
  const price = c.close >= 0.0001 ? c.close.toFixed(6) : c.close.toFixed(9);
  return `${i+1}. ${dir} ${change}% Close:$${price} Vol:$${Math.round(c.volume)} (${timeAgo}min ago)`;
}).join('\n') : 'No candle data'}
${data.priceAction.patterns5m ? `
Pattern: ${data.priceAction.patterns5m}` : ''}
` : '- Data unavailable'}
`;
    }).join('\n---\n');

    // Build portfolio context section (only if we have meaningful data to show)
    let portfolioSection = '';
    if (portfolioContext) {
      const { openPositions, recentExits, stats } = portfolioContext;
      
      // Only show portfolio section if we have trades (open or closed)
      const hasOpenPositions = openPositions.length > 0;
      const hasClosedTrades = stats && stats.closedTrades > 0;
      const hasRecentExits = recentExits.length > 0;
      
      if (hasOpenPositions || hasClosedTrades || hasRecentExits) {
        portfolioSection = `
---

## Current Portfolio Status

`;
      
        // Portfolio Stats (neutral info - no current P&L on open positions)
        if (stats && (hasOpenPositions || hasClosedTrades)) {
          const deployedPercent = stats.deployed_percent || 0;
          const availablePercent = 100 - deployedPercent;
          portfolioSection += `**Portfolio Allocation**: ${deployedPercent.toFixed(0)}% deployed, ${availablePercent.toFixed(0)}% available\n`;
          portfolioSection += `**Balance**: $${stats.currentBalance?.toFixed(0) || '1000'} (${stats.portfolioReturnPercent >= 0 ? '+' : ''}${stats.portfolioReturnPercent?.toFixed(1) || '0.0'}% return)\n`;
          
          // Show open positions with token addresses so AI knows NOT to re-enter
          if (hasOpenPositions) {
            portfolioSection += `**Open Positions**: ${openPositions.length} active\n`;
            openPositions.forEach((pos: any) => {
              const holdMin = Math.floor((Date.now() - new Date(pos.entry_timestamp).getTime()) / 60000);
              portfolioSection += `  - ${pos.symbol} (${pos.token_address}) - Held ${holdMin}min\n`;
            });
            portfolioSection += `\n**IMPORTANT**: Do NOT recommend buying tokens that already have open positions.\n`;
          }
          
          // Add performance metrics
          if (stats.closedTrades > 0) {
            portfolioSection += `**Performance (24h)**: ${stats.closedTrades} trades | ${stats.winRate?.toFixed(0) || '0'}% win rate | Avg hold: ${stats.avgHoldDuration || '0'} min\n`;
          }
          portfolioSection += '\n';
        }
        
        // Recent Exits (last 24h) - learning data
        if (recentExits.length > 0) {
          portfolioSection += `**Recent Exits (last 24 hours - ${recentExits.length} trades)**:\n`;
          recentExits.slice(0, 5).forEach((exit: any) => {
            const pnlSign = exit.pnl_percent >= 0 ? '+' : '';
            const win = exit.pnl_percent >= 0 ? 'WIN' : 'LOSS';
            const reason = exit.exit_reason === 'stop_loss' ? 'Stop Loss' : 
                          exit.exit_reason === 'take_profit_1' ? 'TP1' :
                          exit.exit_reason === 'take_profit_2' ? 'TP2' :
                          exit.exit_reason === 'take_profit_3' ? 'TP3' :
                          exit.exit_reason === 'time_based' ? 'Time Exit' : 'Exit';
            
            const holdDuration = exit.hold_duration_minutes || 0;
            const notes = exit.notes ? ` - ${exit.notes}` : '';
            
            portfolioSection += `  ${win} **${exit.symbol}**: ${pnlSign}${exit.pnl_percent.toFixed(1)}% (${reason}, ${holdDuration}min hold)${notes}\n`;
          });
          portfolioSection += '\n';

          // Instructions for using this context
          portfolioSection += `**Use This Context**:
  - **Learn from exits**: Analyze recent wins/losses - what patterns led to success? What failed?
    ${recentExits.filter((e: any) => e.pnl_percent < 0).length >= 2 ? '- WARNING: Recent losses suggest being MORE SELECTIVE on entries' : ''}
  - **Respect portfolio limits**: ${stats.deployed_percent >= 70 ? 'WARNING: Portfolio >70% deployed - Only EXCEPTIONAL setups!' : 'Capital available for quality opportunities'}
  - **Hold time analysis**: Avg hold ${stats.avgHoldDuration}min - ${stats.avgHoldDuration < 40 ? 'exits are quick (good for volatile tokens)' : 'positions held longer (need strong conviction)'}
  - **Re-entry consideration**: If analyzing a token we recently exited, require strong new signals
  `;
        }
      } // End of hasOpenPositions || hasClosedTrades || hasRecentExits
    } // End of if (portfolioContext)

    // Get chain information to inform the AI
    const chainConfig = getChainConfig();
    const chainName = chainConfig.chain === Chain.SOLANA ? 'Solana' : 'BSC (Binance Smart Chain)';

    return `ANALYZE THESE TOKENS NOW AND RETURN JSON.

You are a professional crypto trader analyzing **${chainName} tokens** for potential buy opportunities. Analyze each token below and return your decisions in JSON format (do NOT ask questions, do NOT wait for approval - analyze NOW).

${portfolioSection}
## Tokens to Analyze

${tokenAnalyses}

---

## Your Task

Analyze each token above and decide: **BUY** or **SKIP**

**IMPORTANT CONTEXT**: You are analyzing ${chainName} tokens.
${chainConfig.chain === Chain.SOLANA ? '- Solana: Sells data will be 0 (only buys are tracked) - focus on buy momentum and volume\n- Tokens may have higher volatility - consider wider stop losses' : '- BSC: Both buys and sells are tracked - use buy/sell ratio for analysis'}

### Trading Strategy: FRESH TOKEN PLAYS (MEDIUM RISK, HIGH REWARD)

**WHAT TO BUY**:
- **Age**: Prefer <24h old (fresher = more upside)
- **Market Cap**: $10K-$100K (room to grow)
- **Unique Bot Users**: more better, discovered by trading bots
- **Recent Volume**: 5m/15m volume strong + accelerating upwards
- **Strong buy/sell ratio**: (>1.5:1 = net buying pressure)
- **Candles**: Recent 1m bars GREEN (buying NOW), 5m shows higher lows/accumulation/breakout patterns

**INSTANT SKIP (DO NOT OVERRIDE THESE UNDER ANY CIRCUMSTANCES)**:

**1. BUYING AT THE TOP OF PUMP (MOST COMMON MISTAKE)**:
- **5m candle >+30%** AND **1m candle >+20%** AND **volume declining** = extreme top
- **Multiple consecutive 5m candles >+15%** AND **volume fading** = pump exhaustion
- **Pattern: "THREE GREEN BARS" in 5m** = MIGHT be END of pump, not beginning

**2. REVERSAL SIGNALS**:
- **1m candles RED** (last 2-3 bars) = momentum already reversing
- **Pattern says**: "THREE RED BARS", "LOWER HIGHS", "LONG UPPER WICK" in 5m = sellers winning
- **5m turned red after green** = pump failed, dumping now

**3. VOLUME ISSUES**:
- **Dead volume**: 24h vol high BUT 15m vol <$5K = old pump, no new buyers
- **Inverse volume**: High volume with price falling = distribution/exit liquidity
- **Volume declining on green candles** = pump fading

**4. RED FLAGS**:
- **Selling pressure**: Much more sells than buys (if sell data available)
- **Major dump**: 4h down >30% AND still falling (5m/1m negative)

**WHEN TO BUY (GOOD ENTRIES)**:
- **After pullback/consolidation**: Token dumped -20-40%, now showing FIRST signs of recovery
- **Breakout from consolidation**: 1m/5m flat for 10+ minutes, then breaks up with volume
- **Retest of support**: Token pumped, pulled back, and is now retesting breakout level
- **Fresh token just appearing**: <2h old, first wave of buying, small green candles building (+2-5%, not +20%)
- **Pattern: "HIGHER LOWS" + small green candles** = accumulation
- **For tokens <4h old**: Focus on VOLUME and FUNDAMENTALS, less on candle patterns

**CONFIDENCE SCORING** (be honest, vary widely):
- **95-100**: Perfect setup - ultra-fresh + accelerating pump + low risk + strong volume + all signals align
- **85-94**: Excellent - 4+ strong signals, minor concerns
- **75-84**: Good - 3 strong signals, some concerns
- **70-74**: Acceptable - 2 strong signals, notable risks
- **50-69**: Marginal - mixed signals (SKIP)
- **30-49**: Weak - more negatives than positives (SKIP)
- **10-29**: Poor - clear failures (SKIP)

**CRITICAL: AVOID CONFIDENCE ANCHORING**:
- DO NOT default to 78% or any "safe" number
- ACTUALLY CALCULATE based on signals present
- Use the FULL range (70-100 for BUY decisions)
- Ask yourself: "How many strong signals do I see?" Then map to score

**VOLUME RULE**:
- **24h volume can be MISLEADING** for tokens >6h old (includes old pumps)
- **PRIORITIZE**: 5m over 1m volume, velocity, acceleration.
- **Example TRAP**: Token shows $2M 24h volume BUT only $6K in last 15min + only 3 trades = SKIP (pump already happened)
- **Good signal**: 5m vol >$1K, 15m vol >$3K, acceleration positive (volume and price INCREASING)
- **CRITICAL**: High volume during DOWN trend (negative price change) = SELL PRESSURE, not buying opportunity!

**CANDLE READING** - Primary timing signal:
- **Fresh tokens <2h old**: Focus on VOLUME and FUNDAMENTALS, less on candle patterns
- **1m candles**: Use to see if buying is happening NOW (green) or selling (red)
- **5m candles**: Use to see overall trend
- **GOOD Entry**: Last 2-3 x 1m candles GREEN + 5m showing higher lows/reversal/breakout
- **BAD Entry**: Last 2-3 x 1m candles RED (even if 5m looks good - already reversing)
- **Red candles can be OK** if: Volume is increasing, multiple bots discovering, buy/sell ratio is positive
- **Volume confirmation**: GREEN candles should have INCREASING volume (not fading)
- **Pattern priority**: 1m candles (timing) > 5m pattern (trend) > 4h context (history)
- **Red flag**: Big 4h pump BUT recent 5m/1m RED = late to the party (SKIP)
- **Size matters**: Look at the MAGNITUDE of green candles, not just the color

**RISK TOLERANCE**:
- Risk 0-60: Good for fresh tokens
- Risk 61-75: OK if momentum/candles VERY strong  
- Risk 76+: Skip unless exceptional

**MULTI-TOKEN**:
- Max 2-3 recommendations (quality > quantity)
- If portfolio >70% deployed: only EXCEPTIONAL setups

**POSITION SIZING** - CRITICAL: Conservative sizing to preserve capital and match ML training:
- **70-80 confidence**: 0.5-0.75% (cautious, normal trades)
- **81-90 confidence**: 0.75-1.25% (good setups)
- **91-100 confidence**: 1.25-2% (exceptional only, rare)
- **NEVER exceed 2%** (hard limit even for perfect setups)
- Can adjust down based on portfolio allocation (lower if >50% deployed)
- ML models assume this sizing range - deviating reduces accuracy

**STOP LOSS** - CRITICAL: Keep stops TIGHT to preserve capital:
- **Default: -15%** (most trades should use this)
- **High conviction setups: -18% to -20%** (if exceptional setup with small position)
- **NEVER wider than -20%** unless you have extraordinary reason
- Our data shows tokens that never went up: need tight stops to cut losses fast
- Many tokens reverse immediately after entry: -15% stop catches this early

**TAKE PROFIT** - LOCK IN PROFITS EARLY (tokens reverse fast):
- **TP1 around 15%** (sell 40% - CRITICAL: Data shows 100% of winners hit this level, captures early momentum)
- **TP2 around 30%** (sell 35% - ~70% of winners reach here, locks substantial gains)
- **TP3 around 50%** (sell 25% - rare but possible for strong runners)
- You can adjust slightly based on setup (e.g., 12-18% for TP1, 25-35% for TP2, 45-60% for TP3)
- **IMPORTANT**: Many tokens hit +20-40% MaxGain but then reverse → Setting TP1 near 15% captures this

### Response Format

Return ONLY valid JSON. **DO NOT COPY THESE PLACEHOLDER VALUES** - calculate ALL numbers based on actual token data:

\`\`\`json
{
  "decisions": [
    {
      "token": "<actual_token_address>",
      "symbol": "<actual_symbol>",
      "shouldBuy": true,
      "confidence": <CALCULATE: 70-100 based on how many strong signals align>,
      "reasoning": "<Token age + mcap context>. **<Actual 5m/1m %>**. <Actual 1m pattern seen>. <Actual 5m pattern>. <Volume metrics>. <Why this SL/position size>",
      
      "positionSize": {
        "percentage": <CALCULATE: 0.5-2 based on confidence + portfolio + risk>
      },
      
      "riskManagement": {
        "stopLoss": <CALCULATE: analyze candle volatility, fresher = wider>,
        "takeProfitLevels": [
          { "percentage": <CALCULATE: based on mcap/momentum>, "sellPercent": <CALCULATE: 30-50> },
          { "percentage": <CALCULATE: 1.5-3x of TP1>, "sellPercent": <CALCULATE: 30-50> },
          { "percentage": <CALCULATE: 2-4x of TP2>, "sellPercent": <CALCULATE: 20-40> }
        ]
      },
      
      "opportunities": [
        "<List SPECIFIC reasons from token data - NOT generic statements>"
      ],
      
      "risks": [
        "<List SPECIFIC concerns from token data - NOT generic statements>"
      ],
      
      "warnings": [
        "<SPECIFIC warnings if any>"
      ]
    },
    {
      "token": "<another_token_address>",
      "symbol": "<another_symbol>",
      "shouldBuy": false,
      "confidence": <CALCULATE: honest low score 10-69>,
      "reasoning": "<SPECIFIC reason why SKIP - reference actual data>",
      
      "opportunities": [],
      
      "risks": [
        "<SPECIFIC failures that disqualify this token>"
      ],
      
      "warnings": []
    }
  ],
  "summary": "<Your actual analysis - what did you see across these tokens?>"
}
\`\`\`


**CRITICAL RULES**:
- **DO NOT ASK QUESTIONS** - Analyze and return JSON immediately
- Only set \`shouldBuy: true\` if confidence >70 AND you see clear upside potential
- Pattern priority: Fundamentals (bots, volume, age) > Volume trend > 5m pattern > 1m candles
- Focus MORE on momentum/fundamentals/candles and LESS on risk score, security
- Always explain why in opportunities/risks (reference specific candle patterns, age, mcap)
- Be conservative - better to miss a trade than lose money

**REASONING QUALITY GUIDELINES**:
Your \`reasoning\` field is CRITICAL - it's what the trader sees first. Make it:

1. **Concise** (2-4 sentences max):
   - GOOD: "Ultra fresh (2h), $50K mcap. 1m: THREE GREEN BARS, 5m: HIGHER LOWS. Volume +3.2x. Using -22% stop to avoid shakeouts."
   - BAD: "This token is ultra fresh and has been launched only 4 hours ago which is very early and the market cap is only $50K which means..."

2. **Data-Driven** (reference SPECIFIC metrics):
   - GOOD: "1m candles: THREE GREEN BARS" (not "candles look good")
   - GOOD: "Pattern: STRONG BUYING + HIGHER LOWS" (not "good pattern")
   - GOOD: "Volume +3.2x" (not "volume increasing")
   - GOOD: "$50K mcap with 20x potential" (not "low mcap")

3. **Explain Risk Management Choices**:
   - GOOD: "Using wide -22% stop to avoid shakeouts"
   - GOOD: "Wider -20% stop for established token"
   - GOOD: "Conservative 3% position due to moderate risk"
   - BAD: Don't just state values without explaining WHY

4. **For SKIP decisions - Be SPECIFIC about failure**:
   - GOOD: "1m candles: THREE RED BARS dumping NOW"
   - GOOD: "Pattern: REVERSAL + LOWER HIGHS (bearish)"
   - GOOD: "Similar to recent loss on TOKEN_XYZ"
   - BAD: "Not a good entry" (too vague)

5. **Structure** (follow this order):
   - Token characteristics (age, mcap, potential)
   - 1m candles status (MOST IMPORTANT - what's happening NOW)
   - 5m pattern (overall context)
   - Volume/momentum metrics
   - Risk management explanation (why this SL%, why this position size)

**Example Structure:**
"[Characteristics]. [1m candles status]. [5m pattern]. [Volume/metrics]. [Risk mgmt reasoning]."

"Ultra fresh (2h), $50K mcap = 20x potential. 1m: THREE GREEN BARS (buying now!). 5m: HIGHER LOWS (accumulation). Volume +3.2x. Using -22% stop to avoid shakeouts, 4% position for balanced risk."`;

  }

  /**
   * Parse AI response and build trading decisions
   */
  private async parseAnalysis(
    aiResponse: string,
    scanResult: ScanResult,
    securityResults: Map<string, SecurityAnalysis>
  ): Promise<TradingAnalysis> {
    try {
      // Extract JSON from response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.error('Failed to extract JSON from AI response');
        return {
          decisions: [],
          summary: 'Failed to parse AI response',
          timestamp: Date.now(),
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      // Enrich decisions with market data and security analysis
      const decisions: TradingDecision[] = (parsed.decisions || []).map((dec: any) => {
        const token = scanResult.topTokens.find(t => t.token === dec.token);
        const metadata = scanResult.tokenMetadata.get(dec.token);
        const security = securityResults.get(dec.token);
        
        if (!token || !metadata) {
          logger.warn(`Token ${dec.token} not found in scan results`);
          return null;
        }
        
        // Get additional data (includes volumeMetrics with DexScreener transaction counts)
        const additionalData = this.additionalDataMap?.get(dec.token);
        
        // Prefer DexScreener transaction counts (5min) over bot-tracked (15min)
        // This is more accurate for Solana and covers all DEXs
        const buys = additionalData?.volumeMetrics?.txnBuys5m || token.buys;
        const sells = additionalData?.volumeMetrics?.txnSells5m || token.sells;
        const buyVsSellRatio = additionalData?.volumeMetrics?.buyVsSellVolume;
        
        // ========================================================================
        // VALIDATE AI's RESPONSE - Only essential safety checks, trust AI's judgment
        // ========================================================================
        
        // Validate required fields
        if (typeof dec.shouldBuy !== 'boolean') {
          logger.warn(`${dec.symbol}: Missing shouldBuy field, defaulting to false`);
          dec.shouldBuy = false;
        }
        
        // Validate confidence (0-100 range only)
        let confidence = typeof dec.confidence === 'number' ? dec.confidence : 0;
        confidence = Math.min(100, Math.max(0, confidence));
        
        // Enforce minimum confidence threshold (hard rule from prompt)
        if (confidence < 70 && dec.shouldBuy) {
          logger.warn(`${dec.symbol}: AI tried to buy with low confidence (${confidence}%), overriding to SKIP`);
          dec.shouldBuy = false;
        }
        
        // Validate position sizing (only type check and sign)
        let validatedPositionSize = dec.positionSize;
        if (dec.shouldBuy && dec.positionSize) {
          const percentage = typeof dec.positionSize.percentage === 'number' && dec.positionSize.percentage > 0
            ? dec.positionSize.percentage
            : 3;  // Fallback only if invalid
          
          const maxUsdAmount = typeof dec.positionSize.maxUsdAmount === 'number' && dec.positionSize.maxUsdAmount > 0
            ? dec.positionSize.maxUsdAmount
            : 100;  // Fallback only if invalid
          
          validatedPositionSize = { percentage, maxUsdAmount };
        }
        
        // Validate risk management (only type check and sign)
        let validatedRiskMgmt = dec.riskManagement;
        if (dec.shouldBuy && dec.riskManagement) {
          // Stop loss: must be negative
          let stopLoss = typeof dec.riskManagement.stopLoss === 'number' 
            ? dec.riskManagement.stopLoss 
            : -15;  // Fallback only if invalid
          
          if (stopLoss > 0) {
            logger.warn(`${dec.symbol}: Stop loss is positive (${stopLoss}%), converting to negative`);
            stopLoss = -Math.abs(stopLoss);
          }
          
          // Take profit levels: validate structure only
          let tpLevels = Array.isArray(dec.riskManagement.takeProfitLevels) 
            ? dec.riskManagement.takeProfitLevels 
            : [];
          
          // Filter invalid entries (type check only)
          tpLevels = tpLevels
            .filter((tp: any) => 
              typeof tp.percentage === 'number' && tp.percentage > 0 &&
              typeof tp.sellPercent === 'number' && tp.sellPercent > 0 && tp.sellPercent <= 100
            )
            .sort((a: any, b: any) => a.percentage - b.percentage);  // Ensure ascending order
          
          // Must have at least 2 TP levels (fallback only if invalid)
          if (tpLevels.length < 2) {
            logger.warn(`${dec.symbol}: Insufficient TP levels (${tpLevels.length}), using defaults`);
            tpLevels = [
              { percentage: 25, sellPercent: 30 },
              { percentage: 50, sellPercent: 40 },
              { percentage: 100, sellPercent: 30 },
            ];
          }
          
          validatedRiskMgmt = {
            stopLoss,
            takeProfitLevels: tpLevels,
          };
        }
        
        // Extract bot discovery data for performance tracking
        const discoveredByBots = Array.from(token.bots);
        const primaryBot = discoveredByBots.length > 0 ? discoveredByBots[0] : undefined;
        
        return {
          ...dec,
          confidence,
          positionSize: validatedPositionSize,
          riskManagement: validatedRiskMgmt,
          name: metadata.name,
          marketData: {
            price: metadata.priceUSD,
            marketCap: metadata.marketCap,
            liquidity: metadata.liquidity,
            volume24h: metadata.volume24h,
            buys,  // DexScreener (5min) if available, else bot-tracked (15min)
            sells, // DexScreener (5min) if available, else bot-tracked (15min)
            users: token.users.size,
            buyVsSellRatio,
          },
          securityAnalysis: security,
          discoveredByBots,  // Bot performance tracking
          primaryBot,        // Bot performance tracking
        };
      }).filter((d: any) => d !== null);
      
      // Log ALL decisions to database
      await this.logDecisions(decisions, scanResult, securityResults);
      
      return {
        decisions,
        summary: parsed.summary || 'Analysis complete',
        timestamp: Date.now(),
      };
      
    } catch (error: any) {
      logger.error('Failed to parse AI response:', error);
      logger.debug('Raw response:', aiResponse);
      return {
        decisions: [],
        summary: `Failed to parse response: ${error.message}`,
        timestamp: Date.now(),
      };
    }
  }
  
  /**
   * Log all decisions to database
   */
  private async logDecisions(
    decisions: TradingDecision[],
    scanResult: ScanResult,
    securityResults: Map<string, SecurityAnalysis>
  ): Promise<void> {
    try {
      // Use scanId from scanLogger (ensures consistency with scans table)
      const scanId = scanLogger.getCurrentScanId() || `scan_${Date.now()}`;
      
      for (const decision of decisions) {
        const token = scanResult.topTokens.find(t => t.token === decision.token);
        const metadata = scanResult.tokenMetadata.get(decision.token);
        const security = securityResults.get(decision.token);
        
        if (!token || !metadata || !security) continue;
        
        // Calculate freshness score (same logic as in prompt building)
        const ageHours = security.contractAgeDays ? security.contractAgeDays * 24 : null;
        let freshnessScore = 0;
        if (ageHours !== null && security.contractAgeDays) {
          if (ageHours < 6) freshnessScore = 100;
          else if (ageHours < 12) freshnessScore = 85;
          else if (ageHours < 24) freshnessScore = 70;
          else if (security.contractAgeDays < 2) freshnessScore = 50;
          else if (security.contractAgeDays < 7) freshnessScore = 30;
          else freshnessScore = 10;
        }
        
        // Extract bot discovery data
        const discoveredByBots = Array.from(token.bots); // Get all bots that traded this token
        const botActivityJson: Record<string, { buys: number; sells: number }> = {};
        token.botActivity.forEach((activity, botName) => {
          botActivityJson[botName] = {
            buys: activity.buys,
            sells: activity.sells,
          };
        });
        const multiBotSignal = discoveredByBots.length >= 2; // TRUE if 2+ bots
        const totalBotsCount = discoveredByBots.length;
        
        // Get DexScreener trading data (5-minute snapshot)
        const additionalData = this.additionalDataMap?.get(decision.token);
        const volumeMetrics = additionalData?.volumeMetrics;
        
        // Get current strategy ID from database
        const strategyId = await getStrategyId();
        
        const decisionLog: DecisionLog = {
          tokenAddress: decision.token,
          symbol: decision.symbol,
          name: decision.name,
          shouldBuy: decision.shouldBuy,
          confidence: decision.confidence,
          reasoning: decision.reasoning,
          mlPredictedReturn: decision.mlPredictedReturn,
          mlExpectedValue: decision.mlExpectedValue,
          ageHours,
          freshnessScore,
          marketCap: metadata.marketCap,
          liquidity: metadata.liquidity,
          volume5m: decision.marketData?.volume24h ? decision.marketData.volume24h / (24 * 12) : 0, // estimate
          volumeAcceleration: 0, // we don't have this in decision, but it's in additionalDataMap
          uniqueUsers: token.users.size,
          totalTrades: token.buys + token.sells,
          riskScore: security.riskScore,
          priceUsd: metadata.priceUSD,
          priceChange1m: 0, // not available in this context
          priceChange5m: 0,
          trend: 'unknown',
          positionSizePercent: decision.positionSize?.percentage,
          positionSizeUsd: decision.positionSize?.maxUsdAmount,
          stopLossPercent: decision.riskManagement?.stopLoss,
          takeProfitLevels: decision.riskManagement?.takeProfitLevels.map(tp => tp.percentage),
          // Strategy tracking (FK to strategies table)
          strategyId: strategyId || undefined,
          // Bot Discovery Tracking
          discoveredByBots,
          botActivityJson,
          multiBotSignal,
          totalBotsCount,
          // DexScreener Trading Data (5-minute snapshot)
          txnBuys5m: volumeMetrics?.txnBuys5m,
          txnSells5m: volumeMetrics?.txnSells5m,
          buySellRatio: volumeMetrics?.buyVsSellVolume,
          // AI Analysis Details (for Telegram messages)
          opportunities: decision.opportunities || [],
          risks: decision.risks || [],
          warnings: decision.warnings || [],
          scanId,
          // Store raw scanner data for analytics
          scannerData: {
            ageSeconds: ageHours ? ageHours * 3600 : null,
            contractAgeDays: security.contractAgeDays,
            userCount: token.users.size,
            buyCount: token.buys,
            sellCount: token.sells,
            netFlow: token.buys - token.sells,
            priceUsd: metadata.priceUSD,
            marketCap: metadata.marketCap,
            liquidity: metadata.liquidity,
            volume24h: metadata.volume24h,
            priceChange24h: metadata.priceChange24h,
            riskScore: security.riskScore,
            isHoneypot: security.honeypotDetected || false,
            hasUnverifiedContract: !security.contractVerified,
            hasHighTax: (security.buyTax || 0) + (security.sellTax || 0) > 10,
            scanTimestamp: new Date().toISOString(),
          },
        };
        
        // Store decision ID for later retrieval (e.g., for paper trading)
        const decisionId = await this.decisionLogger.logDecision(decisionLog);
        this.decisionIdMap.set(decision.token, decisionId);
      }
      
      logger.info(`📊 Logged ${decisions.length} decisions to database (scan: ${scanId})`);
      
    } catch (error) {
      logger.error('Failed to log decisions:', error);
    }
  }

  /**
   * Log ALL tokens from scan to scanned_tokens table (for missed opportunity tracking)
   */
  private async logAllScannedTokens(
    scanResult: ScanResult,
    securityResults: Map<string, SecurityAnalysis>,
    safeTokens: any[],
    activeTokens: any[],
    analyzableTokens: any[],
    tokensForAI: any[],
    tokenScores?: Map<string, number>  // NEW: selection scores for display
  ): Promise<void> {
    try {
      const scanId = scanLogger.getCurrentScanId() || `scan_${Date.now()}`;
      const chainConfig = getChainConfig();
      
      // Batch check for previously blocked tokens (performance optimization)
      const tokenAddresses = scanResult.topTokens.map(t => t.token);
      const previouslyBlockedMap = await checkPreviouslyBlocked(tokenAddresses);
      
      const tokensToLog: any[] = [];
      
      for (const token of scanResult.topTokens) {
        const metadata = scanResult.tokenMetadata.get(token.token);
        const security = securityResults.get(token.token);
        const additionalData = this.additionalDataMap?.get(token.token);
        const volumeMetrics = additionalData?.volumeMetrics;
        const priceAction = additionalData?.priceAction;
        
        // Extract bot discovery data
        const discoveredByBots = Array.from(token.bots);
        const botActivityJson: Record<string, { buys: number; sells: number }> = {};
        token.botActivity.forEach((activity, botName) => {
          botActivityJson[botName] = {
            buys: activity.buys,
            sells: activity.sells,
          };
        });
        
        const ageHours = security?.contractAgeDays ? security.contractAgeDays * 24 : undefined;
        
        // Check if token was previously blocked by permanent filters
        const previouslyBlocked = previouslyBlockedMap.get(token.token);
        let filterStage: string | null;
        let filterReason: string | null;
        
        if (previouslyBlocked?.blocked) {
          // Token was previously blocked by a permanent filter - block it again
          filterStage = 'previously_blocked';
          filterReason = `was_${previouslyBlocked.filter}`;
          logger.warn(`🚨 Hard stop (Previously Blocked): ${metadata?.symbol || token.token} - was blocked by ${previouslyBlocked.filter}`);
        } else {
          // Determine filter stage and reason using normal logic
          const filterInfo = this.determineFilterInfo(
            token,
            metadata,
            security,
            volumeMetrics,
            safeTokens,
            activeTokens,
            analyzableTokens,
            tokensForAI
          );
          filterStage = filterInfo.filterStage;
          filterReason = filterInfo.filterReason;
        }
        
        // Get selection score if available
        const selectionScore = tokenScores?.get(token.token);
        
        tokensToLog.push({
          scanId,
          tokenAddress: token.token,
          chain: chainConfig.chain,
          symbol: metadata?.symbol,
          name: metadata?.name,
          discoveredByBots: discoveredByBots.length > 0 ? discoveredByBots : undefined,
          priceUsd: metadata?.priceUSD,
          marketCap: metadata?.marketCap,
          liquidity: metadata?.liquidity,
          volume24h: metadata?.volume24h,
          priceChange24h: this.additionalDataMap.get(token.token)?.priceAction?.priceChange24h ?? metadata?.priceChange24h, // Prefer DexScreener, fallback to Codex
          holders: metadata?.holders,
          scannerData: {
            buys: token.buys,
            sells: token.sells,
            netBuys: token.netBuys,
            uniqueUsers: token.users.size,
            totalActivity: token.totalActivity,
          },
          botBuys: token.buys,
          botSells: token.sells,
          netBuys: token.netBuys,
          uniqueUsers: token.users.size,
          totalActivity: token.totalActivity,
          botActivityJson: Object.keys(botActivityJson).length > 0 ? botActivityJson : undefined,
          totalBotsCount: discoveredByBots.length,
          multiBotSignal: discoveredByBots.length >= 2,
          volume5m: volumeMetrics?.volume5m,
          volume1h: volumeMetrics?.volume1h,
          volume6h: volumeMetrics?.volume6h,
          txnBuys5m: volumeMetrics?.txnBuys5m,
          txnSells5m: volumeMetrics?.txnSells5m,
          txnBuys1h: volumeMetrics?.txnBuys1h,
          txnSells1h: volumeMetrics?.txnSells1h,
          txnBuys6h: volumeMetrics?.txnBuys6h,
          txnSells6h: volumeMetrics?.txnSells6h,
          txnBuys24h: volumeMetrics?.txnBuys24h,
          txnSells24h: volumeMetrics?.txnSells24h,
          buySellRatio: volumeMetrics?.buyVsSellVolume,
          // Extended DexScreener data (from volumeMetrics)
          priceChange5m: additionalData?.volumeMetrics?.priceChange5m,
          priceChange1h: additionalData?.volumeMetrics?.priceChange1h,
          priceChange6h: additionalData?.volumeMetrics?.priceChange6h,
          priceChange24hDex: additionalData?.volumeMetrics?.priceChange24h,
          pairAddress: additionalData?.volumeMetrics?.pairAddress,
          dexId: additionalData?.volumeMetrics?.dexId,
          quoteToken: additionalData?.volumeMetrics?.quoteToken,
          pairCreatedAt: additionalData?.volumeMetrics?.pairCreatedAt,
          liquidityBase: additionalData?.volumeMetrics?.liquidityBase,
          liquidityQuote: additionalData?.volumeMetrics?.liquidityQuote,
          fdv: additionalData?.volumeMetrics?.fdv,
          // Extended Codex data
          volume5mCodex: metadata?.volume5m,
          volume1hCodex: metadata?.volume1h,
          volume4hCodex: metadata?.volume4h,
          volume24hCodex: metadata?.volume24hCodex,
          buyCount5mCodex: metadata?.buyCount5m,
          sellCount5mCodex: metadata?.sellCount5m,
          buyCount1hCodex: metadata?.buyCount1h,
          sellCount1hCodex: metadata?.sellCount1h,
          buyCount4hCodex: metadata?.buyCount4h,
          sellCount4hCodex: metadata?.sellCount4h,
          buyCount24hCodex: metadata?.buyCount24h,
          sellCount24hCodex: metadata?.sellCount24h,
          uniqueBuys5mCodex: metadata?.uniqueBuys5m,
          uniqueSells5mCodex: metadata?.uniqueSells5m,
          uniqueBuys1hCodex: metadata?.uniqueBuys1h,
          uniqueSells1hCodex: metadata?.uniqueSells1h,
          uniqueBuys24hCodex: metadata?.uniqueBuys24h,
          uniqueSells24hCodex: metadata?.uniqueSells24h,
          uniqueTransactions5mCodex: metadata?.uniqueTransactions5m,
          uniqueTransactions1hCodex: metadata?.uniqueTransactions1h,
          uniqueTransactions24hCodex: metadata?.uniqueTransactions24h,
          swapPct1dOldWallet: metadata?.swapPct1dOldWallet,
          swapPct7dOldWallet: metadata?.swapPct7dOldWallet,
          walletAgeAvg: metadata?.walletAgeAvg,
          walletAgeStd: metadata?.walletAgeStd,
          isScamCodex: metadata?.isScam,
          bundlerCount: metadata?.bundlerCount,
          sniperCount: metadata?.sniperCount,
          insiderCount: metadata?.insiderCount,
          bundlerHeldPercentage: metadata?.bundlerHeldPercentage,
          sniperHeldPercentage: metadata?.sniperHeldPercentage,
          insiderHeldPercentage: metadata?.insiderHeldPercentage,
          devHeldPercentage: metadata?.devHeldPercentage,
          isSafe: security?.isSafe,
          riskScore: security?.riskScore,
          honeypotDetected: security?.honeypotDetected,
          ownershipRisk: security?.ownershipRisk,
          blacklistDetected: security?.blacklistDetected,
          hiddenFunctions: security?.hiddenFunctionsDetected,
          buyTax: security?.buyTax,
          sellTax: security?.sellTax,
          canTakeBackOwnership: security?.canTakeBackOwnership,
          ownerPercent: security?.ownerPercent,
          top10HolderPercent: security?.top10HolderPercent,
          ageHours,
          filterStage,
          filterReason,
          // Jupiter quote data (from Solana security scanner - pre-trade liquidity check)
          // BUY quote (entry liquidity)
          jupiterBuyQuoteSuccess: (security as any)?.jupiterBuyQuoteSuccess,
          jupiterBuyQuotePriceImpact: (security as any)?.jupiterBuyQuotePriceImpact,
          jupiterBuyQuoteOutAmount: (security as any)?.jupiterBuyQuoteOutAmount,
          jupiterBuyQuoteRoutesCount: (security as any)?.jupiterBuyQuoteRoutesCount,
          jupiterBuyQuoteError: (security as any)?.jupiterBuyQuoteError,
          // SELL quote (exit liquidity)
          jupiterSellQuoteSuccess: (security as any)?.jupiterSellQuoteSuccess,
          jupiterSellQuotePriceImpact: (security as any)?.jupiterSellQuotePriceImpact,
          jupiterSellQuoteOutAmount: (security as any)?.jupiterSellQuoteOutAmount,
          jupiterSellQuoteRoutesCount: (security as any)?.jupiterSellQuoteRoutesCount,
          jupiterSellQuoteError: (security as any)?.jupiterSellQuoteError,
          selectionScore,  // NEW: include selection score
          // Calculated quantitative metrics
          volatility5m: priceAction?.volatility5m,
          volatility1h: priceAction?.volatility1h,
          volatility24h: priceAction?.volatility24h,
          momentumScore: priceAction?.momentumScore,
          momentumDirection: priceAction?.momentumDirection,
          volumeRatio5m1h: volumeMetrics?.volumeRatio5m1h,
          volumeRatio1h24h: volumeMetrics?.volumeRatio1h24h,
          volumeVelocity: volumeMetrics?.volumeVelocity,
          volumeAcceleration: volumeMetrics?.volumeAcceleration,
          // Smart money metrics (from scanner)
          smartMoneyWalletCount: token.smartMoneyWalletCount ?? null,
          smartMoneyWalletAddresses: token.smartMoneyWalletAddresses ?? null,
          smartMoneyBuyCount: token.smartMoneyBuyCount ?? null,
          smartMoneyBuyPercentage: token.smartMoneyBuyPercentage ?? null,
          smartMoneyConvictionScore: token.smartMoneyConvictionScore ?? null,
        });
        
        // Debug: Log if smart money data is present
        if (token.smartMoneyWalletCount && token.smartMoneyWalletCount > 0) {
          logger.debug(`💰 [Smart Money] Saving to DB for ${token.token.substring(0, 16)}...:`);
          logger.debug(`   - walletCount: ${token.smartMoneyWalletCount}`);
          logger.debug(`   - walletAddresses: ${token.smartMoneyWalletAddresses?.length || 0} addresses`);
          logger.debug(`   - buyCount: ${token.smartMoneyBuyCount || 0}`);
          logger.debug(`   - buyPercentage: ${token.smartMoneyBuyPercentage?.toFixed(2) || 'null'}%`);
          logger.debug(`   - convictionScore: ${token.smartMoneyConvictionScore || 0}`);
        }
      }
      
      if (tokensToLog.length === 0) {
        logger.warn(`No tokens to log to scanned_tokens (scan: ${scanId})`);
        logger.warn(`   Top tokens count: ${scanResult.topTokens.length}`);
        logger.warn(`   Metadata map size: ${scanResult.tokenMetadata.size}`);
        logger.warn(`   Security results size: ${securityResults.size}`);
        return;
      }
      
      logger.info(`📊 Logging ${tokensToLog.length} tokens to scanned_tokens table (scan: ${scanId})`);
      const loggedTokens = await scannedTokensLogger.logTokensBatch(tokensToLog);
      logger.info(`✅ Successfully logged ${loggedTokens.length} tokens to scanned_tokens table (scan: ${scanId})`);
      
      // Create map of token address -> logged token info for quick lookup
      const loggedTokensMap = new Map(
        loggedTokens.map(logged => [logged.tokenAddress, logged])
      );
      
      // Log candles and calculate PA features ONLY for ai_ready tokens
      // This avoids wasting API calls and DB storage for tokens that won't be used
      let candlesLogged = 0;
      let paFeaturesUpdated = 0;
      const { priceActionCalculator } = await import('./price-action-features');
      
      // Filter to only ai_ready tokens
      const aiReadyTokens = loggedTokens.filter(logged => logged.filterStage === 'ai_ready');
      
      for (const logged of aiReadyTokens) {
        const token = scanResult.topTokens.find(t => t.token === logged.tokenAddress);
        if (!token) continue;
        
        const additionalData = this.additionalDataMap?.get(token.token);
        const priceAction = additionalData?.priceAction;
        
        // Only save candles for ai_ready tokens (they're the only ones that need them)
        if (priceAction?.candles1m && priceAction?.candles5m) {
          try {
            // Save candles to DB
            await scannedTokensLogger.logCandles(
              scanId,
              token.token,
              chainConfig.chain,
              priceAction.candles1m,
              priceAction.candles5m
            );
            candlesLogged++;
            
            // Calculate and save PA features from in-memory candles
            // (efficient - no DB fetch needed since we have candles in memory)
            const paFeatures = priceActionCalculator.calculateFeaturesFromCandles(
              priceAction.candles1m,
              priceAction.candles5m,
              token.token
            );
            
            await scannedTokensLogger.savePriceActionFeatures(
              logged.scannedTokenId,
              paFeatures
            );
            paFeaturesUpdated++;
            
          } catch (error) {
            logger.warn(`Failed to process candles/PA features for ${token.token}:`, error);
          }
        }
      }
      
      if (candlesLogged > 0) {
        logger.info(`✅ Logged candles for ${candlesLogged} tokens (scan: ${scanId})`);
      }
      
      if (paFeaturesUpdated > 0) {
        logger.info(`✅ Calculated and saved PA features for ${paFeaturesUpdated} ai_ready tokens (scan: ${scanId})`);
      }
      
      // Calculate and save microstructure features for all logged tokens
      // These features are calculated from Codex data and price action features already in the database
      let microstructureFeaturesUpdated = 0;
      for (const logged of loggedTokens) {
        try {
          // Get the token data from the scan result
          const token = scanResult.topTokens.find(t => t.token === logged.tokenAddress);
          if (!token) continue;
          
          const additionalData = this.additionalDataMap?.get(token.token);
          const volumeMetrics = additionalData?.volumeMetrics;
          const priceAction = additionalData?.priceAction;
          
          // Get the logged token data from database to calculate features
          const tokenData = await query(`
            SELECT 
              txn_buys_5m, txn_sells_5m,
              buy_count_5m_codex, sell_count_5m_codex,
              unique_buys_5m_codex, unique_sells_5m_codex,
              volume_5m_codex, volume_5m,
              price_change_5m
            FROM scanned_tokens
            WHERE id = $1
          `, [logged.scannedTokenId]);
          
          if (tokenData.rows.length === 0) continue;
          const dbToken = tokenData.rows[0];
          
          // Calculate microstructure features (matching trading-analyzer.ts logic)
          // Order-flow imbalance
          // Use ?? to preserve null (missing data) vs 0 (actual zero)
          const txnBuys5m = volumeMetrics?.txnBuys5m ?? dbToken.buy_count_5m_codex ?? null;
          const txnSells5m = volumeMetrics?.txnSells5m ?? dbToken.sell_count_5m_codex ?? null;
          const imbalance5m = (txnBuys5m !== null && txnSells5m !== null) 
            ? ((txnBuys5m + txnSells5m + 1) > 1 ? (txnBuys5m - txnSells5m) / (txnBuys5m + txnSells5m + 1) : null)
            : null;
          
          // Average trade sizes
          // Return null if volume or count is missing (don't default to 0)
          const vol5m = dbToken.volume_5m_codex ?? null;
          const buyCountForAvg = dbToken.buy_count_5m_codex ?? null;
          const sellCountForAvg = dbToken.sell_count_5m_codex ?? null;
          const avgBuySize5mCodex = (vol5m !== null && buyCountForAvg !== null && buyCountForAvg > 0) ? vol5m / buyCountForAvg : null;
          const avgSellSize5mCodex = (vol5m !== null && sellCountForAvg !== null && sellCountForAvg > 0) ? vol5m / sellCountForAvg : null;
          
          // Small wallet/trade buy ratios
          // Return null if data is missing (use ?? to preserve null vs 0)
          const uniqueBuys = dbToken.unique_buys_5m_codex ?? null;
          const uniqueSells = dbToken.unique_sells_5m_codex ?? null;
          const totalUnique5m = (uniqueBuys ?? 0) + (uniqueSells ?? 0);
          const smallWalletBuyRatio5m = (uniqueBuys !== null && uniqueSells !== null && totalUnique5m > 0)
            ? uniqueBuys / totalUnique5m
            : null;
          
          const buyCountForRatio = dbToken.buy_count_5m_codex ?? null;
          const sellCountForRatio = dbToken.sell_count_5m_codex ?? null;
          const totalTrades5m = (buyCountForRatio ?? 0) + (sellCountForRatio ?? 0);
          const smallTradeBuyRatio5m = (buyCountForRatio !== null && sellCountForRatio !== null && totalTrades5m > 0)
            ? buyCountForRatio / totalTrades5m
            : null;
          
          // Small flow ratio
          // Only calculate if both ratios are available, otherwise null (no 0.5 defaults)
          const smallFlowRatio5m = (smallWalletBuyRatio5m !== null && smallTradeBuyRatio5m !== null)
            ? 0.7 * smallWalletBuyRatio5m + 0.3 * smallTradeBuyRatio5m
            : null;
          
          // Price impact
          const eps = 1e-8;
          const vol5 = dbToken.volume_5m_codex || dbToken.volume_5m || 0;
          const pc5 = volumeMetrics?.priceChange5m ?? priceAction?.priceChange5m ?? dbToken.price_change_5m ?? null;
          const priceImpact5m = (vol5 > 0 && pc5 !== null && pc5 !== undefined) ? (pc5 / 100) / (vol5 + eps) : null;
          
          // Save microstructure features
          await scannedTokensLogger.saveMicrostructureFeatures(logged.scannedTokenId, {
            imbalance_5m: imbalance5m,
            avg_buy_size_5m_codex: avgBuySize5mCodex,
            avg_sell_size_5m_codex: avgSellSize5mCodex,
            small_wallet_buy_ratio_5m: smallWalletBuyRatio5m,
            small_trade_buy_ratio_5m: smallTradeBuyRatio5m,
            small_flow_ratio_5m: smallFlowRatio5m,
            price_impact_5m: priceImpact5m,
          });
          
          microstructureFeaturesUpdated++;
        } catch (error) {
          logger.warn(`Failed to calculate microstructure features for ${logged.tokenAddress}:`, error);
        }
      }
      
      if (microstructureFeaturesUpdated > 0) {
        logger.info(`✅ Calculated and saved microstructure features for ${microstructureFeaturesUpdated} tokens (scan: ${scanId})`);
      }
      
      // Start tracking ready/filtered tokens
      // Track tokens based on TOKEN_TRACKING_MODE setting
      // Tokens that reached AI and have decisions don't need separate tracking
      const { tokenTracker } = await import('./token-tracker');
      if (tokenTracker.isEnabled()) {
        // Get scan timestamp once (all tokens in this batch share the same scan time)
        const scanTime = scanLogger.getCurrentScanTimestamp();
        for (const logged of loggedTokens) {
          // Check if this token should be tracked based on filter_stage and tracking mode
          if (tokenTracker.shouldTrack(logged.filterStage)) {
            logger.debug(`[DEBUG PEAK] Starting tracking for ${logged.symbol} (ID: ${logged.scannedTokenId}):`);
            logger.debug(`[DEBUG PEAK]   scanPrice: ${logged.scanPrice}`);
            logger.debug(`[DEBUG PEAK]   scanPrice source: from logged.scanPrice (which comes from token.priceUsd = metadata?.priceUSD)`);
            await tokenTracker.startTracking(
              logged.scannedTokenId,
              logged.tokenAddress,
              logged.symbol,
              logged.chain,
              logged.scanPrice,
              scanTime || undefined // Pass scanTime to avoid database query
            );
          }
        }
      }
      
    } catch (error) {
      logger.error('❌ Failed to log scanned tokens:', error);
      logger.error(`   Scan ID: ${scanLogger.getCurrentScanId() || 'unknown'}`);
      logger.error(`   Top tokens count: ${scanResult.topTokens.length}`);
      logger.error(`   Error details:`, error);
      // Don't throw - this is non-critical
    }
  }
  
  /**
   * Determine filter stage and reason for a token
   * Matches the order of hard stops in the filtering pipeline
   */
  private determineFilterInfo(
    token: any,
    metadata: any,
    security: SecurityAnalysis | undefined,
    volumeMetrics: any,
    safeTokens: any[],
    activeTokens: any[],
    analyzableTokens: any[],
    tokensForAI: any[]
  ): { filterStage: string | null; filterReason: string | null } {
    // Check if token was filtered by trap score (before other checks)
    if (this.trapFilteredTokens.has(token.token)) {
      return { filterStage: 'trap_filter', filterReason: 'trap_detected' };
    }
    
    // Check if token was filtered by volume anomaly (liquidity grab scam detection)
    if (this.volumeAnomalyFilteredTokens.has(token.token)) {
      return { filterStage: 'volume_anomaly', filterReason: 'volume_density_spike' };
    }
    
    // Check if token was filtered by axiom trap (liquidity trap with stale prices)
    if (this.axiomTrapFilteredTokens.has(token.token)) {
      return { filterStage: 'axiom_trap', filterReason: 'liquidity_trap' };
    }
    
    // Check if token was filtered by young high risk (young token with high risk score)
    if (this.youngHighRiskFilteredTokens.has(token.token)) {
      return { filterStage: 'young_high_risk', filterReason: 'young_high_risk_score' };
    }
    
    // Check if token was filtered by low mcap high vol (artificial pump pattern)
    if (this.lowMcapHighVolFilteredTokens.has(token.token)) {
      return { filterStage: 'low_mcap_high_vol', filterReason: 'low_mcap_high_volume' };
    }

    // Check if token was filtered by price pump (age < 2h AND pc_1h > 150%)
    if (this.pricePumpFilteredTokens.has(token.token)) {
      return { filterStage: 'price_change_filter', filterReason: 'price_pump_filter' };
    }

    // Check if token was filtered by young pump (age < 0.5h AND pc_1h > 100%)
    if (this.youngPumpFilteredTokens.has(token.token)) {
      return { filterStage: 'price_change_filter', filterReason: 'young_pump_filter' };
    }

    // Check if token was filtered by high vol/mcap ratio (vol_5m >= 2.5x mcap)
    if (this.highVolMcapFilteredTokens.has(token.token)) {
      return { filterStage: 'high_vol_mcap', filterReason: 'high_vol_mcap_ratio' };
    }

    // Check if token was filtered by young honeypot (age < 0.5h AND pc_1h >= 40%)
    if (this.youngHoneypotFilteredTokens.has(token.token)) {
      return { filterStage: 'young_honeypot', filterReason: 'young_honeypot' };
    }

    // Check if token was filtered by birth spike (age < 3h AND pc_24h >= 1000%)
    if (this.birthSpikeFilteredTokens.has(token.token)) {
      return { filterStage: 'birth_spike', filterReason: 'birth_spike' };
    }

    // IMPORTANT: Check analyzableTokens FIRST (tokens that actually passed ALL checks including volume)
    // These are tokens that successfully got data and passed all hard stops
    const passedAllFilters = analyzableTokens.some(t => t.token === token.token);
    if (passedAllFilters) {
      return { filterStage: 'ai_ready', filterReason: null };
    }
    
    // If token was selected for AI but NOT in analyzableTokens, it might have failed candle/data quality checks
    // Volume hard stop is checked in Step 2 (before AI selection), so if it's in tokensForAI, volume passed
    const wasSelectedForAI = tokensForAI.some(t => t.token === token.token);
    if (wasSelectedForAI) {
      // Token was selected but didn't make it to analyzableTokens
      // This could be due to candle/data quality issues (not hard stops - those are checked earlier)
      // Mark as ai_ready since it passed all hard stops
      return { filterStage: 'ai_ready', filterReason: null };
    }
    
    // ========================================================================
    // Market filters (liquidity, market cap, volume) - checked after activity
    // ========================================================================
    const passedActivity = activeTokens.some(t => t.token === token.token);
    if (passedActivity) {
      // Check metadata availability
      if (!metadata) {
        return { filterStage: 'liquidity_filter', filterReason: 'no_metadata' };
      }
      
      // Check liquidity (stricter of SOL-denominated floor and USD floor, matches Step 2)
      const solFloorUsd = this.currentSolPriceUsd
        ? HARD_STOPS.MIN_LIQUIDITY_SOL * this.currentSolPriceUsd
        : 0;
      const minLiqUsd = Math.max(solFloorUsd, HARD_STOPS.MIN_LIQUIDITY_USD);
      if (metadata.liquidity < minLiqUsd) {
        return { filterStage: 'liquidity_filter', filterReason: 'low_liquidity' };
      }
      
      // Market cap: Now handled via scoring system (50-250k preferred), not a hard stop
      // This allows tracking all tokens for peak gain analysis
      
      // Check volume using Codex data (available in Step 2, before expensive API calls)
      // Use Codex volume5m if available, otherwise estimate from volume24h
      const volume5m = metadata.volume5m || (metadata.volume24h ? (metadata.volume24h / (24 * 12)) : 0);
      if (volume5m < HARD_STOPS.MIN_VOLUME_5M) {
        return { filterStage: 'volume_filter', filterReason: 'low_volume' };
      }
      
      // Price Pump, Young Pump, High Vol/Mcap, Young Honeypot, Birth Spike
      // are now tracked via Sets (checked at top of determineFilterInfo)
    }
    
    // ========================================================================
    // Activity filters (users, trades) - checked after security
    // ========================================================================
    const passedSecurity = safeTokens.some(t => t.token === token.token);
    if (passedSecurity) {
      const totalActivity = token.buys + token.sells;
      const uniqueUsers = token.users.size;
      
      if (uniqueUsers < HARD_STOPS.MIN_UNIQUE_USERS) {
        return { filterStage: 'activity_filter', filterReason: 'low_users' };
      }
      if (totalActivity < HARD_STOPS.MIN_TOTAL_TRADES) {
        return { filterStage: 'activity_filter', filterReason: 'low_trades' };
      }
    }
    
    // ========================================================================
    // Security hard stops - checked first in pipeline
    // ========================================================================
    if (!security) {
      return { filterStage: 'security_hardstop', filterReason: 'no_security_data' };
    }
    
    // Check for missing critical security data
    const hasCriticalData = 
      security.contractAge !== undefined || 
      security.buyTax !== undefined || 
      security.sellTax !== undefined ||
      security.honeypotDetected !== undefined;
      
    if (!hasCriticalData) {
      return { filterStage: 'security_hardstop', filterReason: 'no_critical_security_data' };
    }
    
    // Check overall safety (catches unverified contracts, etc.)
    if (!security.isSafe) {
      // Determine specific security reason (in order of severity)
      if (security.honeypotDetected) {
        return { filterStage: 'security_hardstop', filterReason: 'honeypot' };
      }
      if (security.hiddenFunctionsDetected) {
        return { filterStage: 'security_hardstop', filterReason: 'hidden_functions' };
      }
      if (security.blacklistDetected) {
        return { filterStage: 'security_hardstop', filterReason: 'blacklist' };
      }
      if (security.isAirdropScam) {
        return { filterStage: 'security_hardstop', filterReason: 'airdrop_scam' };
      }
      if (security.canTakeBackOwnership) {
        return { filterStage: 'security_hardstop', filterReason: 'can_reclaim_ownership' };
      }
      if (security.top10HolderPercent && security.top10HolderPercent > 95) {
        return { filterStage: 'security_hardstop', filterReason: 'extreme_centralization' };
      }
      if (security.ownerPercent && security.ownerPercent > 50) {
        return { filterStage: 'security_hardstop', filterReason: 'owner_concentration' };
      }
      // Generic unsafe (catches unverified contracts, high risk score, etc.)
      return { filterStage: 'security_hardstop', filterReason: 'unsafe_contract' };
    }
    
    // Fallback - shouldn't reach here, but mark as ai_ready if somehow passed all checks
    return { filterStage: 'ai_ready', filterReason: null };
  }
  
  /**
   * Get the decision ID for a given token address
   * (used for linking paper trades to decisions)
   */
  getDecisionId(tokenAddress: string): number | null {
    return this.decisionIdMap.get(tokenAddress) || null;
  }
  
  /**
   * Fetch portfolio context for AI prompt
   * Includes: open positions, recent exits (24h), portfolio stats
   */
  private async getPortfolioContext(): Promise<{ openPositions: any[], recentExits: any[], stats: any } | undefined> {
    try {
      const paperTrader = new (await import('./paper-trader')).PaperTrader();
      
      // Get open positions
      const openPositions = await paperTrader.getOpenTrades();
      
      // Get recent exits (last 24 hours)
      const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
      const recentExits = await paperTrader.getRecentExits(twentyFourHoursAgo);
      
      // Get portfolio stats
      const stats = await paperTrader.getStats();
      
      // Calculate % deployed
      const totalDeployed = openPositions.reduce((sum: number, pos: any) => sum + (pos.entry_amount_usd || 0), 0);
      const deployedPercent = (totalDeployed / (stats.currentBalance + totalDeployed)) * 100;
      
      return {
        openPositions,
        recentExits,
        stats: {
          ...stats,
          deployed_percent: deployedPercent,
        },
      };
      
    } catch (error) {
      logger.warn('Failed to fetch portfolio context:', error);
      return undefined;
    }
  }
  
  /**
   * Analyze tokens with point-based system (replaces AI)
   */
  private async analyzeWithPointSystem(
    tokens: any[],
    scanResult: ScanResult,
    securityResults: Map<string, SecurityAnalysis>
  ): Promise<TradingAnalysis> {
    const decisions: TradingDecision[] = [];
    
    // Get portfolio context (same as AI system) to check for existing positions
    const portfolioContext = await this.getPortfolioContext();
    const openPositions = portfolioContext?.openPositions || [];
    const openTokenAddresses = new Set(openPositions.map((pos: any) => pos.token_address?.toLowerCase()));
    
    if (openPositions.length > 0) {
      logger.info(`📊 Portfolio context: ${openPositions.length} open position(s) - will skip these tokens`);
    }
    
    // Initialize ML batch collection if ML is enabled
    this.mlTokensForBatch = this.mlClient.isEnabled() ? [] : null;
    
    for (const token of tokens) {
      // Check if we already have an open position for this token (same as AI system)
      if (openTokenAddresses.has(token.token.toLowerCase())) {
        const existingPosition = openPositions.find((pos: any) => 
          pos.token_address?.toLowerCase() === token.token.toLowerCase()
        );
        const metadata = scanResult.tokenMetadata.get(token.token);
        const holdMinutes = existingPosition?.entry_timestamp 
          ? Math.floor((Date.now() - new Date(existingPosition.entry_timestamp).getTime()) / 60000)
          : 0;
        
        logger.info(`${metadata?.symbol || token.token}: Already have open position (held ${holdMinutes}min) - skipping duplicate analysis`);
        
        // Create SKIP decision for tracking (same as AI would do)
        const skipDecision: TradingDecision = {
          token: token.token,
          symbol: metadata?.symbol || 'Unknown',
          name: metadata?.name || 'Unknown',
          shouldBuy: false,
          confidence: 0,
          reasoning: `Already have open position (held ${holdMinutes}min) - cannot re-enter same token`,
          opportunities: [],
          risks: [
            `Duplicate position: Already holding this token (position #${existingPosition?.id || 'unknown'})`,
            `Held for ${holdMinutes} minutes`,
          ],
          warnings: [],
          marketData: {
            price: metadata?.priceUSD || 0,
            marketCap: metadata?.marketCap || 0,
            liquidity: metadata?.liquidity || 0,
            volume24h: metadata?.volume24h || 0,
            buys: token.buys,
            sells: token.sells,
            users: token.users.size,
          },
          securityAnalysis: securityResults.get(token.token),
          discoveredByBots: Array.from(token.bots) as string[],
          primaryBot: Array.from(token.bots)[0] as string | undefined,
        };
        
        decisions.push(skipDecision);
        continue;
      }
      const metadata = scanResult.tokenMetadata.get(token.token);
      const security = securityResults.get(token.token);
      const additionalData = this.additionalDataMap.get(token.token);
      
      if (!metadata || !security || !additionalData) {
        logger.warn(`Missing data for token ${token.token}, skipping`);
        continue;
      }
      
      // Fetch scannedToken from database (simpler, single source of truth)
      const scanId = scanLogger.getCurrentScanId();
      if (!scanId) {
        logger.warn(`No scan ID available, cannot fetch scanned token for ${token.token}`);
        continue;
      }
      
      const scannedToken = await this.fetchScannedTokenFromDB(token.token, scanId);
      if (!scannedToken) {
        logger.warn(`Scanned token not found in DB for ${token.token} (scan: ${scanId}), skipping`);
        continue;
      }
      
      // Convert boolean to number for ML features (DB stores as boolean, ML expects number)
      if (scannedToken.is_scam_codex !== undefined) {
        scannedToken.is_scam_codex = scannedToken.is_scam_codex ? 1 : 0;
      }
      
      // Check if ML is enabled - if not, fall back to point-based scoring
      if (!this.mlClient.isEnabled()) {
        // Fallback to point-based scoring (v3 analyzer)
        logger.debug(`📊 [Point-Based Fallback] Analyzing ${metadata.symbol} (${token.token}):`);
        logger.debug(`   Data: mcap=$${metadata.marketCap?.toLocaleString() || 'N/A'}, age=${security.contractAgeHours?.toFixed(1) || 'N/A'}h, liq=$${metadata.liquidity?.toLocaleString() || 'N/A'}, vol5m=$${additionalData.volumeMetrics?.volume5m?.toLocaleString() || 'N/A'}, bots=${token.buys}, ratio=${scannedToken.buy_sell_ratio?.toFixed(2) || 'N/A'}, risk=${security.riskScore || 'N/A'}`);
        
        // Analyze with point-based system
        const score = this.pointBasedAnalyzer!.analyze(scannedToken);
        
        logger.info(`📊 ${metadata.symbol}: Score ${score.totalScore}/100 - ${score.decision}`);
        logger.debug(`   Breakdown: Vol:${score.breakdown.volume}/50 Fresh:${score.breakdown.freshness}/30 MultiBot:${score.breakdown.multiBotSignal}/15 Safe:${score.breakdown.safety}/5`);
        
        if (score.decision === 'SKIP') {
          logger.info(`   ⏭️  Skipped: ${score.reasoning}`);
          
          // Create SKIP decision
          const skipDecision: TradingDecision = {
            token: token.token,
            symbol: metadata.symbol,
            name: metadata.name,
            shouldBuy: false,
            confidence: score.confidence,
            reasoning: `Point-based scoring: ${score.reasoning}`,
            opportunities: [],
            risks: [
              `Score too low: ${score.totalScore}/100 (threshold: ${this.pointBasedAnalyzer!['minScoreThreshold']})`,
              `Breakdown: Vol:${score.breakdown.volume}/50, Fresh:${score.breakdown.freshness}/30, MultiBot:${score.breakdown.multiBotSignal}/15, Safe:${score.breakdown.safety}/5`,
              `Decision System: Point-based (ML disabled)`,
            ],
            warnings: [],
            marketData: {
              price: metadata.priceUSD,
              marketCap: metadata.marketCap,
              liquidity: metadata.liquidity,
              volume24h: metadata.volume24h || 0,
              buys: token.buys,
              sells: token.sells,
              users: token.users.size,
              buyVsSellRatio: additionalData.volumeMetrics?.buyVsSellVolume,
            },
            securityAnalysis: security,
            discoveredByBots: Array.from(token.bots) as string[],
            primaryBot: Array.from(token.bots)[0] as string | undefined,
          };
          
          decisions.push(skipDecision);
          continue;
        }
        
        // Point-based scoring passed - create BUY decision
        logger.info(`✅ ${metadata.symbol}: Point-based scoring passed (score: ${score.totalScore}/100)`);
        
        // Get position size and risk params from point-based analyzer
        const positionPercent = this.pointBasedAnalyzer!.calculatePositionSize(score.totalScore);
        
        // Get risk params
        const useDynamicRiskParams = process.env.USE_DYNAMIC_RISK_PARAMS !== 'false';
        let riskParams: {
          stopLoss: number;
          takeProfitLevels: Array<{ percentage: number; sellPercent: number }>;
        };
        
        if (useDynamicRiskParams) {
          riskParams = this.pointBasedAnalyzer!.getSuggestedRiskParams();
        } else {
          const tpLevelsStr = process.env.PAPER_DEFAULT_TP_LEVELS || '5,10,18';
          const tpSellPercentsStr = process.env.PAPER_DEFAULT_TP_SELL_PERCENTS || '60,30,10';
          const slPercent = parseFloat(process.env.PAPER_DEFAULT_SL || '-35');
          
          const tpLevels = tpLevelsStr.split(',').map(s => parseFloat(s.trim()));
          const tpSellPercents = tpSellPercentsStr.split(',').map(s => parseFloat(s.trim()));
          
          riskParams = {
            stopLoss: slPercent,
            takeProfitLevels: tpLevels.map((level, idx) => ({
              percentage: level,
              sellPercent: tpSellPercents[idx] || 100,
            })),
          };
        }
        
        const maxUsdHint = parseFloat(process.env.PAPER_MAX_POSITION_USD || '500');
        const exitMinutes = parseFloat(process.env.PAPER_TIMED_EXIT_MINUTES || '5');
        
        // Build trading decision (point-based fallback)
        const decision: TradingDecision = {
          token: token.token,
          symbol: metadata.symbol,
          name: metadata.name,
          shouldBuy: true,
          confidence: score.confidence,
          reasoning: `Point-based scoring: ${score.reasoning}`,
          positionSize: {
            percentage: positionPercent,
            maxUsdAmount: maxUsdHint,
          },
          riskManagement: {
            stopLoss: riskParams.stopLoss,
            takeProfitLevels: riskParams.takeProfitLevels,
          },
          opportunities: [
            `Decision System: Point-based (ML disabled)`,
            `Score: ${score.totalScore}/100`,
            `Volume: ${score.breakdown.volume}/50`,
            `Freshness: ${score.breakdown.freshness}/30`,
            `Multi-Bot Signal: ${score.breakdown.multiBotSignal}/15`,
            `Safety: ${score.breakdown.safety}/5`,
            `Position Size: ${positionPercent.toFixed(1)}% (based on score)`,
            `Stop Loss: ${riskParams.stopLoss}% (emergency only)`,
            `Exit Strategy: ${exitMinutes}min timed exit`,
          ],
          risks: [],
          warnings: [],
          marketData: {
            price: metadata.priceUSD,
            marketCap: metadata.marketCap,
            liquidity: metadata.liquidity,
            volume24h: metadata.volume24h || 0,
            buys: token.buys,
            sells: token.sells,
            users: token.users.size,
            buyVsSellRatio: additionalData.volumeMetrics?.buyVsSellVolume,
          },
          securityAnalysis: security,
          discoveredByBots: Array.from(token.bots) as string[],
          primaryBot: Array.from(token.bots)[0] as string | undefined,
        };
        
        decisions.push(decision);
        logger.success(`   ✅ BUY recommendation (${positionPercent.toFixed(1)}% of portfolio, score: ${score.totalScore}/100)`);
        continue; // Skip ML processing, continue to next token
      }
      
      // ML is enabled - collect features for batch prediction with global threshold filtering
      // We'll process all tokens first, then filter by global threshold (POINT_BASED_MIN_SCORE), then make decisions
      
      // NOTE: Trap score check is now done in Step 3.5 (before tokens are marked as ai_ready)
      // Tokens that reach this point have already passed trap score filtering
      // This ensures consistency - trap tokens never reach shadow tracker
      
      // Store token data for batch processing
      const mlTokenData = {
        token,
        metadata,
        security,
        additionalData,
        scannedToken,
      };
      
      // Store for batch processing (we'll process after the loop)
      if (!this.mlTokensForBatch) {
        this.mlTokensForBatch = [];
      }
      this.mlTokensForBatch.push(mlTokenData);
      continue; // Skip individual processing, we'll do batch after loop
    }
    
    // Process ML tokens with batch prediction and global threshold filtering
    if (this.mlClient.isEnabled() && this.mlTokensForBatch && this.mlTokensForBatch.length > 0) {
      logger.info(`🤖 [ML-Only] Processing ${this.mlTokensForBatch.length} tokens with batch prediction (global threshold filtering)...`);
      
      // Extract ML features for all tokens (market features will be computed by ML service)
      const mlFeaturesList = await Promise.all(
        this.mlTokensForBatch.map(({ scannedToken, security, token }) =>
          this.extractMLFeatures(scannedToken, security, token)
        )
      );
      
      // Get batch predictions with global threshold filtering (POINT_BASED_MIN_SCORE)
      // This implements Precision@K methodology: trade tokens with confidence >= threshold
      // The ML service will compute and merge market features on-the-fly
      // Use the scan timestamp from scanLogger (ensures consistency with DB)
      const scanTimestampObj = scanLogger.getCurrentScanTimestamp();
      const scanTimestamp = scanTimestampObj ? scanTimestampObj.toISOString() : new Date().toISOString();
      
      // Get strategy performance data for reversible threshold decay (matches backtest)
      // This allows app.py to adjust threshold based on daily P&L and recent win rate
      const { PaperTrader } = await import('./paper-trader');
      const paperTrader = new PaperTrader();
      const strategyPerformance = await paperTrader.getStrategyPerformance();
      
      const mlPredictions = await this.mlClient.predictBatch(mlFeaturesList, scanTimestamp, strategyPerformance);
      
      // Process each token with its prediction (already filtered by threshold)
      for (let i = 0; i < this.mlTokensForBatch.length; i++) {
        const { token, metadata, security, additionalData, scannedToken } = this.mlTokensForBatch[i];
        const mlPrediction = mlPredictions[i];
        
        if (!mlPrediction) {
          logger.warn(`No ML prediction for ${metadata.symbol}, skipping`);
          continue;
        }
        
        if (!mlPrediction.should_trade) {
          logger.info(`⏭️  ${metadata.symbol}: ML filter rejected (confidence: ${mlPrediction.confidence.toFixed(3)})`);
          
          // Create SKIP decision with ML reason
          const mlConfidencePercent = mlPrediction.confidence * 100;
          // Use the actual threshold from the response (may be boosted), fallback to base threshold
          const confidenceThreshold = mlPrediction.confidence_threshold_used ?? this.mlClient.getConfidenceThreshold();
          const baseThreshold = this.mlClient.getConfidenceThreshold();
          const isBoosted = mlPrediction.confidence_threshold_used !== undefined && mlPrediction.confidence_threshold_used !== baseThreshold;
          const thresholdNote = isBoosted ? ` (boosted from ${baseThreshold.toFixed(2)})` : '';
          const mlSkipDecision: TradingDecision = {
            token: token.token,
            symbol: metadata.symbol,
            name: metadata.name,
            shouldBuy: false,
            confidence: mlConfidencePercent,
            mlPredictedReturn: mlPrediction.predicted_return !== undefined && mlPrediction.predicted_return !== null ? mlPrediction.predicted_return : undefined,
            mlExpectedValue: mlPrediction.expected_value !== undefined && mlPrediction.expected_value !== null ? mlPrediction.expected_value : undefined,
            reasoning: `ML filter: Confidence ${mlPrediction.confidence.toFixed(3)} below threshold ${confidenceThreshold.toFixed(2)}${thresholdNote} - Model predicts lower profitability (Model: ${mlPrediction.model_version})`,
            opportunities: [
              `ML Decision System: Active (Threshold Mode)`,
              `ML Confidence: ${mlPrediction.confidence.toFixed(3)} (${mlConfidencePercent.toFixed(1)}%)`,
              mlPrediction.predicted_return !== undefined && mlPrediction.predicted_return !== null 
                ? `Predicted Return (E[R|win]): ${mlPrediction.predicted_return.toFixed(2)}%` 
                : null,
              mlPrediction.expected_value !== undefined && mlPrediction.expected_value !== null 
                ? `Expected Value (P(win)×E[R|win]): ${mlPrediction.expected_value.toFixed(2)}%` 
                : null,
              `ML Threshold: ${confidenceThreshold.toFixed(2)}${mlPrediction.confidence_threshold_used ? ' (boosted)' : ' (base)'}`,
              `ML Model: ${mlPrediction.model_version}`,
              `ML Features: ${mlPrediction.features_used}`,
            ].filter(Boolean) as string[],
            risks: [
              `ML model confidence (${mlPrediction.confidence.toFixed(3)}) below threshold (${confidenceThreshold.toFixed(2)})`,
              `ML Model Version: ${mlPrediction.model_version}`,
              `ML Features Used: ${mlPrediction.features_used}`,
            ],
            warnings: [],
            marketData: {
              price: metadata.priceUSD,
              marketCap: metadata.marketCap,
              liquidity: metadata.liquidity,
              volume24h: metadata.volume24h || 0,
              buys: token.buys,
              sells: token.sells,
              users: token.users.size,
              buyVsSellRatio: additionalData.volumeMetrics?.buyVsSellVolume,
            },
            securityAnalysis: security as SecurityAnalysis,
            discoveredByBots: Array.from(token.bots) as string[],
            primaryBot: Array.from(token.bots)[0] as string | undefined,
          };
          
          decisions.push(mlSkipDecision);
          continue;
        }

        // Optional big-loss risk gate (secondary ML filter)
        // Uses separate is_big_loss model to estimate probability of catastrophic loss.
        const useRiskGate = process.env.USE_ML_RISK_GATE === 'true';
        const riskMaxProb = parseFloat(process.env.ML_RISK_MAX_PROB || '0.10');
        const riskProb = (mlPrediction as any).risk_prob ?? (mlPrediction as any).riskProb;

        if (useRiskGate && riskProb !== undefined && riskProb !== null && riskProb > riskMaxProb) {
          const mlConfidencePercent = mlPrediction.confidence * 100;
          // Use the actual threshold from the response (may be boosted), fallback to base threshold
          const confidenceThreshold = mlPrediction.confidence_threshold_used ?? this.mlClient.getConfidenceThreshold();

          const mlSkipDecision: TradingDecision = {
            token: token.token,
            symbol: metadata.symbol,
            name: metadata.name,
            shouldBuy: false,
            confidence: mlConfidencePercent,
            mlPredictedReturn: mlPrediction.predicted_return !== undefined && mlPrediction.predicted_return !== null ? mlPrediction.predicted_return : undefined,
            mlExpectedValue: mlPrediction.expected_value !== undefined && mlPrediction.expected_value !== null ? mlPrediction.expected_value : undefined,
            reasoning: `ML risk gate: Big-loss risk_prob ${riskProb.toFixed(3)} exceeds max ${riskMaxProb.toFixed(2)} - skipping trade (Model: ${mlPrediction.model_version})`,
            opportunities: [
              `ML Decision System: Active (Threshold + Risk Gate)`,
              `ML Confidence: ${mlPrediction.confidence.toFixed(3)} (${mlConfidencePercent.toFixed(1)}%)`,
              riskProb !== undefined && riskProb !== null
                ? `Big-Loss Risk Prob (P(big_loss)): ${riskProb.toFixed(3)}`
                : null,
              mlPrediction.predicted_return !== undefined && mlPrediction.predicted_return !== null 
                ? `Predicted Return (E[R|win]): ${mlPrediction.predicted_return.toFixed(2)}%` 
                : null,
              mlPrediction.expected_value !== undefined && mlPrediction.expected_value !== null 
                ? `Expected Value (P(win)×E[R|win]): ${mlPrediction.expected_value.toFixed(2)}%` 
                : null,
              `ML Confidence Threshold: ${confidenceThreshold.toFixed(2)} (from POINT_BASED_MIN_SCORE)`,
              `ML Risk Max Prob: ${riskMaxProb.toFixed(2)}`,
              `ML Model: ${mlPrediction.model_version}`,
              `ML Features: ${mlPrediction.features_used}`,
            ].filter(Boolean) as string[],
            risks: [
              `ML big-loss risk gate: risk_prob ${riskProb.toFixed(3)} > max ${riskMaxProb.toFixed(2)}`,
            ],
            warnings: [],
            marketData: {
              price: metadata.priceUSD,
              marketCap: metadata.marketCap,
              liquidity: metadata.liquidity,
              volume24h: metadata.volume24h || 0,
              buys: token.buys,
              sells: token.sells,
              users: token.users.size,
              buyVsSellRatio: additionalData.volumeMetrics?.buyVsSellVolume,
            },
            securityAnalysis: security as SecurityAnalysis,
            discoveredByBots: Array.from(token.bots) as string[],
            primaryBot: Array.from(token.bots)[0] as string | undefined,
          };

          logger.info(`⏭️  ${metadata.symbol}: ML risk gate rejected (risk_prob=${riskProb.toFixed(3)} > max ${riskMaxProb.toFixed(2)})`);
          decisions.push(mlSkipDecision);
          continue;
        }
        
        // Log feature completeness if available
        const featuresInfo = mlPrediction.features_non_null !== undefined && mlPrediction.features_total !== undefined
          ? `, features: ${mlPrediction.features_non_null}/${mlPrediction.features_total} non-null`
          : '';
        const regressionInfo = mlPrediction.predicted_return !== undefined && mlPrediction.predicted_return !== null
          ? `, predicted_return: ${mlPrediction.predicted_return.toFixed(2)}%`
          : '';
        const expectedValueInfo = mlPrediction.expected_value !== undefined && mlPrediction.expected_value !== null
          ? `, expected_value: ${mlPrediction.expected_value.toFixed(2)}%`
          : '';
        logger.info(`✅ ${metadata.symbol}: ML filter passed (confidence: ${mlPrediction.confidence.toFixed(3)}, model: ${mlPrediction.model_version}${featuresInfo}${regressionInfo}${expectedValueInfo})`);
        
        // Calculate position size based on expected value
        // Position sizing tiers based on expected value (aligned with confidence ≥ 0.55 threshold):
        // Note: Only trades with confidence ≥ 0.55 are considered (POINT_BASED_MIN_SCORE = 55)
        // At 0.55 threshold, EV range is 4.91% to 41.25% (from model analysis)
        // >15%: Ultra-rare rockets - Maximum position (2.0%)
        // 12-15%: Very strong winners - Large position (1.75%)
        // 10-12%: Strong winners - Large position (1.5%)
        // 8-10%: Good-strong signals - Medium-large position (1.25%)
        // 6-8%: Good signals - Standard position (1.0%)
        // 5-6%: Weak positive - Small position (0.75%)
        // <5%: Minimum position (0.5%) - Rare edge case at minimum confidence threshold
        const expectedValue = mlPrediction.expected_value;
        const minPositionPercent = parseFloat(process.env.PAPER_MIN_POSITION_PERCENT || '0.5');
        const maxPositionPercent = parseFloat(process.env.PAPER_MAX_POSITION_PERCENT || '2.0');
        
        let positionPercent: number;
        let positionTier: string;
        
        if (expectedValue !== undefined && expectedValue !== null) {
          // Use expected value for position sizing with granular buckets
          // All trades here have already passed confidence ≥ 0.55 threshold
          if (expectedValue > 15) {
            // Ultra-rare rockets: Maximum position
            positionPercent = maxPositionPercent;
            positionTier = 'Ultra-rare rockets';
          } else if (expectedValue >= 12) {
            // Very strong winners: Large position
            positionPercent = 1.75;
            positionTier = 'Very strong winners';
          } else if (expectedValue >= 10) {
            // Strong winners: Large position
            positionPercent = 1.5;
            positionTier = 'Strong winners';
          } else if (expectedValue >= 8) {
            // Good-strong signals: Medium-large position
            positionPercent = 1.25;
            positionTier = 'Good-strong signals';
          } else if (expectedValue >= 6) {
            // Good signals: Standard position
            positionPercent = 1.0;
            positionTier = 'Good signals';
          } else if (expectedValue >= 5) {
            // Weak positive: Small position (minimum EV at 0.55 threshold is ~4.91%)
            positionPercent = 0.75;
            positionTier = 'Weak positive';
          } else {
            // <5%: Minimum position (edge case - only for absolute minimum EV at threshold)
            positionPercent = minPositionPercent;
            positionTier = 'Minimum EV (threshold edge case)';
          }
        } else {
          // Fallback: No expected value available, use minimum position
          positionPercent = minPositionPercent;
          positionTier = 'No EV (fallback)';
        }
        
        // Ensure position is within configured bounds
        positionPercent = Math.max(minPositionPercent, Math.min(maxPositionPercent, positionPercent));
        
        // Round to 2 decimal places for cleaner values
        positionPercent = Math.round(positionPercent * 100) / 100;
        
        const mlConfidence = mlPrediction.confidence;
        if (expectedValue !== undefined && expectedValue !== null) {
          logger.debug(`[ML Position Sizing] Expected Value: ${expectedValue.toFixed(2)}% (${positionTier}) → ${positionPercent}% of portfolio`);
        } else {
          logger.debug(`[ML Position Sizing] No expected value, using fallback: ${positionPercent}% of portfolio (confidence: ${(mlConfidence * 100).toFixed(1)}%)`);
        }
        
        // Get risk params from environment (aligned with ML training strategy: 10min exit, -35% SL)
        const useDynamicRiskParams = process.env.USE_DYNAMIC_RISK_PARAMS !== 'false';
        
        let riskParams: {
          stopLoss: number;
          takeProfitLevels: Array<{ percentage: number; sellPercent: number }>;
        };
        
        if (useDynamicRiskParams) {
          // Use fixed TP/SL for timed exit strategy (from point-based analyzer for consistency)
          // Note: This uses environment variables (5min exit, -35% SL) which match ML training
          riskParams = this.pointBasedAnalyzer!.getSuggestedRiskParams();
        } else {
          // Use fixed TP/SL from environment (matches ML training: 5min exit, -35% SL)
          const tpLevelsStr = process.env.PAPER_DEFAULT_TP_LEVELS || '5,10,18';
          const tpSellPercentsStr = process.env.PAPER_DEFAULT_TP_SELL_PERCENTS || '60,30,10';
          const slPercent = parseFloat(process.env.PAPER_DEFAULT_SL || '-35'); // Matches ML training
          
          const tpLevels = tpLevelsStr.split(',').map(s => parseFloat(s.trim()));
          const tpSellPercents = tpSellPercentsStr.split(',').map(s => parseFloat(s.trim()));
          
          riskParams = {
            stopLoss: slPercent,
            takeProfitLevels: tpLevels.map((level, idx) => ({
              percentage: level,
              sellPercent: tpSellPercents[idx] || 100,
            })),
          };
        }
        
        // Use same logic as AI: paper trader will calculate actual USD based on current balance
        // We just provide the percentage (1-5%) and a maxUsdAmount hint
        const maxUsdHint = parseFloat(process.env.PAPER_MAX_POSITION_USD || '500');
        
        // Build trading decision (ML-only approach)
        const mlConfidencePercent = mlPrediction.confidence * 100;
        const exitMinutes = parseFloat(process.env.PAPER_TIMED_EXIT_MINUTES || '5');
        
        const decision: TradingDecision = {
          token: token.token,
          symbol: metadata.symbol,
          name: metadata.name,
          shouldBuy: true,
          confidence: mlConfidencePercent, // ML confidence (0-100)
          reasoning: `ML prediction: High confidence (${mlPrediction.confidence.toFixed(3)}) - Model predicts profitable trade (Model: ${mlPrediction.model_version})`,
          mlPredictedReturn: mlPrediction.predicted_return !== undefined && mlPrediction.predicted_return !== null ? mlPrediction.predicted_return : undefined,
          mlExpectedValue: mlPrediction.expected_value !== undefined && mlPrediction.expected_value !== null ? mlPrediction.expected_value : undefined,
          positionSize: {
            percentage: positionPercent,  // Position size based on expected value tier
            maxUsdAmount: maxUsdHint,     // Paper trader will apply this cap
          },
          riskManagement: {
            stopLoss: riskParams.stopLoss,
            takeProfitLevels: riskParams.takeProfitLevels,
          },
          opportunities: [
            `ML Decision System: Active (Threshold Mode)`,
            `ML Confidence: ${mlPrediction.confidence.toFixed(3)} (${mlConfidencePercent.toFixed(1)}%)`,
            mlPrediction.predicted_return !== undefined && mlPrediction.predicted_return !== null 
              ? `Predicted Return (E[R|win]): ${mlPrediction.predicted_return.toFixed(2)}%` 
              : null,
            mlPrediction.expected_value !== undefined && mlPrediction.expected_value !== null 
              ? `Expected Value (P(win)×E[R|win]): ${mlPrediction.expected_value.toFixed(2)}%` 
              : null,
            `ML Model: ${mlPrediction.model_version}`,
            `ML Features: ${mlPrediction.features_used}`,
            `ML Threshold: ${(mlPrediction.confidence_threshold_used ?? this.mlClient.getConfidenceThreshold()).toFixed(2)}${mlPrediction.confidence_threshold_used ? ' (boosted)' : ' (base)'}`,
            expectedValue !== undefined && expectedValue !== null
              ? `Position Size: ${positionPercent.toFixed(2)}% (${positionTier}, EV: ${expectedValue.toFixed(2)}%)`
              : `Position Size: ${positionPercent.toFixed(2)}% (fallback, no EV available)`,
            `Stop Loss: ${riskParams.stopLoss}% (emergency only)`,
            `Exit Strategy: ${exitMinutes}min timed exit (aligned with ML training)`,
          ].filter(Boolean) as string[],
          risks: [],
          warnings: [],
          marketData: {
            price: metadata.priceUSD,
            marketCap: metadata.marketCap,
            liquidity: metadata.liquidity,
            volume24h: metadata.volume24h || 0,
            buys: token.buys,
            sells: token.sells,
            users: token.users.size,
            buyVsSellRatio: additionalData.volumeMetrics?.buyVsSellVolume,
          },
          securityAnalysis: security as SecurityAnalysis,
          discoveredByBots: Array.from(token.bots) as string[],
          primaryBot: Array.from(token.bots)[0] as string | undefined,
        };
        
        decisions.push(decision);
        logger.success(`   ✅ BUY recommendation (${positionPercent.toFixed(1)}% of portfolio, ML confidence: ${mlConfidencePercent.toFixed(1)}%)`);
      }
    }
    
    // Log ALL decisions to database (same as AI mode)
    await this.logDecisions(decisions, scanResult, securityResults);
    
    const buyDecisions = decisions.filter(d => d.shouldBuy);
    const mlRejections = decisions.filter(d => !d.shouldBuy && d.reasoning?.includes('ML filter'));
    const pointBasedRejections = decisions.filter(d => !d.shouldBuy && d.reasoning?.includes('Point-based scoring'));
    const isMLMode = this.mlClient.isEnabled();
    
    let summary: string;
    if (isMLMode) {
      summary = `ML-Only Analysis: ${buyDecisions.length}/${tokens.length} tokens approved (${mlRejections.length} rejected by ML, ${tokens.length - decisions.length} skipped by security filters)`;
    } else {
      summary = `Point-Based Analysis: ${buyDecisions.length}/${tokens.length} tokens passed (${pointBasedRejections.length} rejected by point-based scoring, ${tokens.length - decisions.length} skipped by security filters)`;
    }
    
    return {
      decisions,
      summary,
      timestamp: Date.now(),
    };
  }

  /**
   * Check price variance for manipulation detection
   * Blocks tokens with >10,000% variance (extreme volatility = manipulation)
   */
  private async checkPriceVariance(
    tokenAddress: string,
    chain: string
  ): Promise<{
    shouldBlock: boolean;
    variancePct: number;
    scanCount: number;
  }> {
    try {
      // Check price variance from scanned_tokens (last 24 hours)
      const varianceResult = await query(`
        SELECT
          COUNT(*) as scan_count,
          MIN(st.price_usd::numeric) as min_price,
          MAX(st.price_usd::numeric) as max_price,
          ((MAX(st.price_usd::numeric) - MIN(st.price_usd::numeric)) / NULLIF(MIN(st.price_usd::numeric), 0)) * 100 as price_variance_pct
        FROM scanned_tokens st
        WHERE st.token_address = $1
          AND st.chain = $2
          AND st.created_at > NOW() - INTERVAL '24 hours'
          AND st.price_usd IS NOT NULL
          AND st.price_usd > 0
        HAVING COUNT(*) >= 2  -- Need at least 2 scans to calculate variance
      `, [tokenAddress, chain]);

      if (varianceResult.rows.length === 0) {
        // No data - don't block
        return {
          shouldBlock: false,
          variancePct: 0,
          scanCount: 0,
        };
      }

      const row = varianceResult.rows[0];
      const variancePct = parseFloat(row.price_variance_pct) || 0;
      const scanCount = parseInt(row.scan_count) || 0;

      // Block if: variance > 10,000% (extreme volatility = manipulation)
      const shouldBlock = variancePct > 10000;

      return {
        shouldBlock,
        variancePct,
        scanCount,
      };
    } catch (error) {
      logger.warn(`Failed to check price variance for ${tokenAddress}:`, error);
      // On error, don't block (fail open)
      return {
        shouldBlock: false,
        variancePct: 0,
        scanCount: 0,
      };
    }
  }

  /**
   * Fetch scanned token from database by token address and scan ID
   */
  private async fetchScannedTokenFromDB(tokenAddress: string, scanId: string): Promise<any | null> {
    try {
      const result = await query(`
        SELECT 
          id, scan_id, token_address, symbol, name, chain,
          price_usd, market_cap, liquidity, volume_24h, price_change_24h, holders,
          volume_5m, volume_1h, volume_6h,
          txn_buys_5m, txn_sells_5m, txn_buys_1h, txn_sells_1h, txn_buys_6h, txn_sells_6h,
          txn_buys_24h, txn_sells_24h, buy_sell_ratio,
          price_change_5m, price_change_1h, price_change_6h, price_change_24h_dex,
          pair_address, dex_id, quote_token, pair_created_at,
          liquidity_base, liquidity_quote, fdv,
          volume_5m_codex, volume_1h_codex, volume_4h_codex, volume_24h_codex,
          buy_count_5m_codex, sell_count_5m_codex, buy_count_1h_codex, sell_count_1h_codex,
          buy_count_4h_codex, sell_count_4h_codex, buy_count_24h_codex, sell_count_24h_codex,
          unique_buys_5m_codex, unique_sells_5m_codex, unique_buys_1h_codex, unique_sells_1h_codex,
          unique_buys_24h_codex, unique_sells_24h_codex,
          unique_transactions_5m_codex, unique_transactions_1h_codex, unique_transactions_24h_codex,
          swap_pct_1d_old_wallet, swap_pct_7d_old_wallet, wallet_age_avg, wallet_age_std,
          is_scam_codex,
          bundler_count, sniper_count, insider_count,
          bundler_held_percentage, sniper_held_percentage, insider_held_percentage, dev_held_percentage,
          is_safe, risk_score, honeypot_detected, ownership_risk, blacklist_detected,
          hidden_functions, buy_tax, sell_tax, can_take_back_ownership,
          owner_percent, top10_holder_percent, age_hours,
          bot_buys, bot_sells, net_buys, unique_users, total_activity,
          total_bots_count, multi_bot_signal,
          -- Price Action Features (OHLC-based, from candle_data)
          m1_ret_5m, m1_ret_10m, m1_ret_15m,
          m1_vol_5m, m1_vol_10m,
          m1_rvol_5m, m1_rvol_10m,
          m1_vol_slope_5m, m1_ret_slope_5m,
          m1_body_avg_5m, m1_range_avg_5m,
          m1_upper_wick_ratio_5m, m1_lower_wick_ratio_5m,
          m1_last_bar_green, m1_last_bar_long_upper_wick, m1_last_bar_doji,
          m1_consecutive_green, m1_consecutive_red,
          m5_ret_60m, m5_ret_last_3,
          m5_vol_60m, m5_rvol_15m,
          m5_price_slope_60m, m5_volume_slope_60m,
          m5_consecutive_green, m5_pullback_depth,
          pa_momo_alignment, pa_vol_ratio_m1_m5, pa_rvol_ratio_m1_m5,
          m1_candles_available, m5_candles_available
        FROM scanned_tokens
        WHERE token_address = $1 AND scan_id = $2
        LIMIT 1
      `, [tokenAddress, scanId]);
      
      return result.rows[0] || null;
    } catch (error) {
      logger.warn(`Failed to fetch scanned token from DB for ${tokenAddress}:`, error);
      return null;
    }
  }

  /**
   * Extract ML features from scanned token data
   * Must include ALL 79 features that the model expects
   */
  private async extractMLFeatures(
    scannedToken: any,
    security: SecurityAnalysis | SolanaSecurityAnalysis,
    token: any
  ): Promise<TokenFeatures> {
    // Handle both SecurityAnalysis and SolanaSecurityAnalysis types
    const contractAgeHours = (security as any).contractAgeHours || (security as any).tokenAge ? ((security as any).tokenAge / 3600) : 0;
    const riskScore = (security as any).riskScore || 0;
    const isSafe = (security as any).isSafe || false;
    const honeypotDetected = (security as any).honeypotDetected || false;
    const ownershipRisk = (security as any).ownershipRisk || false;
    const blacklistDetected = (security as any).blacklistDetected || false;
    const hiddenFunctionsDetected = (security as any).hiddenFunctionsDetected || false;
    const canTakeBackOwnership = (security as any).canTakeBackOwnership || false;

    // Get additional data (volumeMetrics, priceAction) from the map
    const additionalData = this.additionalDataMap?.get(token.token);
    const volumeMetrics = additionalData?.volumeMetrics;
    const priceAction = additionalData?.priceAction;

    // Build features object
    const features: TokenFeatures = {
      // Basic identifiers
      scanned_token_id: scannedToken.id,
      scan_price: scannedToken.price_usd || scannedToken.priceUSD || 0,
      
      // Market data
      age_hours: scannedToken.age_hours || contractAgeHours || 0,
      market_cap: scannedToken.market_cap || 0,
      liquidity: scannedToken.liquidity_usd || scannedToken.liquidity || 0,
      holders: scannedToken.holders || 0,
      
      // Volume metrics (DexScreener)
      volume_5m: volumeMetrics?.volume5m || 0,
      volume_1h: volumeMetrics?.volume1h || 0,
      volume_6h: volumeMetrics?.volume6h || 0,
      volume_24h: scannedToken.volume_24h || 0,
      
      // Price changes (DexScreener)
      price_change_5m: volumeMetrics?.priceChange5m || priceAction?.priceChange5m || 0,
      price_change_1h: volumeMetrics?.priceChange1h || priceAction?.priceChange1h || 0,
      price_change_6h: volumeMetrics?.priceChange6h || priceAction?.priceChange6h || 0,
      price_change_24h: scannedToken.price_change_24h || 0,
      price_change_24h_dex: volumeMetrics?.priceChange24h || 0,
      
      // Transaction counts (DexScreener)
      txn_buys_5m: volumeMetrics?.txnBuys5m || token.buys || 0,
      txn_sells_5m: volumeMetrics?.txnSells5m || token.sells || 0,
      txn_buys_1h: volumeMetrics?.txnBuys1h || 0,
      txn_sells_1h: volumeMetrics?.txnSells1h || 0,
      txn_buys_6h: volumeMetrics?.txnBuys6h || 0,
      txn_sells_6h: volumeMetrics?.txnSells6h || 0,
      txn_buys_24h: volumeMetrics?.txnBuys24h || 0,
      txn_sells_24h: volumeMetrics?.txnSells24h || 0,
      
      // Activity metrics
      buy_sell_ratio: volumeMetrics?.buyVsSellVolume || (token.buys / Math.max(token.sells, 1)),
      bot_buys: token.buys || 0,
      net_buys: (token.buys - token.sells) || 0,
      total_activity: (token.buys + token.sells) || 0,
      total_bots_count: token.bots?.size || 0,
      multi_bot_signal: token.bots?.size > 1 ? 1 : 0,
      discovered_by_bots_count: token.bots?.size || 0,
      
      // Security metrics
      risk_score: riskScore,
      is_safe_int: isSafe ? 1 : 0,
      honeypot_int: honeypotDetected ? 1 : 0,
      ownership_risk_int: ownershipRisk ? 1 : 0,
      blacklist_int: blacklistDetected ? 1 : 0,
      hidden_functions_int: hiddenFunctionsDetected ? 1 : 0,
      can_take_back_ownership_int: canTakeBackOwnership ? 1 : 0,
      
      // Liquidity details (DexScreener)
      fdv: volumeMetrics?.fdv || 0,
      liquidity_base: volumeMetrics?.liquidityBase || 0,
      liquidity_quote: volumeMetrics?.liquidityQuote || 0,
      pair_created_at: volumeMetrics?.pairCreatedAt ? new Date(volumeMetrics.pairCreatedAt).getTime() / 1000 : 0,
      
      // Codex extended volumes
      volume_5m_codex: scannedToken.volume_5m_codex || 0,
      volume_1h_codex: scannedToken.volume_1h_codex || 0,
      volume_4h_codex: scannedToken.volume_4h_codex || 0,
      volume_24h_codex: scannedToken.volume_24h_codex || 0,
      
      // Codex transaction counts
      buy_count_5m_codex: scannedToken.buy_count_5m_codex || 0,
      sell_count_5m_codex: scannedToken.sell_count_5m_codex || 0,
      buy_count_1h_codex: scannedToken.buy_count_1h_codex || 0,
      sell_count_1h_codex: scannedToken.sell_count_1h_codex || 0,
      buy_count_4h_codex: scannedToken.buy_count_4h_codex || 0,
      sell_count_4h_codex: scannedToken.sell_count_4h_codex || 0,
      buy_count_24h_codex: scannedToken.buy_count_24h_codex || 0,
      sell_count_24h_codex: scannedToken.sell_count_24h_codex || 0,
      
      // Codex unique transactions
      unique_buys_5m_codex: scannedToken.unique_buys_5m_codex || 0,
      unique_sells_5m_codex: scannedToken.unique_sells_5m_codex || 0,
      unique_buys_1h_codex: scannedToken.unique_buys_1h_codex || 0,
      unique_sells_1h_codex: scannedToken.unique_sells_1h_codex || 0,
      unique_buys_24h_codex: scannedToken.unique_buys_24h_codex || 0,
      unique_sells_24h_codex: scannedToken.unique_sells_24h_codex || 0,
      unique_transactions_5m_codex: scannedToken.unique_transactions_5m_codex || 0,
      unique_transactions_1h_codex: scannedToken.unique_transactions_1h_codex || 0,
      unique_transactions_24h_codex: scannedToken.unique_transactions_24h_codex || 0,
      
      // Codex wallet metrics
      swap_pct_1d_old_wallet: scannedToken.swap_pct_1d_old_wallet || 0,
      swap_pct_7d_old_wallet: scannedToken.swap_pct_7d_old_wallet || 0,
      wallet_age_avg: scannedToken.wallet_age_avg || 0,
      wallet_age_std: scannedToken.wallet_age_std || 0,
      
      // Codex wallet type metrics (risk signals)
      bundler_count: scannedToken.bundler_count || 0,
      sniper_count: scannedToken.sniper_count || 0,
      insider_count: scannedToken.insider_count || 0,
      bundler_held_percentage: scannedToken.bundler_held_percentage || 0,
      sniper_held_percentage: scannedToken.sniper_held_percentage || 0,
      insider_held_percentage: scannedToken.insider_held_percentage || 0,
      dev_held_percentage: scannedToken.dev_held_percentage || 0,
      
      // Codex scam flag
      is_scam_codex: scannedToken.is_scam_codex || 0,
      
      // Calculated quantitative metrics (volatility)
      volatility_5m: priceAction?.volatility5m || 0,
      volatility_1h: priceAction?.volatility1h || 0,
      volatility_24h: priceAction?.volatility24h || 0,
      
      // Calculated quantitative metrics (momentum)
      momentum_score: priceAction?.momentumScore || 0,
      momentum_direction: priceAction?.momentumDirection === 'ACCELERATING' ? 1 : 
                          priceAction?.momentumDirection === 'DECELERATING' ? -1 : 0,
      
      // Calculated quantitative metrics (volume ratios)
      volume_ratio_5m_1h: volumeMetrics?.volumeRatio5m1h || 0,
      volume_ratio_1h_24h: volumeMetrics?.volumeRatio1h24h || 0,
      
      // Calculated quantitative metrics (volume velocity/acceleration)
      volume_velocity: volumeMetrics?.volumeVelocity || 0,
      volume_acceleration: volumeMetrics?.volumeAcceleration || 0,
      
      // Price Action Features (OHLC-based, from candle_data)
      // 1m features (short-term microstructure)
      m1_ret_5m: scannedToken.m1_ret_5m ?? null,
      m1_ret_10m: scannedToken.m1_ret_10m ?? null,
      m1_ret_15m: scannedToken.m1_ret_15m ?? null,
      m1_vol_5m: scannedToken.m1_vol_5m ?? null,
      m1_vol_10m: scannedToken.m1_vol_10m ?? null,
      m1_rvol_5m: scannedToken.m1_rvol_5m ?? null,
      m1_rvol_10m: scannedToken.m1_rvol_10m ?? null,
      m1_vol_slope_5m: scannedToken.m1_vol_slope_5m ?? null,
      m1_ret_slope_5m: scannedToken.m1_ret_slope_5m ?? null,
      m1_body_avg_5m: scannedToken.m1_body_avg_5m ?? null,
      m1_range_avg_5m: scannedToken.m1_range_avg_5m ?? null,
      m1_upper_wick_ratio_5m: scannedToken.m1_upper_wick_ratio_5m ?? null,
      m1_lower_wick_ratio_5m: scannedToken.m1_lower_wick_ratio_5m ?? null,
      m1_last_bar_green_int: scannedToken.m1_last_bar_green ? 1 : (scannedToken.m1_last_bar_green === false ? 0 : null),
      m1_last_bar_long_upper_wick_int: scannedToken.m1_last_bar_long_upper_wick ? 1 : (scannedToken.m1_last_bar_long_upper_wick === false ? 0 : null),
      m1_last_bar_doji_int: scannedToken.m1_last_bar_doji ? 1 : (scannedToken.m1_last_bar_doji === false ? 0 : null),
      m1_consecutive_green: scannedToken.m1_consecutive_green ?? null,
      m1_consecutive_red: scannedToken.m1_consecutive_red ?? null,
      
      // 5m features (context/build-up)
      m5_ret_60m: scannedToken.m5_ret_60m ?? null,
      m5_ret_last_3: scannedToken.m5_ret_last_3 ?? null,
      m5_vol_60m: scannedToken.m5_vol_60m ?? null,
      m5_rvol_15m: scannedToken.m5_rvol_15m ?? null,
      m5_price_slope_60m: scannedToken.m5_price_slope_60m ?? null,
      m5_volume_slope_60m: scannedToken.m5_volume_slope_60m ?? null,
      m5_consecutive_green: scannedToken.m5_consecutive_green ?? null,
      m5_pullback_depth: scannedToken.m5_pullback_depth ?? null,
      m5_range_avg_30m: scannedToken.m5_range_avg_30m ?? null,
      
      // Cross-timeframe features
      pa_momo_alignment: scannedToken.pa_momo_alignment ?? null,
      pa_vol_ratio_m1_m5: scannedToken.pa_vol_ratio_m1_m5 ?? null,
      pa_rvol_ratio_m1_m5: scannedToken.pa_rvol_ratio_m1_m5 ?? null,
      
      // Microstructure features (calculated from price action)
      volume_squeeze: scannedToken.volume_squeeze ?? null,
      pullback_strength: scannedToken.pullback_strength ?? null,
      
      // Microstructure features (from database - calculated during scan)
      imbalance_5m: scannedToken.imbalance_5m ?? null,
      avg_buy_size_5m_codex: scannedToken.avg_buy_size_5m_codex ?? null,
      avg_sell_size_5m_codex: scannedToken.avg_sell_size_5m_codex ?? null,
      small_wallet_buy_ratio_5m: scannedToken.small_wallet_buy_ratio_5m ?? null,
      small_trade_buy_ratio_5m: scannedToken.small_trade_buy_ratio_5m ?? null,
      small_flow_ratio_5m: scannedToken.small_flow_ratio_5m ?? null,
      price_impact_5m: scannedToken.price_impact_5m ?? null,
      
      // Jupiter quote data (pre-trade liquidity check)
      jupiter_buy_quote_success: scannedToken.jupiter_buy_quote_success ? 1 : 0,
      jupiter_buy_quote_price_impact: scannedToken.jupiter_buy_quote_price_impact ?? null,
      jupiter_buy_quote_routes_count: scannedToken.jupiter_buy_quote_routes_count ?? null,
      jupiter_sell_quote_success: scannedToken.jupiter_sell_quote_success ? 1 : 0,
      jupiter_sell_quote_price_impact: scannedToken.jupiter_sell_quote_price_impact ?? null,
      jupiter_sell_quote_routes_count: scannedToken.jupiter_sell_quote_routes_count ?? null,
      
      // Metadata
      m1_candles_available: scannedToken.m1_candles_available ?? 0,
      m5_candles_available: scannedToken.m5_candles_available ?? 0,
      
      // Smart money features
      // Use 0 for ML when NULL (ML needs numeric values), but NULL is stored in DB to distinguish "no data" from "zero"
      smart_money_wallet_count: scannedToken.smart_money_wallet_count ?? 0,
      smart_money_buy_percentage: scannedToken.smart_money_buy_percentage ?? 0,
      smart_money_conviction_score: scannedToken.smart_money_conviction_score ?? 0,
      
      // Regime features (from scans table - shared by all tokens in scan)
      // Initialize to null, will be populated below if scan_id is available
      sol_price: null,
      sol_ret_5m: null,
      sol_ret_15m: null,
      sol_ret_1h: null,
      sol_ret_6h: null,
      sol_volatility_1h: null,
      sol_volatility_24h: null,
      sol_trend_strength: null,
    };
    
    // Compute derived Jupiter quote features (for ML model)
    const JUPITER_FEE = 0.3; // % per swap
    const buyImpact = features.jupiter_buy_quote_price_impact;
    const sellImpact = features.jupiter_sell_quote_price_impact;
    if (buyImpact != null && sellImpact != null) {
      const absBuy = Math.abs(buyImpact);
      const absSell = Math.abs(sellImpact);
      features.jupiter_roundtrip_impact = absBuy + absSell;
      features.jupiter_impact_asymmetry = absBuy > 0 ? absSell / absBuy : null;
      features.jupiter_roundtrip_cost_pct = (absBuy + absSell) * 100 + 2 * JUPITER_FEE;
      features.jupiter_buy_impact_log = Math.log1p(absBuy * 100);
      features.jupiter_sell_impact_log = Math.log1p(absSell * 100);
      const liq = features.liquidity;
      features.impact_per_unit_liquidity = liq && liq > 0 
        ? (absBuy + absSell) / Math.log1p(liq) 
        : null;
    }
    
    // Fetch regime features from scans table (if scan_id available)
    if (scannedToken.scan_id) {
      try {
        const regimeResult = await query(`
          SELECT 
            sol_price, sol_ret_5m, sol_ret_15m, sol_ret_1h, sol_ret_6h,
            sol_volatility_1h, sol_volatility_24h, sol_trend_strength,
            market_winrate_1h
          FROM scans
          WHERE id = $1
        `, [scannedToken.scan_id]);
        
        if (regimeResult.rows.length > 0) {
          const regime = regimeResult.rows[0];
          features.sol_price = regime.sol_price ?? null;
          features.sol_ret_5m = regime.sol_ret_5m ?? null;
          features.sol_ret_15m = regime.sol_ret_15m ?? null;
          features.sol_ret_1h = regime.sol_ret_1h ?? null;
          features.sol_ret_6h = regime.sol_ret_6h ?? null;
          features.sol_volatility_1h = regime.sol_volatility_1h ?? null;
          features.sol_volatility_24h = regime.sol_volatility_24h ?? null;
          features.sol_trend_strength = regime.sol_trend_strength ?? null;
          // Note: market_winrate_1h is market-level, not token-level, so it's not part of TokenFeatures
          // It should be passed separately if predictHybrid is used (not predictBatch)
        }
      } catch (error) {
        logger.debug(`[ML Features] Failed to fetch regime features for scan ${scannedToken.scan_id}:`, error);
        // Continue without regime features (non-critical)
      }
    }

    // Log feature completeness for debugging
    // Count features that have actual data (not defaulted to 0)
    const featureKeys = Object.keys(features) as (keyof TokenFeatures)[];
    const modelFeatures = featureKeys.filter(key => key !== 'scanned_token_id');
    
    // Count features with actual non-zero values (excluding scanned_token_id)
    // Note: We default missing fields to 0, so 0 values are "imputed" not "real data"
    const featuresWithRealData = modelFeatures.filter(key => {
      const value = features[key];
      // Count as "real data" if: not null, not undefined, not empty string, and not 0 (for numeric fields)
      if (value === null || value === undefined) return false;
      if (typeof value === 'string' && value === '') return false;
      if (typeof value === 'number' && value === 0) return false; // 0 is likely a default, not real data
      return true;
    });
    
    const featuresDefaultedToZero = modelFeatures.filter(key => {
      const value = features[key];
      return typeof value === 'number' && value === 0;
    });

    logger.debug(`📊 ML Features extracted for token ${features.scanned_token_id || scannedToken?.token_address || scannedToken?.id || 'unknown'}:`);
    logger.debug(`   Total features in object: ${featureKeys.length} (includes scanned_token_id)`);
    logger.debug(`   Features with real data (non-zero): ${featuresWithRealData.length}/${modelFeatures.length}`);
    logger.debug(`   Features defaulted to 0: ${featuresDefaultedToZero.length}`);
    if (featuresDefaultedToZero.length > 0 && featuresDefaultedToZero.length <= 20) {
      logger.debug(`   Defaulted to 0: ${featuresDefaultedToZero.join(', ')}`);
    } else if (featuresDefaultedToZero.length > 20) {
      logger.debug(`   Defaulted to 0: ${featuresDefaultedToZero.length} (showing first 20: ${featuresDefaultedToZero.slice(0, 20).join(', ')})`);
    }

    return features;
  }

  /**
   * Log data quality summary for point-based analysis
   */
  private logDataQualitySummary(
    tokens: any[],
    scanResult: ScanResult,
    securityResults: Map<string, SecurityAnalysis>
  ): void {
    if (tokens.length === 0) return;

    let missingMarketCap = 0;
    let missingAge = 0;
    let missingRiskScore = 0;
    let missingVolume5m = 0;
    let missingLiquidity = 0;
    let missingBuySellRatio = 0;
    let zeroVolume5m = 0;
    let zeroLiquidity = 0;
    let tokensWithAllCriticalFields = 0;

    for (const token of tokens) {
      const metadata = scanResult.tokenMetadata.get(token.token);
      const security = securityResults.get(token.token);
      const additionalData = this.additionalDataMap.get(token.token);

      if (!metadata || !security || !additionalData) continue;

      // Check critical fields
      const hasMarketCap = metadata.marketCap && metadata.marketCap > 0;
      const hasAge = security.contractAgeHours !== null && security.contractAgeHours !== undefined;
      const hasRiskScore = security.riskScore !== null && security.riskScore !== undefined;

      if (!hasMarketCap) missingMarketCap++;
      if (!hasAge) missingAge++;
      if (!hasRiskScore) missingRiskScore++;

      // Count tokens with ALL critical fields
      if (hasMarketCap && hasAge && hasRiskScore) {
        tokensWithAllCriticalFields++;
      }

      // Check other fields
      if (!additionalData.volumeMetrics?.volume5m) missingVolume5m++;
      if (additionalData.volumeMetrics?.volume5m === 0) zeroVolume5m++;
      if (!metadata.liquidity || metadata.liquidity === 0) missingLiquidity++;
      if (metadata.liquidity === 0) zeroLiquidity++;
      if (!additionalData.volumeMetrics?.buyVsSellVolume && (!token.buys || token.buys === 0)) missingBuySellRatio++;
    }

    const total = tokens.length;
    logger.info(`📊 [Point-Based] Data Quality Summary (${total} tokens):`);
    
    if (missingMarketCap > 0) {
      logger.warn(`Missing market_cap: ${missingMarketCap}/${total} (${((missingMarketCap/total)*100).toFixed(1)}%)`);
    }
    if (missingAge > 0) {
      logger.warn(`Missing age_hours: ${missingAge}/${total} (${((missingAge/total)*100).toFixed(1)}%)`);
    }
    if (missingRiskScore > 0) {
      logger.warn(`Missing risk_score: ${missingRiskScore}/${total} (${((missingRiskScore/total)*100).toFixed(1)}%)`);
    }
    if (missingVolume5m > 0) {
      logger.warn(`Missing volume_5m: ${missingVolume5m}/${total} (${((missingVolume5m/total)*100).toFixed(1)}%)`);
    }
    if (zeroVolume5m > 0) {
      logger.warn(`Zero volume_5m: ${zeroVolume5m}/${total} (${((zeroVolume5m/total)*100).toFixed(1)}%)`);
    }
    if (missingLiquidity > 0) {
      logger.warn(`Missing liquidity: ${missingLiquidity}/${total} (${((missingLiquidity/total)*100).toFixed(1)}%)`);
    }
    if (zeroLiquidity > 0) {
      logger.warn(`Zero liquidity: ${zeroLiquidity}/${total} (${((zeroLiquidity/total)*100).toFixed(1)}%)`);
    }
    if (missingBuySellRatio > 0) {
      logger.debug(`   Missing buy_sell_ratio: ${missingBuySellRatio}/${total} (${((missingBuySellRatio/total)*100).toFixed(1)}%)`);
    }

    // Overall data quality score (percentage of tokens with all critical fields)
    const dataQuality = (tokensWithAllCriticalFields / total) * 100;

    if (dataQuality === 100) {
      logger.success(`All critical fields present (${dataQuality.toFixed(0)}% data quality)`);
    } else if (dataQuality >= 66) {
      logger.warn(`Some critical fields missing (${dataQuality.toFixed(0)}% data quality)`);
    } else {
      logger.error(`Many critical fields missing (${dataQuality.toFixed(0)}% data quality)`);
    }
  }
}

