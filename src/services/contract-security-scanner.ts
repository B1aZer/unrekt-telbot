/**
 * Contract Security Scanner
 * Analyzes BSC token contracts for common scam patterns and security issues
 */

import { createPublicClient, http, type Address, getContract } from 'viem';
import { bsc } from 'viem/chains';
import { logger } from '../utils/logger';
import { apiCache } from './api-cache';
import { rpcRequestTracker, extractHttpStatusFromError } from '../utils/rpc-request-tracker';

const RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org';
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY;

// PancakeSwap V2 Factory
const PANCAKE_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';

// Known lock contracts
const LOCK_CONTRACTS = new Set([
  '0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe', // PinkLock
  '0x71b01ebddd797c8e9e0b003ea2f4fd207fbf46cc', // Unicrypt
  '0x3f4d6bf08cb7a003488ef082102c2e6418a4551e', // Mudra
  '0xa7a4f5c26a96e0f49e5ad49f1c9b82e6b5e5a676', // Team Finance
]);

// Dead addresses (LP burn addresses)
const DEAD_ADDRESSES = new Set([
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000000',
  '0x0000000000000000000000000000000000000001',
]);

// Basic ERC20 ABI for testing transfers
const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// PancakeSwap Factory ABI (minimal)
const FACTORY_ABI = [
  {
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }],
    name: 'getPair',
    outputs: [{ name: 'pair', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export interface SecurityAnalysis {
  isSafe: boolean;
  riskScore: number; // 0-100 (0 = safe, 100 = definitely scam)
  risks: string[];
  warnings: string[];
  contractVerified: boolean;
  honeypotDetected: boolean;
  ownershipRisk: boolean;
  hiddenFunctionsDetected: boolean;
  maxTxAmountRestricted: boolean;
  blacklistDetected: boolean;
  
  // Contract details
  contractAge?: number; // in seconds
  sourceCode?: string;
  implementationContract?: string;
  
  // NEW: Extended GoPlus data
  buyTax?: number;          // Buy tax percentage (0-100)
  sellTax?: number;         // Sell tax percentage (0-100)
  transferPausable?: boolean; // Can owner pause trading?
  canTakeBackOwnership?: boolean;
  ownerPercent?: number;    // % owned by contract owner
  creatorPercent?: number;  // % owned by deployer
  topHolderPercent?: number; // Biggest holder %
  top10HolderPercent?: number; // Top 10 holders combined %
  lpHolderCount?: number;
  lpTotalSupply?: string;
  isAirdropScam?: boolean;
  isTrueToken?: boolean;
  
  // Contract age (calculated)
  contractAgeHours?: number;
  contractAgeDays?: number;
  
  // NEW: LP Lock Status
  lpPairAddress?: string;
  lpLockedPercent?: number;   // % of LP tokens locked
  lpBurnedPercent?: number;    // % of LP tokens burned
  lpUnlockedPercent?: number;  // % of LP tokens unlocked (dangerous)
  isLpLocked?: boolean;        // Is any LP locked?
  isLpBurned?: boolean;        // Is any LP burned?
  
  // Jupiter quote data (Solana only - pre-trade liquidity check at 1 SOL)
  // Critical for ML training - detects tokens with poor entry/exit liquidity
  
  // BUY quote (SOL → Token, entry liquidity)
  jupiterBuyQuoteSuccess?: boolean;
  jupiterBuyQuotePriceImpact?: number;
  jupiterBuyQuoteOutAmount?: string;
  jupiterBuyQuoteRoutesCount?: number;
  jupiterBuyQuoteError?: string;
  
  // SELL quote (Token → SOL, exit liquidity)
  jupiterSellQuoteSuccess?: boolean;
  jupiterSellQuotePriceImpact?: number;
  jupiterSellQuoteOutAmount?: string;
  jupiterSellQuoteRoutesCount?: number;
  jupiterSellQuoteError?: string;
}

export class ContractSecurityScanner {
  private client;

  constructor() {
    this.client = createPublicClient({
      chain: bsc,
      transport: http(RPC_URL),
    });
  }

  /**
   * Main analysis function - checks all security aspects
   */
  async analyzeToken(tokenAddress: string): Promise<SecurityAnalysis> {
    // Check cache first
    const cached = apiCache.getSecurityAnalysis(tokenAddress);
    if (cached) {
      logger.info(`[Security] Using cached analysis for ${tokenAddress}`);
      return cached;
    }

    logger.info(`[Security] Starting security analysis for ${tokenAddress}`);

    const analysis: SecurityAnalysis = {
      isSafe: true,
      riskScore: 0,
      risks: [],
      warnings: [],
      contractVerified: false,
      honeypotDetected: false,
      ownershipRisk: false,
      hiddenFunctionsDetected: false,
      maxTxAmountRestricted: false,
      blacklistDetected: false,
    };

    try {
      // Run all checks in parallel
      const [
        contractInfo,
        sourceCode,
        goPlusData,
        ownershipCheck,
        lpLockCheck,
      ] = await Promise.allSettled([
        this.getContractCreationInfo(tokenAddress),
        this.getSourceCode(tokenAddress),
        this.getGoPlusData(tokenAddress), // Single call for all GoPlus data
        this.checkOwnership(tokenAddress),
        this.checkLPLock(tokenAddress),
      ]);

      // Process contract creation info
      if (contractInfo.status === 'fulfilled' && contractInfo.value) {
        analysis.contractAge = contractInfo.value.age;
        
        // Very new contracts are risky (tiered, no stacking)
        if (contractInfo.value.age < 3600) { // Less than 1 hour
          analysis.warnings.push('Contract is less than 1 hour old');
          analysis.riskScore += 12;
        } else if (contractInfo.value.age < 86400) { // Less than 1 day
          analysis.warnings.push('Contract is less than 1 day old');
          analysis.riskScore += 5;
        }
      }

      // Process source code verification
      if (sourceCode.status === 'fulfilled' && sourceCode.value) {
        analysis.contractVerified = sourceCode.value.verified;
        analysis.sourceCode = sourceCode.value.code;
        analysis.implementationContract = sourceCode.value.implementation;

        if (!sourceCode.value.verified) {
          analysis.risks.push('Contract source code is NOT verified');
          // No risk score penalty - this is a HARD STOP (auto-rejected before AI)
          analysis.isSafe = false;
        } else {
          // Analyze source code for suspicious patterns
          const codeAnalysis = this.analyzeSourceCode(sourceCode.value.code);
          
          if (codeAnalysis.hasHiddenTransfers) {
            analysis.risks.push('Hidden transfer mechanisms detected in code');
            analysis.hiddenFunctionsDetected = true;
            // No risk score penalty - this is a HARD STOP (auto-rejected before AI)
            analysis.isSafe = false;
          }
          
          if (codeAnalysis.hasBlacklist) {
            analysis.risks.push('Blacklist functionality detected');
            analysis.blacklistDetected = true;
            // No risk score penalty - this is a HARD STOP (auto-rejected before AI)
            analysis.isSafe = false;
          }
          
          if (codeAnalysis.hasMaxTxAmount) {
            analysis.warnings.push('Maximum transaction amount restrictions found');
            analysis.maxTxAmountRestricted = true;
            analysis.riskScore += 8;
          }

          if (codeAnalysis.hasMintFunction && !codeAnalysis.mintIsBurned) {
            analysis.warnings.push('Owner can mint unlimited tokens');
            analysis.riskScore += 12;
          }

          // Note: Pause trading is checked via GoPlus (transferPausable) to avoid double penalty
        }
      } else {
        // Failed to get source code (API error, rate limit, etc.)
        // Don't block the token - we just couldn't verify it
        // Let AI decide with limited data
        analysis.contractVerified = false; // Unknown, assume not verified
        analysis.risks.push('Unable to verify contract source code (API unavailable)');
        analysis.warnings.push('Contract verification status unknown - BSCScan API error');
        analysis.riskScore += 15; // Penalty for unknown verification status
        // Note: We do NOT set isSafe = false here, as we couldn't actually check
        // The token might be verified, we just can't confirm it right now
      }

      // Process GoPlus security data (honeypot + extended data)
      if (goPlusData.status === 'fulfilled' && goPlusData.value) {
        const gp = goPlusData.value;
        
        // Honeypot detection
        if (gp.isHoneypot) {
          analysis.risks.push('Honeypot detected - sells may fail');
          analysis.honeypotDetected = true;
          // No risk score penalty - this is a HARD STOP (auto-rejected before AI)
          analysis.isSafe = false;
        }
        
        // Store all extended data
        analysis.buyTax = gp.buyTax;
        analysis.sellTax = gp.sellTax;
        analysis.transferPausable = gp.transferPausable;
        analysis.canTakeBackOwnership = gp.canTakeBackOwnership;
        analysis.ownerPercent = gp.ownerPercent;
        analysis.creatorPercent = gp.creatorPercent;
        analysis.topHolderPercent = gp.topHolderPercent;
        analysis.top10HolderPercent = gp.top10HolderPercent;
        analysis.lpHolderCount = gp.lpHolderCount;
        analysis.lpTotalSupply = gp.lpTotalSupply;
        analysis.isAirdropScam = gp.isAirdropScam;
        analysis.isTrueToken = gp.isTrueToken;
        
        // Calculate contract age if available
        if (analysis.contractAge) {
          analysis.contractAgeHours = analysis.contractAge / 3600;
          analysis.contractAgeDays = analysis.contractAge / 86400;
        }
        
        // Risk assessment based on taxes
        if (gp.buyTax !== undefined && gp.buyTax > 10) {
          analysis.warnings.push(`High buy tax: ${gp.buyTax.toFixed(1)}%`);
          analysis.riskScore += Math.min(12, gp.buyTax - 10);
        }
        
        // Sell tax penalties (tiered, no stacking)
        if (gp.sellTax !== undefined && gp.sellTax > 20) {
          analysis.risks.push(`Excessive sell tax: ${gp.sellTax.toFixed(1)}% (likely honeypot)`);
          analysis.riskScore += 30;
          analysis.isSafe = false;
        } else if (gp.sellTax !== undefined && gp.sellTax > 10) {
          analysis.warnings.push(`High sell tax: ${gp.sellTax.toFixed(1)}%`);
          analysis.riskScore += Math.min(15, gp.sellTax - 10);
        }
        
        // Risk assessment based on holder concentration
        if (gp.topHolderPercent !== undefined && gp.topHolderPercent > 50) {
          analysis.risks.push(`Top holder owns ${gp.topHolderPercent.toFixed(1)}% (whale risk)`);
          analysis.riskScore += 20;
          analysis.isSafe = false;
        } else if (gp.topHolderPercent !== undefined && gp.topHolderPercent > 30) {
          analysis.warnings.push(`Top holder owns ${gp.topHolderPercent.toFixed(1)}%`);
          analysis.riskScore += 8;
        }
        
        if (gp.top10HolderPercent !== undefined && gp.top10HolderPercent > 80) {
          analysis.risks.push(`Top 10 holders own ${gp.top10HolderPercent.toFixed(1)}% (centralized)`);
          analysis.riskScore += 12;
          analysis.isSafe = false;
        }
        
        // Check if owner/creator hold too much
        if (gp.ownerPercent !== undefined && gp.ownerPercent > 20) {
          analysis.risks.push(`Owner holds ${gp.ownerPercent.toFixed(1)}% (dump risk)`);
          analysis.riskScore += 20;
          analysis.isSafe = false;
        } else if (gp.ownerPercent !== undefined && gp.ownerPercent > 10) {
          analysis.warnings.push(`Owner holds ${gp.ownerPercent.toFixed(1)}%`);
          analysis.riskScore += 5;
        }
        
        // Check for airdrop scam
        if (gp.isAirdropScam) {
          analysis.risks.push('Identified as airdrop scam');
          // No risk score penalty - this is a HARD STOP (auto-rejected before AI)
          analysis.isSafe = false;
        }
        
        // Trading controls
        if (gp.transferPausable) {
          analysis.risks.push('Owner can pause trading');
          analysis.riskScore += 12;
          analysis.isSafe = false;
        }
        
        if (gp.canTakeBackOwnership) {
          analysis.risks.push('Owner can reclaim ownership after renouncing');
          // No risk score penalty - this is a HARD STOP (auto-rejected before AI)
          analysis.isSafe = false;
        }
        
        logger.info(`[Security] Extended data: Buy tax ${gp.buyTax?.toFixed(1)}%, Sell tax ${gp.sellTax?.toFixed(1)}%, Top holder ${gp.topHolderPercent?.toFixed(1)}%`);
      }

      // Process ownership check
      if (ownershipCheck.status === 'fulfilled' && ownershipCheck.value) {
        if (ownershipCheck.value.hasOwner && !ownershipCheck.value.isRenounced) {
          analysis.warnings.push('Contract owner has not renounced ownership');
          analysis.ownershipRisk = true;
          analysis.riskScore += 12;
        }
        
        // Note: Owner balance % is already checked via GoPlus data (gp.ownerPercent)
        // to avoid double penalties
      }

      // Process LP lock status
      if (lpLockCheck.status === 'fulfilled' && lpLockCheck.value) {
        const lp = lpLockCheck.value;
        
        // Store LP data
        analysis.lpPairAddress = lp.lpPairAddress;
        analysis.lpLockedPercent = lp.lpLockedPercent;
        analysis.lpBurnedPercent = lp.lpBurnedPercent;
        analysis.lpUnlockedPercent = lp.lpUnlockedPercent;
        analysis.isLpLocked = lp.isLpLocked;
        analysis.isLpBurned = lp.isLpBurned;
        
        const totalSecured = (lp.lpLockedPercent || 0) + (lp.lpBurnedPercent || 0);
        
        // Risk assessment based on LP lock status
        if (totalSecured < 50) {
          analysis.risks.push(`Only ${totalSecured.toFixed(1)}% of LP is locked/burned (rugpull risk)`);
          analysis.riskScore += 35;
          analysis.isSafe = false;
        } else if (totalSecured < 80) {
          analysis.warnings.push(`${totalSecured.toFixed(1)}% of LP is locked/burned`);
          analysis.riskScore += 12;
        } else if (totalSecured >= 95) {
          // Good! Most LP is secured
          logger.info(`[Security] LP well secured: ${totalSecured.toFixed(1)}% locked/burned`);
        }
        
        // Bonus: if LP is burned (not just locked), it's extra safe
        if (lp.lpBurnedPercent && lp.lpBurnedPercent > 50) {
          logger.info(`[Security] ${lp.lpBurnedPercent.toFixed(1)}% LP burned (permanently locked)`);
        }
      } else if (lpLockCheck.status === 'rejected') {
        // LP check failed - log error but don't penalize
        logger.warn(`[Security] LP lock check failed for ${tokenAddress}:`, lpLockCheck.reason);
        // Note: No penalty - might be bonding curve token or error
      } else {
        // No LP found - likely bonding curve token or very new
        logger.debug(`[Security] No LP pair found for ${tokenAddress} - might be bonding curve token`);
        // Note: No penalty - bonding curve tokens are actually safer
      }

      // Final safety determination
      if (analysis.riskScore >= 50) {
        analysis.isSafe = false;
      }

      // Cap risk score at 100
      analysis.riskScore = Math.min(100, analysis.riskScore);

      // Cache the result
      apiCache.setSecurityAnalysis(tokenAddress, analysis);

      // Log detailed risk breakdown if high risk
      if (analysis.riskScore >= 70) {
        logger.warn(`[Security] HIGH RISK TOKEN: ${tokenAddress}`);
        logger.warn(`[Security] Risk Score: ${analysis.riskScore}/100`);
        if (analysis.risks.length > 0) {
          logger.warn(`[Security] Risks: ${analysis.risks.join(', ')}`);
        }
        if (analysis.warnings.length > 0) {
          logger.warn(`[Security] Warnings: ${analysis.warnings.join(', ')}`);
        }
      }

      logger.info(`[Security] Analysis complete for ${tokenAddress}: Risk Score ${analysis.riskScore}/100`);
      return analysis;

    } catch (error) {
      logger.error('[Security] Error analyzing token:', error);
      
      // Return unsafe analysis on error
      return {
        isSafe: false,
        riskScore: 100,
        risks: ['Failed to analyze contract - assume unsafe'],
        warnings: [],
        contractVerified: false,
        honeypotDetected: false,
        ownershipRisk: true,
        hiddenFunctionsDetected: false,
        maxTxAmountRestricted: false,
        blacklistDetected: false,
      };
    }
  }

  /**
   * Get contract creation info from BSCScan
   */
  private async getContractCreationInfo(tokenAddress: string): Promise<{ age: number } | null> {
    if (!BSCSCAN_API_KEY) {
      logger.warn('[Security] BSCScan API key not configured');
      return null;
    }

    // Check cache
    const cached = apiCache.getContractCreation(tokenAddress);
    if (cached) return cached;

    try {
      // Use Etherscan V2 API (BSCScan requires this now)
      const url = `https://api.etherscan.io/v2/api?chainid=56&module=contract&action=getcontractcreation&contractaddresses=${tokenAddress}&apikey=${BSCSCAN_API_KEY}`;
      const response = await fetch(url);
      
      // Check if response is actually JSON
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        logger.error(`[Security] BSCScan returned non-JSON for contract creation (${response.status}): ${text.substring(0, 200)}`);
        return null;
      }
      
      const data = await response.json() as any;

      if (data.status === '1' && data.result && data.result.length > 0) {
        const txHash = data.result[0].txHash;
        
        // Get transaction to find timestamp
        try {
          const tx = await this.client.getTransaction({ hash: txHash as `0x${string}` });
          rpcRequestTracker.logRequest('getTransaction', { chain: 'bsc', success: true });
          if (tx.blockNumber) {
            try {
              const block = await this.client.getBlock({ blockNumber: tx.blockNumber });
              rpcRequestTracker.logRequest('getBlock', { chain: 'bsc', blockNumber: tx.blockNumber, success: true });
              const age = Math.floor(Date.now() / 1000) - Number(block.timestamp);
              const result = { age };
              
              // Cache the result
              apiCache.setContractCreation(tokenAddress, result);
              return result;
            } catch (error) {
              const { statusCode, errorType } = extractHttpStatusFromError(error);
              rpcRequestTracker.logRequest('getBlock', { chain: 'bsc', blockNumber: tx.blockNumber, success: false, statusCode, errorType });
              throw error;
            }
          }
        } catch (error) {
          const { statusCode, errorType } = extractHttpStatusFromError(error);
          rpcRequestTracker.logRequest('getTransaction', { chain: 'bsc', success: false, statusCode, errorType });
          throw error;
        }
      }

      return null;
    } catch (error: any) {
      const errorMsg = error.message || error.toString();
      const isRateLimit = errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('Too Many Requests');
      const isTimeout = errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT');
      
      if (isRateLimit) {
        logger.error(`[Security] BSCScan rate limit hit while getting contract creation info for ${tokenAddress}`);
      } else if (isTimeout) {
        logger.error(`[Security] Timeout getting contract creation info for ${tokenAddress}`);
      } else {
        logger.error(`[Security] Error getting contract creation info for ${tokenAddress}: ${errorMsg}`);
      }
      return null;
    }
  }

  /**
   * Get and verify source code from BSCScan
   */
  private async getSourceCode(tokenAddress: string): Promise<{ verified: boolean; code: string; implementation?: string } | null> {
    if (!BSCSCAN_API_KEY) {
      logger.warn('[Security] BSCScan API key not configured - cannot verify contracts');
      return null;
    }

    // Check cache
    const cached = apiCache.getContractVerification(tokenAddress);
    if (cached) {
      logger.debug(`[Security] Using cached verification for ${tokenAddress}: ${cached.verified ? 'Verified' : 'Not verified'}`);
      return cached;
    }

    try {
      // Use Etherscan V2 API (unified endpoint for BSC with chainid=56)
      const url = `https://api.etherscan.io/v2/api?chainid=56&module=contract&action=getsourcecode&address=${tokenAddress}&apikey=${BSCSCAN_API_KEY}`;
      const response = await fetch(url);
      
      // Check if response is actually JSON
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        logger.error(`[Security] BSCScan returned non-JSON for source code (${response.status}): ${text.substring(0, 200)}`);
        return null;
      }
      
      const data = await response.json() as any;

      logger.debug(`[Security] Etherscan V2 API response for ${tokenAddress}:`, {
        status: data.status,
        hasResult: !!data.result,
        resultLength: data.result?.length,
      });

      if (data.status === '1' && data.result && data.result.length > 0) {
        const result = data.result[0];
        const verified = result.SourceCode !== '';
        const code = result.SourceCode;
        const implementation = result.Implementation || undefined;

        logger.info(`[Security] Contract ${tokenAddress}: ${verified ? '✅ VERIFIED' : '❌ NOT VERIFIED'}`);
        
        const cacheData = { verified, code, implementation };
        
        // Cache the result
        apiCache.setContractVerification(tokenAddress, cacheData);
        
        return cacheData;
      }

      logger.warn(`[Security] Etherscan V2 returned no data for ${tokenAddress}`);
      return null;
    } catch (error: any) {
      const errorMsg = error.message || error.toString();
      const isRateLimit = errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('Too Many Requests');
      const isTimeout = errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT');
      
      if (isRateLimit) {
        logger.error(`[Security] BSCScan rate limit hit while getting source code for ${tokenAddress}`);
      } else if (isTimeout) {
        logger.error(`[Security] Timeout getting source code for ${tokenAddress}`);
      } else {
        logger.error(`[Security] Error getting source code for ${tokenAddress}: ${errorMsg}`);
      }
      return null;
    }
  }

  /**
   * Analyze source code for suspicious patterns
   */
  private analyzeSourceCode(sourceCode: string): {
    hasHiddenTransfers: boolean;
    hasBlacklist: boolean;
    hasMaxTxAmount: boolean;
    hasMintFunction: boolean;
    mintIsBurned: boolean;
    canPauseTrading: boolean;
  } {
    const code = sourceCode.toLowerCase();

    // Check for hidden transfer mechanisms
    // NOTE: Removed 'beforetokentransfer' and 'aftertokentransfer' - these are standard OpenZeppelin hooks
    const hiddenTransferPatterns = [
      '_preventmevtransfer',
      '_transferinternal',
      '_hiddentransfer',
      'internaltransfer',
    ];
    const hasHiddenTransfers = hiddenTransferPatterns.some(pattern => code.includes(pattern));

    // Check for blacklist functionality
    const blacklistPatterns = [
      'blacklist',
      'isblacklisted',
      '_blacklist',
      'blocked',
      'isbanned',
      'ban(',
    ];
    const hasBlacklist = blacklistPatterns.some(pattern => code.includes(pattern));

    // Check for max transaction limits
    const hasMaxTxAmount = code.includes('maxtxamount') || code.includes('_maxtx');

    // Check for mint function
    const hasMintFunction = code.includes('function mint') || code.includes('function _mint');

    // Check if mint is burned/renounced
    const mintIsBurned = code.includes('mintburned') || code.includes('mintingdisabled');

    // Check if trading can be paused
    const canPauseTrading = code.includes('pausetrading') || 
                            code.includes('enabletrading') || 
                            code.includes('tradingenabled');

    return {
      hasHiddenTransfers,
      hasBlacklist,
      hasMaxTxAmount,
      hasMintFunction,
      mintIsBurned,
      canPauseTrading,
    };
  }

  /**
   * Get full GoPlus security data (honeypot + extended data)
   * Single API call, cached result
   */
  private async getGoPlusData(tokenAddress: string): Promise<{
    isHoneypot: boolean;
    buyTax?: number;
    sellTax?: number;
    transferPausable?: boolean;
    canTakeBackOwnership?: boolean;
    ownerPercent?: number;
    creatorPercent?: number;
    topHolderPercent?: number;
    top10HolderPercent?: number;
    lpHolderCount?: number;
    lpTotalSupply?: string;
    isAirdropScam?: boolean;
    isTrueToken?: boolean;
  } | null> {
    // Check cache (using honeypot cache key since it's the same API)
    const cached = apiCache.getHoneypotCheck(tokenAddress);
    if (cached) {
      // If we have cached data, it means we already called this
      // Return null to indicate we should skip (data already processed)
      // This is a limitation - we only cache honeypot flag currently
      // TODO: Expand cache to store full GoPlus response
    }
    
    try {
      const url = `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${tokenAddress}`;
      const response = await fetch(url);
      const data = await response.json() as any;

      if (data.result && data.result[tokenAddress.toLowerCase()]) {
        const r = data.result[tokenAddress.toLowerCase()];
        
        // Parse honeypot
        const isHoneypot = 
          r.is_honeypot === '1' ||
          r.cannot_sell_all === '1' ||
          r.transfer_pausable === '1' ||
          r.trading_cooldown === '1';
        
        // Cache honeypot result
        apiCache.setHoneypotCheck(tokenAddress, { isHoneypot });
        
        // Parse tax values
        const buyTax = r.buy_tax ? parseFloat(r.buy_tax) * 100 : undefined;
        const sellTax = r.sell_tax ? parseFloat(r.sell_tax) * 100 : undefined;
        
        // Parse holder percentages
        const ownerPercent = r.owner_percent ? parseFloat(r.owner_percent) * 100 : undefined;
        const creatorPercent = r.creator_percent ? parseFloat(r.creator_percent) * 100 : undefined;
        
        // Calculate top holder percentages from holders array
        let topHolderPercent: number | undefined;
        let top10HolderPercent: number | undefined;
        
        if (r.holders && Array.isArray(r.holders) && r.holders.length > 0) {
          const topHolder = r.holders[0];
          topHolderPercent = topHolder.percent ? parseFloat(topHolder.percent) * 100 : undefined;
          
          const top10 = r.holders.slice(0, 10);
          top10HolderPercent = top10.reduce((sum: number, h: any) => {
            return sum + (h.percent ? parseFloat(h.percent) * 100 : 0);
          }, 0);
        }
        
        return {
          isHoneypot,
          buyTax,
          sellTax,
          transferPausable: r.transfer_pausable === '1',
          canTakeBackOwnership: r.can_take_back_ownership === '1',
          ownerPercent,
          creatorPercent,
          topHolderPercent,
          top10HolderPercent,
          lpHolderCount: r.lp_holder_count ? parseInt(r.lp_holder_count) : undefined,
          lpTotalSupply: r.lp_total_supply,
          isAirdropScam: r.is_airdrop_scam === '1',
          isTrueToken: r.is_true_token === '1',
        };
      }

      return null;
    } catch (error: any) {
      const errorMsg = error.message || error.toString();
      const isRateLimit = errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('Too Many Requests');
      const isTimeout = errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT');
      
      if (isRateLimit) {
        logger.error('[Security] GoPlus API rate limit hit');
      } else if (isTimeout) {
        logger.error('[Security] Timeout getting GoPlus data');
      } else {
        logger.error(`[Security] Error getting GoPlus data: ${errorMsg}`);
      }
      return null;
    }
  }
  
  /**
   * Check LP lock/burn status
   */
  private async checkLPLock(tokenAddress: string): Promise<{
    lpPairAddress?: string;
    lpLockedPercent?: number;
    lpBurnedPercent?: number;
    lpUnlockedPercent?: number;
    isLpLocked?: boolean;
    isLpBurned?: boolean;
  } | null> {
    try {
      const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
      
      // Get PancakeSwap pair address
      const factory = getContract({
        address: PANCAKE_FACTORY as Address,
        abi: FACTORY_ABI,
        client: this.client,
      });
      
      let pairAddress: string;
      try {
        pairAddress = await factory.read.getPair([tokenAddress as Address, WBNB as Address]) as string;
        rpcRequestTracker.logRequest('readContract', { chain: 'bsc', success: true });
      } catch (error) {
        const { statusCode, errorType } = extractHttpStatusFromError(error);
        rpcRequestTracker.logRequest('readContract', { chain: 'bsc', success: false, statusCode, errorType });
        throw error;
      }
      
      // Check if pair exists
      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
      if (!pairAddress || pairAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
        logger.debug('[Security] No PancakeSwap pair found for token');
        return null;
      }
      
      logger.info(`[Security] Found LP pair: ${pairAddress}`);
      
      // Get LP token contract
      const lpToken = getContract({
        address: pairAddress as Address,
        abi: ERC20_ABI,
        client: this.client,
      });
      
      let totalSupply: bigint;
      try {
        totalSupply = await lpToken.read.totalSupply() as bigint;
        rpcRequestTracker.logRequest('readContract', { chain: 'bsc', success: true });
      } catch (error) {
        const { statusCode, errorType } = extractHttpStatusFromError(error);
        rpcRequestTracker.logRequest('readContract', { chain: 'bsc', success: false, statusCode, errorType });
        throw error;
      }
      
      if (totalSupply === 0n) {
        logger.warn('[Security] LP pair has zero supply');
        return null;
      }
      
      // Check balances in lock contracts
      let lockedBalance = 0n;
      for (const lockContract of LOCK_CONTRACTS) {
        try {
          const balance = await lpToken.read.balanceOf([lockContract as Address]) as bigint;
          rpcRequestTracker.logRequest('readContract', { chain: 'bsc', success: true });
          lockedBalance += balance;
        } catch (error) {
          const { statusCode, errorType } = extractHttpStatusFromError(error);
          rpcRequestTracker.logRequest('readContract', { chain: 'bsc', success: false, statusCode, errorType });
          // Skip if can't read balance
        }
      }

      // Check balances in dead addresses (burned LP)
      let burnedBalance = 0n;
      for (const deadAddress of DEAD_ADDRESSES) {
        try {
          const balance = await lpToken.read.balanceOf([deadAddress as Address]) as bigint;
          rpcRequestTracker.logRequest('readContract', { chain: 'bsc', success: true });
          burnedBalance += balance;
        } catch (error) {
          const { statusCode, errorType } = extractHttpStatusFromError(error);
          rpcRequestTracker.logRequest('readContract', { chain: 'bsc', success: false, statusCode, errorType });
          // Skip if can't read balance
        }
      }
      
      // Calculate percentages
      const lpLockedPercent = Number((lockedBalance * 10000n) / totalSupply) / 100;
      const lpBurnedPercent = Number((burnedBalance * 10000n) / totalSupply) / 100;
      const lpUnlockedPercent = 100 - lpLockedPercent - lpBurnedPercent;
      
      logger.info(`[Security] LP Status: ${lpLockedPercent.toFixed(1)}% locked, ${lpBurnedPercent.toFixed(1)}% burned, ${lpUnlockedPercent.toFixed(1)}% unlocked`);
      
      return {
        lpPairAddress: pairAddress,
        lpLockedPercent,
        lpBurnedPercent,
        lpUnlockedPercent,
        isLpLocked: lpLockedPercent > 0,
        isLpBurned: lpBurnedPercent > 0,
      };
    } catch (error) {
      logger.error('[Security] Error checking LP lock:', error);
      return null;
    }
  }

  /**
   * Check ownership and owner balance
   */
  private async checkOwnership(tokenAddress: string): Promise<{
    hasOwner: boolean;
    isRenounced: boolean;
    ownerBalance?: number;
  } | null> {
    try {
      const contract = getContract({
        address: tokenAddress as Address,
        abi: ERC20_ABI,
        client: this.client,
      });

      // Try to get owner
      let ownerAddress: string | null = null;
      try {
        ownerAddress = await contract.read.owner() as string;
      } catch {
        // No owner function or already renounced
        return { hasOwner: false, isRenounced: true };
      }

      // Check if owner is zero address (renounced)
      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
      const isRenounced = ownerAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase();

      // Check owner's token balance
      let ownerBalance: number | undefined;
      if (!isRenounced) {
        try {
          const balance = await contract.read.balanceOf([ownerAddress as Address]);
          const totalSupply = await contract.read.totalSupply();
          ownerBalance = (Number(balance) / Number(totalSupply)) * 100;
        } catch {
          // Could not read balance
        }
      }

      return {
        hasOwner: true,
        isRenounced,
        ownerBalance,
      };
    } catch (error) {
      logger.error('[Security] Error checking ownership:', error);
      return null;
    }
  }
}

