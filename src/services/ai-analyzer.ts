/**
 * AI Token Analyzer
 * Uses Claude to analyze tokens and determine if they're good buy opportunities
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TokenStats, ScanResult } from '../utils/scanner';
import type { CodexBSCTokenData } from '../infra/codex';
import { logger } from '../utils/logger';
import { ContractSecurityScanner, type SecurityAnalysis } from './contract-security-scanner';

export interface AITokenAnalysis {
  shouldAlert: boolean;
  token: string;
  symbol: string;
  reasoning: string;
  score: number; // 0-100
  risks: string[];
  opportunities: string[];
  securityAnalysis?: SecurityAnalysis; // Add security data to response
}

export interface AIBatchAnalysis {
  recommendations: AITokenAnalysis[];
  summary: string;
}

export class AITokenAnalyzer {
  private client: Anthropic | null = null;
  private enabled: boolean;
  private securityScanner: ContractSecurityScanner;
  private readonly MIN_UNIQUE_USERS: number;
  private readonly MIN_TOTAL_TRADES: number;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (apiKey && apiKey.startsWith('sk-ant-')) {
      this.client = new Anthropic({ apiKey });
      this.enabled = true;
      logger.success('✅ AI Token Analyzer enabled (Claude)');
    } else {
      this.enabled = false;
      logger.warn('⚠️  AI Token Analyzer disabled (no ANTHROPIC_API_KEY)');
    }

    // Initialize security scanner
    this.securityScanner = new ContractSecurityScanner();
    
    // Initialize thresholds from environment
    this.MIN_UNIQUE_USERS = parseInt(process.env.MIN_UNIQUE_USERS || '2', 10);
    this.MIN_TOTAL_TRADES = parseInt(process.env.MIN_TOTAL_TRADES || '5', 10);
  }

  /**
   * Analyze a batch of tokens and determine which ones are good buy opportunities
   */
  async analyzeTokens(scanResult: ScanResult): Promise<AIBatchAnalysis> {
    if (!this.enabled || !this.client) {
      logger.warn('AI analysis skipped - service disabled');
      return {
        recommendations: [],
        summary: 'AI analysis unavailable - no API key configured',
      };
    }

    try {
      logger.info('🤖 Starting AI token analysis...');
      
      // Step 1: Run security scans in parallel for all tokens
      logger.info('🔒 Running security scans on all tokens...');
      const securityResults = new Map<string, SecurityAnalysis>();
      
      const securityPromises = scanResult.topTokens.map(async (token) => {
        try {
          const analysis = await this.securityScanner.analyzeToken(token.token);
          securityResults.set(token.token, analysis);
        } catch (error) {
          logger.error(`Security scan failed for ${token.token}:`, error);
        }
      });
      
      await Promise.all(securityPromises);
      logger.success(`✅ Security scans complete: ${securityResults.size}/${scanResult.topTokens.length} tokens scanned`);
      
      // Step 2: Filter out tokens with HARD STOPS (critical security issues only)
      const safeTokens = scanResult.topTokens.filter(token => {
        const security = securityResults.get(token.token);
        if (!security) return true; // Include if scan failed (let AI decide)
        
        // HARD STOP 1: Contract not verified
        if (!security.contractVerified) {
          logger.warn(`🚨 Auto-rejecting ${token.token} - Contract NOT VERIFIED (can't review code)`);
          return false;
        }
        
        // HARD STOP 2: Honeypot detected
        if (security.honeypotDetected) {
          logger.warn(`🚨 Auto-rejecting ${token.token} - HONEYPOT (cannot sell)`);
          return false;
        }
        
        // HARD STOP 3: Hidden functions detected
        if (security.hiddenFunctionsDetected) {
          logger.warn(`🚨 Auto-rejecting ${token.token} - HIDDEN FUNCTIONS (secret backdoors)`);
          return false;
        }
        
        // HARD STOP 4: Blacklist function detected
        if (security.blacklistDetected) {
          logger.warn(`🚨 Auto-rejecting ${token.token} - BLACKLIST FUNCTION (can freeze wallets)`);
          return false;
        }
        
        // HARD STOP 5: Airdrop scam detected
        if (security.isAirdropScam) {
          logger.warn(`🚨 Auto-rejecting ${token.token} - AIRDROP SCAM (known scam pattern)`);
          return false;
        }
        
        // HARD STOP 6: Can reclaim ownership (fake renouncement)
        if (security.canTakeBackOwnership) {
          logger.warn(`🚨 Auto-rejecting ${token.token} - CAN RECLAIM OWNERSHIP (fake renouncement scam)`);
          return false;
        }
        
        // All other risks (taxes, LP lock, holder concentration, transfer pausable, etc.) 
        // will be evaluated by AI with full context
        return true;
      });
      
      // Step 2.5: Filter out tokens with INSUFFICIENT ACTIVITY
      // This prevents tokens with extremely low activity from reaching AI
      // Based on analysis: avg=4.4 users, median=3 users, avg=7 trades, median=4 trades
      
      const activeTokens = safeTokens.filter(token => {
        const totalActivity = token.buys + token.sells;
        const uniqueUsers = token.users.size;
        
        // Reject if insufficient users
        if (uniqueUsers < this.MIN_UNIQUE_USERS) {
          logger.warn(`🚨 Auto-rejecting ${token.token} - INSUFFICIENT ACTIVITY (only ${uniqueUsers} users, need ${this.MIN_UNIQUE_USERS}+)`);
          return false;
        }
        
        // Reject if insufficient total activity
        if (totalActivity < this.MIN_TOTAL_TRADES) {
          logger.warn(`🚨 Auto-rejecting ${token.token} - LOW VOLUME (only ${totalActivity} trades, need ${this.MIN_TOTAL_TRADES}+)`);
          return false;
        }
        
        return true;
      });
      
      const securityFilteredCount = scanResult.topTokens.length - safeTokens.length;
      const activityFilteredCount = safeTokens.length - activeTokens.length;
      const totalFilteredCount = securityFilteredCount + activityFilteredCount;
      
      if (securityFilteredCount > 0) {
        logger.info(`🛡️  Filtered out ${securityFilteredCount} high-risk tokens`);
      }
      if (activityFilteredCount > 0) {
        logger.info(`📊 Filtered out ${activityFilteredCount} low-activity tokens`);
      }
      
      // Early return if no active tokens remain
      if (activeTokens.length === 0) {
        logger.info('✅ No tokens passed security/activity filters - skipping AI analysis');
        return {
          recommendations: [],
          summary: 'All tokens filtered out by security or activity checks',
        };
      }
      
      // Step 3: Build filtered scan result with only active tokens
      const filteredScanResult = {
        ...scanResult,
        topTokens: activeTokens,
      };
      
      // Step 4: Build prompt with security data (only safe tokens)
      const prompt = this.buildAnalysisPrompt(filteredScanResult, securityResults);
      
      // Log the full prompt to file for debugging (not console)
      logger.debug('=== AI PROMPT START ===');
      logger.debug(prompt);
      logger.debug('=== AI PROMPT END ===');
      
      // Step 5: Get AI analysis
      const message = await this.client.messages.create({
        model: 'claude-3-5-haiku-20241022', // Use Haiku for fast, cost-effective analysis
        max_tokens: 4000,
        temperature: 0.3, // Lower temperature for more consistent analysis
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = message.content[0];
      if (content.type === 'text') {
        const analysis = this.parseAnalysis(content.text);
        
        // Step 5: Attach security analysis to recommendations
        analysis.recommendations = analysis.recommendations.map(rec => ({
          ...rec,
          securityAnalysis: securityResults.get(rec.token),
        }));
        
        const alertCount = analysis.recommendations.filter(r => r.shouldAlert).length;
        logger.success(`✅ AI analysis complete: ${alertCount}/${activeTokens.length} tokens recommended`);
        
        return analysis;
      }

      logger.warn('Unexpected AI response type');
      return {
        recommendations: [],
        summary: 'Analysis failed - unexpected response format',
      };
      
    } catch (error: any) {
      logger.error('AI analysis failed', error);
      return {
        recommendations: [],
        summary: `Analysis failed: ${error.message}`,
      };
    }
  }

  private buildAnalysisPrompt(scanResult: ScanResult, securityResults: Map<string, SecurityAnalysis>): string {
    const { topTokens, totalTrades, uniqueUsers, tokenMetadata } = scanResult;
    
    // Build token data for analysis
    const tokenData = topTokens.map((token, index) => {
      const metadata = tokenMetadata.get(token.token);
      const security = securityResults.get(token.token);
      
      // Calculate bot diversity
      const botNames = Array.from(token.bots);
      const botActivityDetails = Array.from(token.botActivity.entries())
        .map(([bot, activity]) => `${bot}: ${activity.buys}B/${activity.sells}S`)
        .join(', ');
      
      return {
        rank: index + 1,
        address: token.token,
        
        // Metadata (if available)
        name: metadata?.name || 'Unknown',
        symbol: metadata?.symbol || 'Unknown',
        price: metadata?.priceUSD || 0,
        marketCap: metadata?.marketCap || 0,
        liquidity: metadata?.liquidity || 0,
        volume24h: metadata?.volume24h || 0,
        holders: metadata?.holders || 0,
        
        // Activity metrics
        buys: token.buys,
        sells: token.sells,
        netBuys: token.netBuys,
        uniqueUsers: token.users.size,
        botsTrading: botNames.length,
        botsList: botNames,
        botActivity: botActivityDetails,
        
        // Derived metrics
        buyPressure: token.buys > 0 ? (token.netBuys / token.buys) * 100 : 0,
        volumeToLiquidityRatio: metadata?.liquidity ? (metadata.volume24h / metadata.liquidity) * 100 : 0,
        
        // Security analysis
        security: security ? {
          verified: security.contractVerified,
          riskScore: security.riskScore,
          risks: security.risks,
          warnings: security.warnings,
          honeypot: security.honeypotDetected,
          hiddenFunctions: security.hiddenFunctionsDetected,
          blacklist: security.blacklistDetected,
          // NEW: Extended data
          buyTax: security.buyTax,
          sellTax: security.sellTax,
          transferPausable: security.transferPausable,
          canTakeBackOwnership: security.canTakeBackOwnership,
          ownerPercent: security.ownerPercent,
          topHolderPercent: security.topHolderPercent,
          top10HolderPercent: security.top10HolderPercent,
          contractAgeDays: security.contractAgeDays,
          contractAgeHours: security.contractAgeHours,
          isAirdropScam: security.isAirdropScam,
          // LP Lock data
          lpLockedPercent: security.lpLockedPercent,
          lpBurnedPercent: security.lpBurnedPercent,
          lpUnlockedPercent: security.lpUnlockedPercent,
          isLpLocked: security.isLpLocked,
          isLpBurned: security.isLpBurned,
        } : null,
      };
    });

    return `You are an expert crypto analyst evaluating BSC tokens for potential buy opportunities. You will analyze tokens based on on-chain trading activity from professional trading bots.

## Scan Context
- **Total Bot Trades Detected:** ${totalTrades}
- **Unique Active Traders:** ${uniqueUsers}
- **Time Window:** Last ~15 minutes (~300 blocks)
- **Tracked Bots:** Maestro, BananaGun, Axios, Sigma, Bloom, BonkBot

## Tokens to Analyze (Top ${tokenData.length})

${tokenData.map(t => `
### ${t.rank}. ${t.name} ($${t.symbol})
**Address:** \`${t.address}\`

**Market Data:**
- Price: $${t.price.toFixed(8)}
- Market Cap: $${(t.marketCap / 1000).toFixed(1)}K
- Liquidity: $${(t.liquidity / 1000).toFixed(1)}K
- Volume 24h: $${(t.volume24h / 1000).toFixed(1)}K
- Holders: ${t.holders || 'Unknown'}

**Trading Activity (Last 15 min):**
- Buys: ${t.buys} | Sells: ${t.sells} | Net: ${t.netBuys > 0 ? '+' : ''}${t.netBuys}
- Unique Users: ${t.uniqueUsers}
- Bots Trading: ${t.botsTrading} (${t.botsList.join(', ')})
- Bot Activity: ${t.botActivity}

**Key Metrics:**
- Buy Pressure: ${t.buyPressure.toFixed(1)}% (net buys / total buys)
- Vol/Liq Ratio: ${t.volumeToLiquidityRatio.toFixed(1)}%

**🔒 Security Analysis:**
${t.security ? `
- Contract Verified: ${t.security.verified ? '✅ YES' : '❌ NO'}
- Risk Score: ${t.security.riskScore}/100 ${t.security.riskScore >= 50 ? '🚨 HIGH RISK' : t.security.riskScore >= 30 ? '⚠️ MEDIUM RISK' : '✅ LOW RISK'}
- Honeypot Detected: ${t.security.honeypot ? '🚨 YES - CANNOT SELL' : '✅ No'}
- Hidden Functions: ${t.security.hiddenFunctions ? '🚨 YES - DANGEROUS' : '✅ No'}
- Blacklist Function: ${t.security.blacklist ? '⚠️ YES' : '✅ No'}
${t.security.buyTax !== undefined ? `- Buy Tax: ${t.security.buyTax.toFixed(1)}% ${t.security.buyTax > 10 ? '⚠️ HIGH' : '✅'}` : ''}
${t.security.sellTax !== undefined ? `- Sell Tax: ${t.security.sellTax.toFixed(1)}% ${t.security.sellTax > 10 ? (t.security.sellTax > 20 ? '🚨 EXCESSIVE' : '⚠️ HIGH') : '✅'}` : ''}
${t.security.transferPausable ? '- 🚨 Owner can PAUSE trading' : ''}
${t.security.canTakeBackOwnership ? '- 🚨 Owner can RECLAIM ownership' : ''}
${t.security.topHolderPercent !== undefined ? `- Top Holder: ${t.security.topHolderPercent.toFixed(1)}% ${t.security.topHolderPercent > 30 ? '⚠️ WHALE RISK' : '✅'}` : ''}
${t.security.top10HolderPercent !== undefined ? `- Top 10 Holders: ${t.security.top10HolderPercent.toFixed(1)}% ${t.security.top10HolderPercent > 80 ? '🚨 CENTRALIZED' : t.security.top10HolderPercent > 60 ? '⚠️' : '✅'}` : ''}
${t.security.ownerPercent !== undefined ? `- Owner Holdings: ${t.security.ownerPercent.toFixed(1)}% ${t.security.ownerPercent > 20 ? '🚨 DUMP RISK' : t.security.ownerPercent > 10 ? '⚠️' : '✅'}` : ''}
${t.security.contractAgeDays !== undefined ? `- Contract Age: ${t.security.contractAgeDays < 1 ? `${t.security.contractAgeHours?.toFixed(1)} hours ${t.security.contractAgeHours! < 1 ? '🚨 BRAND NEW' : '⚠️ VERY NEW'}` : `${t.security.contractAgeDays.toFixed(1)} days`}` : ''}
${t.security.isAirdropScam ? '- 🚨 IDENTIFIED AS AIRDROP SCAM' : ''}
${t.security.lpLockedPercent !== undefined || t.security.lpBurnedPercent !== undefined ? `\n**💎 Liquidity Status:**\n${t.security.lpLockedPercent !== undefined ? `- LP Locked: ${t.security.lpLockedPercent.toFixed(1)}%` : ''}${t.security.lpBurnedPercent !== undefined ? `\n- LP Burned: ${t.security.lpBurnedPercent.toFixed(1)}%` : ''}${t.security.lpUnlockedPercent !== undefined ? `\n- LP Unlocked: ${t.security.lpUnlockedPercent.toFixed(1)}% ${t.security.lpUnlockedPercent > 50 ? '🚨 RUGPULL RISK' : t.security.lpUnlockedPercent > 20 ? '⚠️' : '✅'}` : ''}${(t.security.lpLockedPercent || 0) + (t.security.lpBurnedPercent || 0) >= 95 ? '\n- ✅ LP WELL SECURED' : (t.security.lpLockedPercent || 0) + (t.security.lpBurnedPercent || 0) < 50 ? '\n- 🚨 LP NOT SECURED - CAN RUGPULL' : ''}` : ''}
${t.security.risks.length > 0 ? `- 🚨 CRITICAL RISKS: ${t.security.risks.join('; ')}` : ''}
${t.security.warnings.length > 0 ? `- ⚠️ Warnings: ${t.security.warnings.join('; ')}` : ''}
` : '- Security scan unavailable'}
`).join('\n')}

## Your Task

You are a **MEME GEM HUNTER** 💎 analyzing tokens for **EARLY ENTRY OPPORTUNITIES**.

**MISSION:** Find NEW, FRESH meme coins with explosive potential BEFORE they become established. We want to catch rockets at launch, not after they've already mooned.

**IMPORTANT CONTEXT:** All tokens you see have ALREADY passed these filters:
- ✅ Minimum 2 unique users trading
- ✅ Minimum 5 total trades (buys + sells)
- ✅ Contract verified
- ✅ No honeypot/hidden functions/blacklist detected

You're evaluating tokens that passed basic safety checks but need deeper analysis.

### MEME GEM Positive Signals (Look for these):
1. **🚀 EARLY STAGE MOMENTUM**: New token (<24h old) with strong initial buy pressure
2. **💎 LOW MARKET CAP**: $10K-$500K market cap (room for 10-100x gains)
   - <$50K = Ultra early (high risk, high reward) ⭐⭐⭐
   - $50K-$200K = Early (good entry point) ⭐⭐
   - $200K-$500K = Still early (some upside) ⭐
   - >$500K = Getting established (less priority unless exceptional)
3. **🔥 STRONG BUY PRESSURE**: Net buys significantly positive (>60%)
4. **🤖 Multiple Bot Activity**: 2-3+ different bots trading (shows organic discovery)
   - NEW tokens can start with just 1-2 bots initially (acceptable if other signals strong)
5. **💧 Sufficient Liquidity**: $15K-$100K liquidity range
   - High liquidity = already established
   - $15K-$30K = Perfect for new gems (just launched)
   - $30K-$100K = Good (early but gaining traction)
6. **👥 Early Adopter Activity**: 
   - 2-5 users = PERFECT for brand new gems (ultra early) ⭐⭐⭐
   - 6-10 users = Still early (catching momentum) ⭐⭐
   - 11-20 users = Getting noticed (good entry) ⭐
   - 20+ users = Already discovered (less priority)
7. **📈 Volume/Liquidity Ratio**: Active trading relative to size
8. **⚡ Fresh Launch Signals**: Contract age <6 hours, rapid initial adoption

### Red Flags (Watch out for):
1. **Too Established**: 
   - Market cap >$1M = Too late for gem hunting (unless exceptional)
   - Liquidity >$200K = Already well-funded, not a fresh gem
   - 50+ users = Too discovered, not early anymore
2. **Single Bot Dominance**: 90%+ activity from one bot (might be wash trading)
   - For NEW tokens (<2h old), 1-2 bots is OK initially
3. **High Sells**: Sells > Buys (people are exiting early - bad sign)
4. **TOO New Without Activity**: Launched but no real trading volume
5. **Extreme Price**: Suspicious pricing patterns
6. **Low Liquidity for Age**: If token is >6h old but still <$15K liquidity (not gaining traction)
7. **Poor Vol/Liq Ratio**: Very high ratio might indicate manipulation
8. **🚨 ZERO SELLS WITH MANY BUYS**: 20+ buys but 0 sells (possible honeypot)
   - 50+ buys with 0 sells = Almost certainly a honeypot (INSTANT REJECT)
   - 20-49 buys with 0 sells = Very suspicious (heavy penalty)
   - 10-19 buys with 0 sells = Investigate further
   - Exception: First few minutes after launch (but still cautious)
9. **🚨 SINGLE BOT MANIPULATION:**
   - **90%+ from single bot**: Strong reject - likely manipulation/wash trading
   - **70-89% from single bot**: Heavy penalty - suspicious concentrated activity
   - **50-69% from single bot**: Moderate penalty - investigate bot diversity
   - Real organic tokens have diverse bot activity across multiple platforms
10. **🚨 CONTRACT SECURITY (CRITICAL - Already Filtered):**
   - **Note: You will NEVER see these (hard stops before AI):**
     - Unverified Contract - Already rejected
     - Honeypot Detected - Already rejected
     - Hidden Transfer Functions - Already rejected  
     - Blacklist Function - Already rejected
     - Airdrop Scam - Already rejected
     - Can Reclaim Ownership - Already rejected (fake renouncement)
   - **What you WILL evaluate:**
     - Risk Score (0-100) - Consider context and combinations
     - Owner Renounced - Not renounced = penalty (but consider LP lock)
     - LP Lock Status - <50% secured = major penalty
     - Holder Concentration - Top holder >50% = major penalty
     - Taxes - >10% = penalty (unless justified)
     - Transfer Pausable - Owner can pause = penalty
     - Contract Age - <1 day = penalty (new = risky)
   - **Risk Score Guidelines:**
     - 0-20: Excellent security (BONUS)
     - 21-40: Good security (neutral)
     - 41-60: Moderate risk (penalty, but can accept with strong metrics)
     - 61-80: High risk (heavy penalty, rarely recommend)
     - 81-100: Critical risk (almost always reject)

11. **🚨 HONEYPOT TRADING PATTERN (CRITICAL):**
   - **50+ buys with 0 sells**: INSTANT REJECT - strong honeypot indicator
   - **20-49 buys with 0 sells**: Very suspicious - heavy penalty
   - **10-19 buys with 0 sells**: Suspicious - investigate further
   - Even if security scan passes, this trading pattern is a red flag
   - Exception: First few minutes after launch (but still be cautious)

### Scoring Guidelines (MEME GEM FOCUS):
- **80-100**: 💎 HIDDEN GEM - Ultra early with massive potential (**ALERT IMMEDIATELY**)
  - Example: <$100K mcap, <6h old, 2-5 users, strong buy pressure, good security
  - Example: <$200K mcap, 3-8 users, multiple bots discovering, fresh momentum
- **70-79**: 🚀 STRONG GEM CANDIDATE - Early with good potential (**MINIMUM to alert**)
  - Example: $100K-$400K mcap, <24h old, building momentum
  - Example: 2-4 users but exceptional early metrics (multiple bots, strong buys)
- **60-69**: 📊 Interesting but wait - some potential, not quite there (DO NOT ALERT)
  - Example: Good metrics but market cap >$500K (not early enough)
  - Example: Early but security concerns
- **40-59**: ⏸️ Neutral - not a gem opportunity
- **20-39**: ❌ Avoid - red flags present
- **0-19**: 🚫 Strong avoid - multiple critical red flags

**💎 CRITICAL GEM HUNTING GUIDANCE:**
- **MARKET CAP IS KEY**: <$100K mcap = TOP PRIORITY (ultra gems)
- **EARLY = GOOD**: <$300K mcap with <12h age = PRIME GEM TERRITORY
- **LOW USER COUNT IS OK**: 2-5 users is PERFECT for brand new gems (not a penalty!)
- **FRESH OVER ESTABLISHED**: A $50K mcap token with 3 users beats a $5M token with 100 users
- **Age Matters**: <24h old = bonus points, >7 days old = not a gem anymore
- **Risk/Reward**: We accept higher risk for EARLY positioning (but still need basic security)

## Response Format

Return ONLY valid JSON in this exact format:

{
  "recommendations": [
    {
      "shouldAlert": true/false,
      "token": "0x...",
      "symbol": "TOKEN",
      "reasoning": "Brief 1-2 sentence explanation of your decision",
      "score": 85,
      "risks": ["Risk 1", "Risk 2"],
      "opportunities": ["Opportunity 1", "Opportunity 2"]
    }
  ],
  "summary": "Overall market assessment based on all tokens analyzed (1-2 sentences)"
}

**IMPORTANT:**
- **CRITICAL: Only set \`shouldAlert: true\` if score >= 70. This is mandatory.**
- If score is 65, 68, 69 → set \`shouldAlert: false\` (below threshold)
- **PRIORITIZE EARLY GEMS**: Lower market cap + fresh launch = higher scores
- **LOW USER COUNT IS GOOD**: 2-5 users on a <6h token is IDEAL, not a red flag
- Focus on EARLY MOMENTUM over established adoption
- Consider that this is a 15-minute snapshot - we want to catch the rocket early
- **🚨 HARD STOPS (already filtered)**: You won't see unverified/honeypot/hidden functions/blacklist/airdrop scam/fake renouncement
- **🚨 EVALUATE EVERYTHING ELSE**: Risk score, LP lock, bot diversity, holder concentration, etc.
- **GEM HUNTING MINDSET**: Accept moderate risk for EARLY positioning (high risk = high reward for memes)
- **ESTABLISHED COINS GET LOWER SCORES**: >$1M mcap or >50 users = not early enough (score max 60-65)
- Single bot dominance (>90%) = still reject, but 1-2 bots on fresh launches is acceptable
- LP <50% secured on tokens <24h old can be acceptable if other metrics are exceptional
- Return ONLY the JSON, no markdown, no code blocks, no additional text

Begin analysis:`;
  }

  private parseAnalysis(text: string): AIBatchAnalysis {
    try {
      // Remove markdown code blocks if present
      let cleaned = text.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/```\s*$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/```\s*$/, '');
      }
      
      const parsed = JSON.parse(cleaned);
      
      // Validate structure
      if (!parsed.recommendations || !Array.isArray(parsed.recommendations)) {
        throw new Error('Invalid response structure');
      }
      
      return {
        recommendations: parsed.recommendations,
        summary: parsed.summary || 'Analysis complete',
      };
    } catch (error) {
      logger.error('Failed to parse AI response', error);
      logger.debug('Raw response', text.substring(0, 500));
      
      return {
        recommendations: [],
        summary: 'Failed to parse AI analysis',
      };
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

