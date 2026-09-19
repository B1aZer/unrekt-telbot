/**
 * Phase 2: Entry Analyzer
 * 
 * Deep analysis of a token signal to decide if we should buy
 * Gathers additional data and uses AI to make entry decision
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';
import type { TokenStats } from '../utils/scanner';
import type { CodexBSCTokenData } from '../infra/codex';

// ============================================================================
// Types
// ============================================================================

export interface SignalData {
  token: string;
  symbol: string;
  name: string;
  aiScore: number;          // From Phase 1 (70-100)
  securityScore: number;    // From security scan
  initialData: {
    buys: number;
    sells: number;
    users: number;
    liquidity: number;
    marketCap: number;
    price: number;
    volume24h: number;
  };
}

export interface PriceAction {
  priceChange1m: number;       // % change last 1 min
  priceChange5m: number;       // % change last 5 min
  priceChange4h: number;       // % change last 4 hours
  volatility: number;          // Price volatility 0-1
  trend: 'up' | 'down' | 'sideways';
  momentum: number;            // -1 to 1
  interpretation: string;      // Human-readable summary
}

export interface WalletActivity {
  topHolders: Array<{
    address: string;
    balance: string;
    percentOfSupply: number;
  }>;
  recentBuyers: Array<{
    address: string;
    amount: string;
    timestamp: number;
    valueUsd: number;
  }>;
  recentSellers: Array<{
    address: string;
    amount: string;
    timestamp: number;
    valueUsd: number;
  }>;
  whaleActivity: {
    largeBuys: number;
    largeSells: number;
  };
}

export interface KOLActivity {
  detectedKOLs: Array<{
    address: string;
    label: string;
    reputation: number;
    action: 'buy' | 'sell';
    amount: string;
    timestamp: number;
    valueUsd: number;
    profitHistory: {
      winRate: number;
      avgProfit: number;
      totalTrades: number;
    };
  }>;
  kolBuyCount: number;
  kolSellCount: number;
  netKOLSentiment: number;
  averageKOLReputation: number;
}

export interface VolumeMetrics {
  volume5m: number;
  volume10m: number;
  volume15m: number;
  volumeVelocity: number;
  volumeAcceleration: number;
  buyVsSellVolume: number;
}

export interface LiquidityDepth {
  totalLiquidity: number;
  slippageAt1000: number;
  slippageAt5000: number;
  slippageAt10000: number;
  liquidityConcentration: number;
}

export interface EntryDecision {
  shouldBuy: boolean;
  confidence: number;
  reasoning: string;
  
  positionSize: {
    percentage: number;
    maxUsdAmount: number;
  };
  
  riskManagement: {
    stopLoss: number;
    takeProfitLevels: Array<{
      percentage: number;
      sellPercent: number;
    }>;
    timeBasedExit: number;
  };
  
  warnings: string[];
}

// ============================================================================
// Hard Stop Filters (Risk Management)
// ============================================================================

const HARD_STOPS = {
  // Liquidity (prevent rug pulls)
  MIN_LIQUIDITY_USD: parseInt(process.env.HARD_STOP_MIN_LIQUIDITY || '1000', 10),
  
  // Volume (ensure tradability)
  MIN_VOLUME_5M: parseInt(process.env.HARD_STOP_MIN_VOLUME_5M || '100', 10),
  
  // Price action (avoid obvious traps)
  MAX_DUMP_5M: parseInt(process.env.HARD_STOP_MAX_DUMP_5M || '-30', 10),
  MAX_PUMP_4H: parseInt(process.env.HARD_STOP_MAX_PUMP_4H || '1000', 10),
  
  // Market cap (risk management)
  MAX_MARKET_CAP: parseInt(process.env.HARD_STOP_MAX_MARKET_CAP || '1000000', 10),
};

// Log configuration on startup
logger.info('📋 Hard Stop Configuration:');
logger.info(`  Min Liquidity: $${HARD_STOPS.MIN_LIQUIDITY_USD.toLocaleString()}`);
logger.info(`  Min Volume (5m): $${HARD_STOPS.MIN_VOLUME_5M.toLocaleString()}`);
logger.info(`  Max Dump (5m): ${HARD_STOPS.MAX_DUMP_5M}%`);
logger.info(`  Max Pump (4h): ${HARD_STOPS.MAX_PUMP_4H}%`);
logger.info(`  Max Market Cap: $${HARD_STOPS.MAX_MARKET_CAP.toLocaleString()}`);

// ============================================================================
// Entry Analyzer Service
// ============================================================================

export class EntryAnalyzer {
  private client: Anthropic | null = null;
  private enabled: boolean;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (apiKey && apiKey.startsWith('sk-ant-')) {
      this.client = new Anthropic({ apiKey });
      this.enabled = true;
      logger.success('✅ Entry Analyzer enabled (Claude)');
    } else {
      this.enabled = false;
      logger.warn('⚠️  Entry Analyzer disabled (no ANTHROPIC_API_KEY)');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Main entry point: Analyze a signal and decide whether to buy
   */
  async analyzeEntry(signal: SignalData): Promise<EntryDecision | null> {
    if (!this.enabled || !this.client) {
      logger.warn('Entry analysis skipped - service disabled');
      return null;
    }

    try {
      logger.info(`🔍 Starting entry analysis for ${signal.symbol}`);
      
      // ========================================================================
      // HARD STOP #1: Check initial liquidity and market cap
      // ========================================================================
      if (signal.initialData.liquidity < HARD_STOPS.MIN_LIQUIDITY_USD) {
        logger.warn(`🚨 HARD STOP: Insufficient liquidity ($${signal.initialData.liquidity.toLocaleString()} < $${HARD_STOPS.MIN_LIQUIDITY_USD.toLocaleString()})`);
        return this.createRejectDecision('Insufficient liquidity (rug pull risk)');
      }
      
      if (signal.initialData.marketCap > HARD_STOPS.MAX_MARKET_CAP) {
        logger.warn(`🚨 HARD STOP: Market cap too high ($${signal.initialData.marketCap.toLocaleString()} > $${HARD_STOPS.MAX_MARKET_CAP.toLocaleString()})`);
        return this.createRejectDecision('Market cap too high (limited upside)');
      }
      
      // ========================================================================
      // Step 1: Gather additional data
      // ========================================================================
      const additionalData = await this.gatherAdditionalData(signal);
      
      // ========================================================================
      // HARD STOP #2: Check volume
      // ========================================================================
      if (additionalData.volumeMetrics.volume5m < HARD_STOPS.MIN_VOLUME_5M) {
        logger.warn(`🚨 HARD STOP: Volume too low ($${additionalData.volumeMetrics.volume5m.toLocaleString()} < $${HARD_STOPS.MIN_VOLUME_5M.toLocaleString()})`);
        return this.createRejectDecision('Insufficient trading volume');
      }
      
      // ========================================================================
      // HARD STOP #3: Check price action
      // ========================================================================
      if (additionalData.priceAction.priceChange5m < HARD_STOPS.MAX_DUMP_5M) {
        logger.warn(`🚨 HARD STOP: Dumping too hard (${additionalData.priceAction.priceChange5m}% < ${HARD_STOPS.MAX_DUMP_5M}%)`);
        return this.createRejectDecision('Heavy dump detected (falling knife)');
      }
      
      if (additionalData.priceAction.priceChange4h > HARD_STOPS.MAX_PUMP_4H) {
        logger.warn(`🚨 HARD STOP: Already pumped too much (${additionalData.priceAction.priceChange4h}% > ${HARD_STOPS.MAX_PUMP_4H}%)`);
        return this.createRejectDecision('Already pumped too much (too late)');
      }
      
      logger.success('✅ All hard stops passed - proceeding to AI analysis');
      
      // ========================================================================
      // Step 2: Build AI prompt
      // ========================================================================
      const prompt = this.buildAnalysisPrompt(signal, additionalData);
      
      // ========================================================================
      // Step 3: Get AI decision
      // ========================================================================
      logger.debug('Sending to Claude for analysis...');
      const message = await this.client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 2000,
        temperature: 0.3,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = message.content[0];
      if (content.type === 'text') {
        const decision = this.parseDecision(content.text);
        
        logger.info(`📊 Entry decision for ${signal.symbol}: ${decision.shouldBuy ? '✅ BUY' : '❌ SKIP'} (confidence: ${decision.confidence}%)`);
        logger.debug(`Reasoning: ${decision.reasoning}`);
        
        return decision;
      }

      logger.warn('Unexpected AI response type');
      return null;
      
    } catch (error: any) {
      logger.error('Entry analysis failed', error);
      return null;
    }
  }

  /**
   * Gather additional data for deep analysis
   */
  private async gatherAdditionalData(signal: SignalData) {
    logger.debug('Gathering additional data...');
    
    // Run all data gathering in parallel
    const [priceAction, walletActivity, kolActivity, volumeMetrics, liquidityDepth] = await Promise.all([
      this.getPriceAction(signal.token),
      this.getWalletActivity(signal.token),
      this.getKOLActivity(signal.token),
      this.getVolumeMetrics(signal.token),
      this.getLiquidityDepth(signal.token),
    ]);

    return {
      priceAction,
      walletActivity,
      kolActivity,
      volumeMetrics,
      liquidityDepth,
    };
  }

  /**
   * Get price action data
   */
  private async getPriceAction(tokenAddress: string): Promise<PriceAction> {
    // TODO: Implement with real PriceActionAnalyzer
    // For POC, return POSITIVE mock data
    logger.debug('Getting price action...');
    
    // Mock implementation - Simulating upward momentum
    return {
      priceChange1m: 2.5,     // +2.5% in 1 min
      priceChange5m: 8.3,     // +8.3% in 5 min
      priceChange4h: 45.0,    // +45% in 4h (good pump)
      volatility: 0.15,       // 15% volatility (moderate)
      trend: 'up',            // Clear uptrend
      momentum: 0.35,         // Bullish momentum
      interpretation: 'Strong 4h rally, rising, bullish momentum',
    };
  }

  /**
   * Analyze wallet activity
   */
  private async getWalletActivity(tokenAddress: string): Promise<WalletActivity> {
    // TODO: Implement by scanning recent blocks for transfers
    logger.debug('Analyzing wallet activity...');
    
    // Mock implementation - Simulating active trading
    const now = Date.now();
    return {
      topHolders: [
        { address: '0xabc...', balance: '1000000', percentOfSupply: 5.2 },
        { address: '0xdef...', balance: '850000', percentOfSupply: 4.1 },
        { address: '0x123...', balance: '720000', percentOfSupply: 3.8 },
      ],
      recentBuyers: [
        { address: '0x111...', amount: '50000', timestamp: now - 120000, valueUsd: 1500 },
        { address: '0x222...', amount: '35000', timestamp: now - 240000, valueUsd: 980 },
        { address: '0x333...', amount: '28000', timestamp: now - 360000, valueUsd: 750 },
        { address: '0x444...', amount: '42000', timestamp: now - 480000, valueUsd: 1150 },
        { address: '0x555...', amount: '31000', timestamp: now - 600000, valueUsd: 820 },
      ],
      recentSellers: [
        { address: '0x888...', amount: '15000', timestamp: now - 300000, valueUsd: 420 },
        { address: '0x999...', amount: '12000', timestamp: now - 720000, valueUsd: 310 },
      ],
      whaleActivity: {
        largeBuys: 3,  // 3 buys > $1000
        largeSells: 0, // 0 sells > $1000
      },
    };
  }

  /**
   * Detect KOL (Key Opinion Leader) activity
   */
  private async getKOLActivity(tokenAddress: string): Promise<KOLActivity> {
    // TODO: Implement with KOL database and recent transaction scanning
    logger.debug('Detecting KOL activity...');
    
    // Mock implementation - Simulating KOL interest
    const now = Date.now();
    return {
      detectedKOLs: [
        {
          address: '0xKOL1...',
          label: 'Smart Money Trader #47',
          reputation: 8.5,  // 8.5/10 reputation
          action: 'buy',
          amount: '75000',
          timestamp: now - 180000,
          valueUsd: 2200,
          profitHistory: {
            winRate: 72,      // 72% win rate
            avgProfit: 45,    // 45% average profit
            totalTrades: 156,
          },
        },
        {
          address: '0xKOL2...',
          label: 'DeFi Whale',
          reputation: 7.8,
          action: 'buy',
          amount: '50000',
          timestamp: now - 420000,
          valueUsd: 1450,
          profitHistory: {
            winRate: 65,
            avgProfit: 38,
            totalTrades: 89,
          },
        },
      ],
      kolBuyCount: 2,
      kolSellCount: 0,
      netKOLSentiment: 0.85,  // 0.85 = Strong bullish
      averageKOLReputation: 8.15,
    };
  }

  /**
   * Calculate volume metrics
   */
  private async getVolumeMetrics(tokenAddress: string): Promise<VolumeMetrics> {
    // TODO: Implement by aggregating recent trades
    logger.debug('Calculating volume metrics...');
    
    // Mock implementation - Simulating accelerating volume
    return {
      volume5m: 45000,   // $45K in last 5 min
      volume10m: 78000,  // $78K in last 10 min
      volume15m: 95000,  // $95K in last 15 min
      volumeVelocity: 1.8,      // 180% velocity (accelerating)
      volumeAcceleration: 0.45, // Positive acceleration
      buyVsSellVolume: 3.2,     // 3.2:1 buy/sell ratio
    };
  }

  /**
   * Check liquidity depth
   */
  private async getLiquidityDepth(tokenAddress: string): Promise<LiquidityDepth> {
    // TODO: Implement by querying PancakeSwap pair
    logger.debug('Checking liquidity depth...');
    
    // Mock implementation - Simulating healthy liquidity
    return {
      totalLiquidity: 125000,     // $125K total liquidity
      slippageAt1000: 1.2,        // 1.2% slippage for $1K trade (good)
      slippageAt5000: 4.8,        // 4.8% slippage for $5K trade (acceptable)
      slippageAt10000: 9.5,       // 9.5% slippage for $10K trade (high but doable)
      liquidityConcentration: 92, // 92% in main pair (concentrated)
    };
  }

  /**
   * Build the AI analysis prompt
   */
  private buildAnalysisPrompt(signal: SignalData, data: any): string {
    return `## Entry Analysis Request

You are a professional crypto trader analyzing whether to enter a position.

### Token Data:
- **Token**: ${signal.symbol} (${signal.token})
- **Name**: ${signal.name}
- **Initial AI Score**: ${signal.aiScore}/100
- **Security Score**: ${signal.securityScore}/100

### Market Data:
- **Current Price**: $${signal.initialData.price}
- **Market Cap**: $${signal.initialData.marketCap.toLocaleString()}
- **Liquidity**: $${signal.initialData.liquidity.toLocaleString()}
- **24h Volume**: $${signal.initialData.volume24h.toLocaleString()}

### Trading Activity (Last 15 min):
- **Buys**: ${signal.initialData.buys}
- **Sells**: ${signal.initialData.sells}
- **Unique Users**: ${signal.initialData.users}
- **Net Flow**: ${signal.initialData.buys - signal.initialData.sells > 0 ? '+' : ''}${signal.initialData.buys - signal.initialData.sells}

### Price Action:
- **1m change**: ${data.priceAction.priceChange1m}%
- **5m change**: ${data.priceAction.priceChange5m}%
- **4h change**: ${data.priceAction.priceChange4h}%
- **Trend**: ${data.priceAction.trend}
- **Momentum**: ${data.priceAction.momentum}
- **Volatility**: ${data.priceAction.volatility}
- **Interpretation**: ${data.priceAction.interpretation}

### Wallet Analysis:
- **Recent Buyers**: ${data.walletActivity.recentBuyers.length}
- **Recent Sellers**: ${data.walletActivity.recentSellers.length}
- **Large Buys (>$1K)**: ${data.walletActivity.whaleActivity.largeBuys}
- **Large Sells (>$1K)**: ${data.walletActivity.whaleActivity.largeSells}

### KOL Activity:
- **KOLs Detected**: ${data.kolActivity.detectedKOLs.length}
- **KOL Buyers**: ${data.kolActivity.kolBuyCount}
- **KOL Sellers**: ${data.kolActivity.kolSellCount}
- **Net KOL Sentiment**: ${data.kolActivity.netKOLSentiment > 0 ? '🟢 Bullish' : data.kolActivity.netKOLSentiment < 0 ? '🔴 Bearish' : '⚪ Neutral'}

### Liquidity:
- **Total**: $${data.liquidityDepth.totalLiquidity.toLocaleString()}
- **Slippage @ $1K**: ${data.liquidityDepth.slippageAt1000}%
- **Slippage @ $5K**: ${data.liquidityDepth.slippageAt5000}%

---

## Your Task:

Decide if this is a good entry point for a trade.

### Decision Criteria:
1. **Entry Timing**: Is NOW a good time based on momentum and activity?
2. **Risk/Reward**: What's the potential upside vs downside?
3. **Position Size**: How much capital should we risk (as % of wallet)?
4. **Exit Strategy**: Where should stop loss and take profit be?

### Important Considerations:
- This token ALREADY passed Phase 1 filters (score ${signal.aiScore}/100)
- It has good security (score ${signal.securityScore}/100)
- It has minimum activity (${signal.initialData.users} users, ${signal.initialData.buys} buys)
- **It passed these HARD STOPS:**
  - ✅ Liquidity >= $1,000 (current: $${signal.initialData.liquidity.toLocaleString()})
  - ✅ Market cap <= $1M (current: $${signal.initialData.marketCap.toLocaleString()})
  - ✅ Volume 5m >= $100
  - ✅ Not dumping >30% in 5m
  - ✅ Not pumped >1000% in 4h
- Focus on: Is the TIMING right? Is momentum building?

### Scoring Guidelines:
- **Confidence 80-100**: Strong buy signal, excellent timing, clear momentum
- **Confidence 70-79**: Good buy, solid setup but some concerns
- **Confidence 60-69**: Borderline, wait for better entry
- **Confidence <60**: Skip, not worth the risk

### Return Format (JSON only, no explanation):

{
  "shouldBuy": true/false,
  "confidence": 85,
  "reasoning": "Brief 1-2 sentence explanation of decision",
  
  "positionSize": {
    "percentage": 5,
    "maxUsdAmount": 100
  },
  
  "riskManagement": {
    "stopLoss": -15,
    "takeProfitLevels": [
      { "percentage": 25, "sellPercent": 30 },
      { "percentage": 50, "sellPercent": 40 },
      { "percentage": 100, "sellPercent": 30 }
    ],
    "timeBasedExit": 3600
  },
  
  "warnings": ["Warning 1", "Warning 2"]
}

**CRITICAL**: 
- Only set \`shouldBuy: true\` if confidence >= 70
- If confidence is 65-69, set shouldBuy: false (wait for better setup)
- Position size should be 2-10% based on confidence
- Stop loss should be -10% to -20%
`;
  }

  /**
   * Parse AI decision from response
   */
  private parseDecision(response: string): EntryDecision {
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const decision = JSON.parse(jsonMatch[0]) as EntryDecision;
      
      // Validate required fields
      if (typeof decision.shouldBuy !== 'boolean') {
        throw new Error('Missing shouldBuy field');
      }
      if (typeof decision.confidence !== 'number') {
        throw new Error('Missing confidence field');
      }
      
      // Enforce confidence threshold
      if (decision.confidence < 70 && decision.shouldBuy) {
        logger.warn(`AI tried to buy with low confidence (${decision.confidence}), overriding to false`);
        decision.shouldBuy = false;
      }
      
      return decision;
    } catch (error) {
      logger.error('Failed to parse AI decision', error);
      
      // Return safe default (no buy)
      return {
        shouldBuy: false,
        confidence: 0,
        reasoning: 'Failed to parse AI response',
        positionSize: { percentage: 0, maxUsdAmount: 0 },
        riskManagement: {
          stopLoss: -15,
          takeProfitLevels: [],
          timeBasedExit: 3600,
        },
        warnings: ['AI response parsing failed'],
      };
    }
  }
  
  /**
   * Create a rejection decision for hard stops
   */
  private createRejectDecision(reason: string): EntryDecision {
    return {
      shouldBuy: false,
      confidence: 0,
      reasoning: `HARD STOP: ${reason}`,
      positionSize: { percentage: 0, maxUsdAmount: 0 },
      riskManagement: {
        stopLoss: -15,
        takeProfitLevels: [],
        timeBasedExit: 3600,
      },
      warnings: [reason],
    };
  }
}

