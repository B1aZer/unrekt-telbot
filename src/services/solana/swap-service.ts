/**
 * Solana Swap Service
 * 
 * Executes real Solana swaps using Jupiter API
 * - Buy: SOL -> Token
 * - Sell: Token -> SOL
 * - Uses simple Keypair for signing (no Turnkey)
 */

import { 
  Keypair, 
  PublicKey, 
  VersionedTransaction, 
  Connection, 
  TransactionMessage, 
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import { 
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  createCloseAccountInstruction,
  createBurnInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID 
} from '@solana/spl-token';
import bs58 from 'bs58';
import axios from 'axios';
import { logger } from '../../utils/logger';
import { jupiterRequestTracker } from '../../utils/jupiter-request-tracker';
import { getChainConfig } from '../../config/chain';
import { 
  uiToRaw, 
  rawToUi, 
  formatRawForLog,
  isSafeForNumber,
  exceedsSolanaU64,
  JS_MAX_SAFE_INTEGER,
  SOLANA_U64_MAX
} from '../../utils/bigint-utils';

const JUPITER_API_URL = 'https://api.jup.ag';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMPFUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// ============================================================================
// SECURITY: Transaction Validation Configuration
// ============================================================================
// Defense in depth for Ultra API transactions.
// Program IDs: warn-only (Ultra uses dynamic programs per route).
// System transfers: hard block if > MAX_SOL_PER_TX (drain protection).
// ============================================================================

/**
 * Known program IDs — used for logging/visibility.
 * Unknown programs trigger a warning but do NOT block (Ultra-trusted).
 */
const ALLOWED_PROGRAM_IDS = new Set([
  // Jupiter Aggregator v6
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  // Jupiter Limit Order v2
  'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X',
  // Jupiter DCA
  'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M',
  
  // Token Program (standard SPL tokens)
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  // Token-2022 Program (newer token standard, used by pump.fun)
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  // Associated Token Account Program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  
  // Compute Budget Program (for priority fees)
  'ComputeBudget111111111111111111111111111111',
  
  // System Program (for ATA rent ONLY - transfers are validated separately)
  '11111111111111111111111111111111',
  
  // Raydium AMM v4
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  // Raydium CLMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  // Raydium CP (Constant Product)
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  
  // Orca Whirlpool
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  
  // Pump.fun Bonding Curve
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  // Pump.fun AMM (graduated tokens)
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  
  // Meteora DLMM
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  // Meteora Pools
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  
  // Phoenix DEX
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
  
  // Lifinity
  '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
  
  // OpenBook (Serum successor)
  'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', // Serum v3 (legacy)
]);

/**
 * Maximum SOL per transaction - can be absolute (SOL) or percentage (% of balance)
 * Examples: "0.5" = 0.5 SOL absolute, "5%" = 5% of balance
 * Configurable via MAX_SOL_PER_TX env; defaults to "5%" (5% of balance)
 * 
 * ALIGNMENT: Trading logic uses 0.5-2% of balance (PAPER_MAX_POSITION_PERCENT = 2%)
 * This limit should be 2-3x higher than max position size for safety buffer
 * Default: 5% (2.5x buffer over max 2% position size)
 * 
 * If percentage, will use balance-aware limit (scales with wallet size)
 * If absolute, will use fixed limit (current behavior)
 */
const MAX_SOL_PER_TX_CONFIG: string = process.env.MAX_SOL_PER_TX || '5%';


/**
 * Helper: Parse limit config (absolute SOL or percentage)
 * Returns: { isPercentage: boolean, value: number }
 */
function parseLimitConfig(config: string): { isPercentage: boolean; value: number } {
  const trimmed = config.trim();
  if (trimmed.endsWith('%')) {
    const percent = parseFloat(trimmed.slice(0, -1));
    return { isPercentage: true, value: isNaN(percent) || percent <= 0 ? 5 : percent };
  } else {
    const absolute = parseFloat(trimmed);
    return { isPercentage: false, value: isNaN(absolute) || absolute <= 0 ? 0.5 : absolute };
  }
}

/**
 * Calculate maximum SOL per transaction based on balance
 */
function getMaxSolPerTx(balance: number): number {
  const limit = parseLimitConfig(MAX_SOL_PER_TX_CONFIG);
  if (limit.isPercentage) {
    // Percentage of balance, with minimum of 0.05 SOL for safety
    return Math.max(balance * (limit.value / 100), 0.05);
  } else {
    // Absolute limit
    return limit.value;
  }
}


/**
 * Enable/disable transaction validation (instruction allowlisting)
 * Configurable via ENABLE_TX_VALIDATION env; defaults to true
 * WARNING: Disabling this removes critical security protection!
 */
const ENABLE_TX_VALIDATION: boolean = process.env.ENABLE_TX_VALIDATION !== 'false';

/**
 * Transaction validation result
 */
interface TransactionValidationResult {
  valid: boolean;
  error?: string;
  warnings: string[];
  programIds: string[];
  systemTransferLamports: bigint;
}

// Maximum allowed price impact vs Codex decision price for entry (percentage, e.g. 25 = 25%)
// Uses Codex decision price (USD) and SOL price to estimate entry price from Jupiter quote.
// Configurable via MAX_CODEX_PRICE_IMPACT_PCT env; defaults to 25% if unset/invalid.
// Set to 0 to disable codex price impact blocking (trades will execute regardless).
const MAX_CODEX_PRICE_IMPACT_PCT: number = (() => {
  const raw = process.env.MAX_CODEX_PRICE_IMPACT_PCT;
  const parsed = raw != null ? parseFloat(raw) : NaN;
  return !isNaN(parsed) && parsed >= 0 ? parsed : 25;
})();

// ============================================================================
// PumpFun Migration Retry Configuration
// ============================================================================
// When a buy fails with error 6023 (NotEnoughTokensToSell) or 6005 (BondingCurveComplete),
// the token is mid-migration from bonding curve to PumpSwap AMM.
// Wait for migration to complete, then retry through the new pool.
const PUMPFUN_MIGRATION_TIMEOUT_MS = parseInt(process.env.PUMPFUN_MIGRATION_TIMEOUT_MS || '15000', 10);
const PUMPFUN_MIGRATION_POLL_INTERVAL_MS = parseInt(process.env.PUMPFUN_MIGRATION_POLL_INTERVAL_MS || '1000', 10);
const PUMPFUN_MIGRATION_QUOTE_POLL_MS = parseInt(process.env.PUMPFUN_MIGRATION_QUOTE_POLL_MS || '1500', 10);

// ============================================================================
// Jupiter Ultra API - no priority fee config needed (Ultra handles fees internally)
// ============================================================================

/**
 * Get Jupiter HTTP headers with API key (required for Ultra API)
 */
function getJupiterHeaders(): Record<string, string> {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    logger.warn('JUPITER_API_KEY not set - Ultra API requires an API key');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  return headers;
}

// ============================================================================
// Jupiter Ultra API Types
// ============================================================================

interface UltraOrderResponse {
  transaction: string;       // base64-encoded unsigned transaction
  requestId: string;         // required for /execute
  swapType: string;          // routing type used (e.g. "rfq", "amm")
  slippageBps: number;       // RTSE-determined slippage
  // Amount fields (returned by Ultra API)
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  priceImpactPct?: number;
}

interface UltraExecuteResponse {
  status: string;            // "Success" | "Failed"
  signature: string;         // tx signature (viewable on Solscan)
  error?: string;            // error details if failed
}

interface SwapResult {
  success: boolean;
  txHash?: string;
  error?: string;
  errorType?: 'codex_price_impact'; // Type of rejection for price impact errors
  actualAmountIn?: string;
  actualAmountOut?: string;
  quoteInAmount?: string;
  quoteOutAmount?: string;
  quotePriceImpactPct?: number;
  ataRentRefund?: number; // Rent refunded from closing ATA (in lamports)
  entryAtaRentPaid?: number; // Rent paid for new ATA in entry tx (in lamports)
  closeAccountTxHash?: string; // Transaction hash for closing ATA (if separate tx)
}

export class SolanaSwapService {
  private keypair: Keypair;
  private connection: Connection;
  private rpcUrl: string;
  /** Pre-computed WSOL ATA for this wallet (SOL wrap destination in Jupiter swaps) */
  private wsolAta: string;

  constructor() {
    // Load private key from env (base58 format)
    const privateKeyBase58 = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKeyBase58) {
      throw new Error('SOLANA_PRIVATE_KEY environment variable is required');
    }

    try {
      // Try base58 first (most common Solana format)
      const privateKeyBytes = bs58.decode(privateKeyBase58);
      if (privateKeyBytes.length === 64) {
        // Full secret key (32 bytes private + 32 bytes public)
        this.keypair = Keypair.fromSecretKey(privateKeyBytes);
      } else if (privateKeyBytes.length === 32) {
        // Just private key, need to derive public key
        this.keypair = Keypair.fromSecretKey(privateKeyBytes);
      } else {
        throw new Error(`Invalid private key length: ${privateKeyBytes.length} bytes (expected 32 or 64)`);
      }
    } catch (error) {
      // Try hex format if base58 fails
      try {
        const hexKey = privateKeyBase58.startsWith('0x') ? privateKeyBase58.slice(2) : privateKeyBase58;
        const privateKeyBytes = Buffer.from(hexKey, 'hex');
        if (privateKeyBytes.length === 64) {
          this.keypair = Keypair.fromSecretKey(privateKeyBytes);
        } else if (privateKeyBytes.length === 32) {
          this.keypair = Keypair.fromSecretKey(privateKeyBytes);
        } else {
          throw new Error(`Invalid hex key length: ${privateKeyBytes.length} bytes`);
        }
      } catch (hexError) {
        throw new Error(`Invalid SOLANA_PRIVATE_KEY format. Use base58 (64 bytes) or hex (64 bytes). Base58 error: ${error}, Hex error: ${hexError}`);
      }
    }

    // Get RPC URL from config or env
    this.rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(this.rpcUrl, 'confirmed');

    // Pre-compute the WSOL ATA for this wallet.
    // Jupiter routes SOL→Token swaps through WSOL: it does a SystemProgram.transfer to
    // this ATA as the "wrap" step. We need to know this address to distinguish legitimate
    // swap wraps from drain attacks in validateTransaction().
    this.wsolAta = getAssociatedTokenAddressSync(
      new PublicKey(SOL_MINT),
      this.keypair.publicKey,
    ).toBase58();

    logger.info(`🔐 Solana Swap Service initialized`);
    logger.info(`   Wallet: ${this.keypair.publicKey.toBase58()}`);
    logger.info(`   WSOL ATA: ${this.wsolAta}`);
    logger.info(`   RPC: ${this.rpcUrl}`);
  }

  /**
   * Get wallet address
   */
  getWalletAddress(): string {
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Get SOL balance
   */
  async getSolBalance(): Promise<number> {
    try {
      const balance = await this.connection.getBalance(this.keypair.publicKey);
      return balance / 1e9; // Convert lamports to SOL
    } catch (error) {
      logger.error(`Failed to get SOL balance: ${error}`);
      return 0;
    }
  }

  /**
   * Get RAW token amount (authoritative - in smallest units as bigint)
   * This is the exact on-chain balance without any float conversion
   */
  async getRawTokenAmount(tokenMint: string): Promise<{
    ata: PublicKey;
    rawAmount: bigint;
    decimals: number;
    programId: PublicKey; // NEW: Track which program this token uses
  }> {
    const mint = new PublicKey(tokenMint);
    const owner = this.keypair.publicKey;

    // Try standard Token Program first
    let ata = await getAssociatedTokenAddress(
      mint,
      owner,
      false,
      TOKEN_PROGRAM_ID
    );
    let programId = TOKEN_PROGRAM_ID;

    let info = await this.connection.getParsedAccountInfo(ata);
    
    // If not found, try Token2022 program (some tokens like pump.fun use Token2022)
    if (!info.value) {
      logger.debug(`Token ${tokenMint.substring(0, 8)}... not found in standard Token Program, trying Token2022...`);
      ata = await getAssociatedTokenAddress(
        mint,
        owner,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      programId = TOKEN_2022_PROGRAM_ID;
      info = await this.connection.getParsedAccountInfo(ata);
      
      if (info.value) {
        logger.debug(`Found token in Token2022 program`);
      }
    }

    if (!info.value) {
      // ATA does not exist in either program
      // Log detailed error for debugging
      logger.error(`ATA does not exist for token ${tokenMint.substring(0, 8)}...`);
      logger.error(`   ATA address (Token Program): ${ata.toBase58()}`);
      logger.error(`   Owner: ${owner.toBase58()}`);
      logger.error(`   Checked both TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID`);
      logger.error(`   This usually means:`);
      logger.error(`   1. Buy transaction failed but was marked as successful`);
      logger.error(`   2. ATA creation instruction failed silently`);
      logger.error(`   3. Buy transaction partially succeeded`);
      logger.error(`   4. ATA was closed between buy and sell`);
      throw new Error(`ATA does not exist for token ${tokenMint.substring(0, 8)}... (ATA: ${ata.toBase58()})`);
    }

    const parsed = (info.value.data as any).parsed.info.tokenAmount;

    return {
      ata,
      rawAmount: BigInt(parsed.amount), // 👈 THE TRUTH - exact on-chain balance
      decimals: parsed.decimals,
      programId, // Track which program this token uses
    };
  }

  /**
   * Get token balance
   */
  async getTokenBalance(tokenMint: string): Promise<number> {
    try {
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { mint: new PublicKey(tokenMint) }
      );

      if (tokenAccounts.value.length === 0) {
        return 0;
      }

      // Sum all token accounts for this mint
      let total = 0;
      for (const account of tokenAccounts.value) {
        const amount = account.account.data.parsed.info.tokenAmount.uiAmount;
        total += amount || 0;
      }
      return total;
    } catch (error) {
      logger.error(`Failed to get token balance for ${tokenMint}: ${error}`);
      return 0;
    }
  }

  /**
   * Smart dust burning: burns dust while protecting other positions
   * 
   * Checks actual wallet balance and burns appropriately:
   * - If actual balance is also dust (< minViableTradeRaw), burns actual balance (clears all dust)
   * - If actual balance is not dust, only burns calculated remainingToSell (protects other positions)
   * 
   * @param tokenMint - Token mint address
   * @param remainingToSell - Calculated remaining amount to sell (bigint)
   * @param decimals - Token decimals
   * @param closeAccountAfterSell - Whether to close ATA after burning
   * @returns Object with burn result and ATA close result
   */
  private async burnDustSmart(
    tokenMint: string,
    remainingToSell: bigint,
    decimals: number,
    closeAccountAfterSell: boolean
  ): Promise<{
    burnSuccess: boolean;
    closeSuccess: boolean;
    ataRentRefund?: number;
    cumulativeSold?: bigint;
  }> {
    const minViableTradeRaw = 10n ** BigInt(Math.max(0, decimals - 2)); // 0.01 tokens
    
    // Check actual wallet balance before burning
    let actualWalletBalance = 0n;
    try {
      const { rawAmount: walletBalance } = await this.getRawTokenAmount(tokenMint);
      actualWalletBalance = walletBalance;
      logger.debug(`🔮 Calculated remaining: ${rawToUi(remainingToSell, decimals)} tokens, Actual wallet balance: ${rawToUi(actualWalletBalance, decimals)} tokens`);
    } catch (err) {
      logger.warn(`Failed to check wallet balance before burn: ${err}`);
      actualWalletBalance = remainingToSell; // Fallback to calculated amount
    }
    
    // Determine what to burn:
    // 1. If actual balance is dust (< 0.01), burn actual balance (handles swap rounding dust)
    // 2. If actual balance is close to calculated remaining (within tolerance), burn actual balance
    //    This handles cases where swap rounding/fees cause small discrepancies
    // 3. If actual balance is significantly higher, only burn calculated remaining (protects other positions)
    let amountToBurn: bigint;
    const isDust = actualWalletBalance > 0n && actualWalletBalance < minViableTradeRaw;
    
    if (isDust) {
      // Both are dust - burn actual balance to clear all dust
      amountToBurn = actualWalletBalance;
      logger.info(`🔮 Wallet balance (${rawToUi(actualWalletBalance, decimals)}) is dust, burning actual balance to clear all dust`);
    } else if (actualWalletBalance > 0n && remainingToSell > 0n) {
      // Check if actual balance is close to calculated remaining (likely same position with rounding)
      // Tolerance: actual balance <= calculated remaining * 1.5 OR actual balance <= calculated remaining + dust threshold
      // This handles swap rounding/fees while protecting against other positions
      const percentageTolerance = remainingToSell * 150n / 100n; // 50% tolerance
      const fixedTolerance = remainingToSell + minViableTradeRaw;
      const isCloseToCalculated = actualWalletBalance <= percentageTolerance || actualWalletBalance <= fixedTolerance;
      
      if (isCloseToCalculated && actualWalletBalance >= remainingToSell) {
        // Actual balance is close to calculated and >= calculated (likely rounding/fees)
        // Burn actual balance to clear everything
        amountToBurn = actualWalletBalance;
        logger.info(`🔮 Wallet balance (${rawToUi(actualWalletBalance, decimals)}) is close to calculated remaining (${rawToUi(remainingToSell, decimals)}), burning actual balance to clear all`);
      } else {
        // Actual balance is significantly different - only burn calculated remaining (protects other positions)
        amountToBurn = remainingToSell;
        if (actualWalletBalance > remainingToSell) {
          logger.debug(`🔮 Wallet balance (${rawToUi(actualWalletBalance, decimals)}) is higher than calculated remaining (${rawToUi(remainingToSell, decimals)}), only burning calculated remaining to protect other positions`);
        }
      }
    } else {
      // Fallback: burn calculated remaining
      amountToBurn = remainingToSell;
    }
    
    logger.info(`🔮 Auto-burning dust: ${rawToUi(amountToBurn, decimals)} tokens (too small to sell profitably)`);
    
    try {
      const burnResult = await this.burnDust(tokenMint, amountToBurn);
      if (!burnResult.success) {
        return {
          burnSuccess: false,
          closeSuccess: false,
        };
      }
      
      // After burning, wait for RPC to reflect balance change
      // sendAndConfirmTransaction already waits for confirmation, but RPC cache may lag
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Try to close ATA to recover rent
      let ataRentRefund = 0;
      let closeSuccess = false;
      if (closeAccountAfterSell) {
        // Pass retryAfterBurn=true to allow retry if balance check fails (RPC cache lag)
        const closeResult = await this.closeTokenAccount(tokenMint, false, true);
        if (closeResult.success) {
          ataRentRefund = closeResult.rentRefunded || 0;
          closeSuccess = true;
          logger.success(`🔮 Rent recovered after dust burn: ${ataRentRefund} lamports (${(ataRentRefund / 1e9).toFixed(8)} SOL)`);
        }
      }
      
      return {
        burnSuccess: true,
        closeSuccess,
        ataRentRefund,
        cumulativeSold: remainingToSell, // Use remainingToSell for tracking
      };
    } catch (error: any) {
      logger.warn(`Error burning dust: ${error.message} - will leave as dust`);
      return {
        burnSuccess: false,
        closeSuccess: false,
      };
    }
  }

  /**
   * Burn dust tokens from an ATA
   * 
   * Used to clean up small amounts left after swaps due to:
   * - AMM rounding
   * - Fee-on-transfer tokens
   * - Pump.fun curve quirks
   * 
   * This allows the ATA to be closed afterwards to recover rent.
   * 
   * @param tokenMint - Token mint address
   * @param rawAmount - Amount to burn in smallest units (bigint)
   * @returns Success status and transaction hash
   */
  async burnDust(tokenMint: string, rawAmount: bigint): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
  }> {
    try {
      if (rawAmount <= 0n) {
        return { success: true }; // Nothing to burn
      }

      const mint = new PublicKey(tokenMint);
      // Get ATA and programId (needed for Token2022 tokens)
      const { ata, programId } = await this.getRawTokenAmount(tokenMint);

      logger.info(`🔮 Burning dust: ${rawAmount.toString()} raw units of ${tokenMint.substring(0, 8)}...`);

      // createBurnInstruction accepts optional programId parameter
      // For Token2022 tokens, we must pass the correct program ID
      const burnIx = createBurnInstruction(
        ata,
        mint,
        this.keypair.publicKey,
        rawAmount,
        [], // multisig signers
        programId // Use the correct program ID (Token or Token2022)
      );

      const tx = new Transaction().add(burnIx);
      tx.feePayer = this.keypair.publicKey;
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [this.keypair],
        {
          commitment: 'confirmed',
          skipPreflight: false,
        }
      );

      logger.success(`🔮 Dust burned successfully: ${signature}`);
      return {
        success: true,
        txHash: signature,
      };
    } catch (error: any) {
      logger.error(`Failed to burn dust for ${tokenMint}:`, {
        error: error.message,
        code: error.code,
      });
      return {
        success: false,
        error: error.message || 'Unknown error during burn',
      };
    }
  }

  /**
   * Close an Associated Token Account and return rent to wallet
   * Uses RAW token amount check (bigint) - only closes if rawAmount === 0n
   * 
   * If there is dust remaining (due to AMM rounding, fee-on-transfer, etc.),
   * optionally burn it first to enable closure.
   * 
   * @param tokenMint - Token mint address
   * @param burnDustIfNeeded - If true, burn any remaining dust before closing (default: true)
   * @returns Object with success status and rent refunded in lamports (~2,039,280 lamports = 0.00203928 SOL)
   */
  async closeTokenAccount(tokenMint: string, burnDustIfNeeded: boolean = true, retryAfterBurn: boolean = false): Promise<{ 
    success: boolean; 
    rentRefunded?: number; 
    txHash?: string;
    dustBurned?: bigint;
    dustBurnTxHash?: string;
    error?: string 
  }> {
    try {
      // Get RAW token amount (authoritative - no float conversion)
      // CRITICAL: Re-read balance here to detect dust left after swaps
      // Also get programId to use correct program for closing
      const { ata, rawAmount, decimals, programId } = await this.getRawTokenAmount(tokenMint);
      
      // Handle dust if present
      if (rawAmount !== 0n) {
        const uiAmount = rawToUi(rawAmount, decimals);
        
        if (burnDustIfNeeded) {
          logger.warn(`🔮 Dust detected before close: ${formatRawForLog(rawAmount, decimals)}`);
          
          // Burn the dust
          const burnResult = await this.burnDust(tokenMint, rawAmount);
          if (!burnResult.success) {
            logger.error(`Failed to burn dust, cannot close ATA: ${burnResult.error}`);
            return {
              success: false,
              error: `Failed to burn dust: ${burnResult.error}`,
            };
          }
          
          // CRITICAL: Wait for RPC to reflect balance change after burn
          // Even though transaction is confirmed, RPC nodes may have stale cache
          logger.debug(`🔮 Waiting for RPC to reflect burn transaction...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Verify burn succeeded by re-reading balance (also get programId again)
          // Retry up to 3 times with 1 second delay between attempts
          let postBurnRaw = 0n;
          let postBurnProgramId = programId;
          let retries = 0;
          const maxRetries = 3;
          
          while (retries < maxRetries) {
            const balanceCheck = await this.getRawTokenAmount(tokenMint);
            postBurnRaw = balanceCheck.rawAmount;
            postBurnProgramId = balanceCheck.programId;
            
            if (postBurnRaw === 0n) {
              break; // Balance is zero, proceed to close
            }
            
            retries++;
            if (retries < maxRetries) {
              logger.debug(`🔮 Balance still non-zero after burn (attempt ${retries}/${maxRetries}), waiting 1s before retry...`);
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
          
          if (postBurnRaw !== 0n) {
            logger.error(`Burn appeared to succeed but balance still non-zero after ${maxRetries} retries: ${postBurnRaw.toString()}`);
            return {
              success: false,
              error: `Post-burn balance still non-zero: ${postBurnRaw.toString()}`,
            };
          }
          
          logger.success(`🔮 Dust burned, ATA now empty and closeable`);
          
          // Continue to close with dust info (pass programId - use postBurnProgramId to be safe)
          return this.performAtaClose(tokenMint, ata, postBurnProgramId, rawAmount, burnResult.txHash);
        } else {
          // Don't burn, but if retryAfterBurn is true, retry balance check (burn might have just happened)
          // Note: burnDustSmart already waits 2s before calling closeTokenAccount, so we just retry the check
          if (retryAfterBurn) {
            logger.debug(`🔮 Balance non-zero but burn may have just completed, retrying balance check...`);
            
            // Retry balance check up to 3 times with 1s delay
            let retries = 0;
            const maxRetries = 3;
            let finalRawAmount = rawAmount;
            let finalProgramId = programId;
            
            while (retries < maxRetries && finalRawAmount !== 0n) {
              const balanceCheck = await this.getRawTokenAmount(tokenMint);
              finalRawAmount = balanceCheck.rawAmount;
              finalProgramId = balanceCheck.programId;
              
              if (finalRawAmount === 0n) {
                logger.success(`🔮 Balance is now zero after retry, proceeding to close ATA`);
                return this.performAtaClose(tokenMint, ata, finalProgramId);
              }
              
              retries++;
              if (retries < maxRetries) {
                logger.debug(`🔮 Balance still non-zero (attempt ${retries}/${maxRetries}), waiting 1s before retry...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
            
            if (finalRawAmount !== 0n) {
              // Final balance still non-zero after retries
              // Check if it's small enough to auto-burn (dust threshold: < 1 token equivalent)
              const dustThreshold = 10n ** BigInt(decimals); // 1 token in raw units
              
              if (finalRawAmount < dustThreshold) {
                // Small amount - auto-burn it to recover rent
                logger.info(`🔮 Balance ${rawToUi(finalRawAmount, decimals)} tokens still remaining after retries, auto-burning to close ATA...`);
                const burnResult = await this.burnDust(tokenMint, finalRawAmount);
                if (burnResult.success) {
                  // Wait for RPC to reflect
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  // Verify burn and close
                  const postBurnCheck = await this.getRawTokenAmount(tokenMint);
                  if (postBurnCheck.rawAmount === 0n) {
                    logger.success(`🔮 Auto-burn successful, closing ATA`);
                    return this.performAtaClose(tokenMint, ata, postBurnCheck.programId, finalRawAmount, burnResult.txHash);
                  } else {
                    logger.warn(`🔮 Auto-burn succeeded but balance still ${postBurnCheck.rawAmount.toString()} - RPC lag or incoming tokens`);
                    // One more attempt
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    const finalCheck = await this.getRawTokenAmount(tokenMint);
                    if (finalCheck.rawAmount === 0n) {
                      return this.performAtaClose(tokenMint, ata, finalCheck.programId, finalRawAmount, burnResult.txHash);
                    }
                  }
                } else {
                  logger.warn(`🔮 Auto-burn failed: ${burnResult.error}`);
                }
              } else {
                // Large amount - don't burn automatically, would destroy value
                logger.warn(`🔮 Cannot close ATA ${ata.toBase58()} - raw balance = ${finalRawAmount.toString()} (${rawToUi(finalRawAmount, decimals)} UI units) is too large to auto-burn. Possible incomplete swap or incoming tokens.`);
              }
              
              return { 
                success: false, 
                error: `Account has non-zero raw balance: ${finalRawAmount.toString()} (${rawToUi(finalRawAmount, decimals)} UI units)` 
              };
            }
          } else {
            // Don't burn, just report the issue
            logger.warn(`🔮 Cannot close ATA ${ata.toBase58()} - raw balance = ${rawAmount.toString()} (${uiAmount} UI units, must be exactly 0)`);
            return { 
              success: false, 
              error: `Account has non-zero raw balance: ${rawAmount.toString()} (${uiAmount} UI units)` 
            };
          }
        }
      }
      
      // No dust, proceed directly to close (pass programId)
      return this.performAtaClose(tokenMint, ata, programId);
    } catch (error: any) {
      logger.error(`Failed to close ATA for ${tokenMint}:`, {
        error: error.message,
        code: error.code,
      });
      return {
        success: false,
        error: error.message || 'Unknown error during close account',
      };
    }
  }

  /**
   * Internal helper to perform the actual ATA close operation
   * @param programId - The program ID (TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID) used for this token
   */
  private async performAtaClose(
    tokenMint: string,
    ata: PublicKey,
    programId: PublicKey,
    dustBurned?: bigint,
    dustBurnTxHash?: string
  ): Promise<{
    success: boolean;
    rentRefunded?: number;
    txHash?: string;
    dustBurned?: bigint;
    dustBurnTxHash?: string;
    error?: string;
  }> {
    try {
      const programName = programId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token2022' : 'Token';
      logger.info(`🔮 Closing ATA for token ${tokenMint.substring(0, 8)}... (raw balance: 0, program: ${programName})`);
      
      // Get account info for rent amount
      const accountInfo = await this.connection.getParsedAccountInfo(ata);
      if (!accountInfo.value) {
        logger.warn(`🔮 ATA ${ata.toBase58()} does not exist - already closed or never created`);
        return { success: false, error: 'Account does not exist' };
      }
      
      // Get rent that will be refunded (account lamports)
      const rentLamports = accountInfo.value.lamports;
      logger.debug(`🔮 ATA ${ata.toBase58()} has ${rentLamports} lamports rent (${(rentLamports / 1e9).toFixed(8)} SOL)`);
      
      // Create close account instruction with CORRECT program ID
      // CRITICAL: Must use the same program ID that the token uses (Token2022 vs Token)
      const closeInstruction = createCloseAccountInstruction(
        ata,              // account to close
        this.keypair.publicKey,     // destination for rent lamports
        this.keypair.publicKey,     // owner/authority
        [],               // multisig signers
        programId         // 👈 Use the correct program ID (Token2022 or Token)
      );
      
      // Create transaction
      const transaction = new Transaction().add(closeInstruction);
      
      // Get recent blockhash
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = this.keypair.publicKey;
      
      // Send and confirm transaction
      logger.debug(`🔮 Sending close account transaction...`);
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.keypair],
        {
          commitment: 'confirmed',
          skipPreflight: false,
        }
      );
      
      logger.success(`🔮 ATA closed successfully: ${signature}`);
      logger.info(`🔮 Rent refunded: ${rentLamports} lamports (${(rentLamports / 1e9).toFixed(8)} SOL)`);
      logger.info(`🔮 Closed ATA: ${ata.toBase58()}`);
      
      return {
        success: true,
        rentRefunded: rentLamports,
        txHash: signature,
        dustBurned,
        dustBurnTxHash,
      };
    } catch (error: any) {
      logger.error(`Failed to perform ATA close for ${tokenMint}:`, {
        error: error.message,
        code: error.code,
      });
      return {
        success: false,
        error: error.message || 'Unknown error during close account',
      };
    }
  }

  /**
   * Helper method to attempt closing ATA if balance is 0 or dust
   * Consolidates the duplicated ATA closing logic used in multiple places
   * 
   * @param tokenMint - Token mint address
   * @param decimals - Token decimals
   * @param context - Context string for logging (e.g., "after sell", "after partial exit ladder")
   * @returns Object with success status and rent refunded
   */
  private async tryCloseAtaIfEmpty(
    tokenMint: string,
    decimals: number,
    context: string = ""
  ): Promise<{
    success: boolean;
    rentRefunded?: number;
    txHash?: string;
    error?: string;
  }> {
    try {
      // Wait a bit for any pending transactions to settle
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check current wallet balance
      const { rawAmount: balance } = await this.getRawTokenAmount(tokenMint);
      const minViableTradeRaw = 10n ** BigInt(Math.max(0, decimals - 2)); // 0.01 tokens
      const smallRemainderRaw = 10n ** BigInt(Math.max(0, decimals - 1)); // 0.1 tokens
      const isDust = balance > 0n && balance < minViableTradeRaw;
      const isSmallRemainder = balance >= minViableTradeRaw && balance < smallRemainderRaw;
      
      if (balance === 0n || isDust || isSmallRemainder) {
        // If there's dust or small remainder, burn it first
        if (isDust || isSmallRemainder) {
          const amountUi = rawToUi(balance, decimals);
          const type = isDust ? 'dust' : 'small remainder';
          logger.info(`🔮 ${context ? context + ': ' : ''}Burning remaining ${type} (${amountUi} tokens) before closing ATA`);
          const burnResult = await this.burnDust(tokenMint, balance);
          if (burnResult.success) {
            // Wait for RPC to reflect balance change
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            logger.warn(`Failed to burn ${type} before closing ATA: ${burnResult.error}`);
            // Continue anyway - might still be able to close
          }
        }
        
        // Try to close ATA
        // Pass false to not burn again (we already handled it), true to allow retry
        const closeResult = await this.closeTokenAccount(tokenMint, false, true);
        if (closeResult.success) {
          const rentRefunded = closeResult.rentRefunded || 0;
          logger.success(`🔮 ${context ? context + ': ' : ''}ATA closed successfully, rent refunded: ${rentRefunded} lamports (${(rentRefunded / 1e9).toFixed(8)} SOL)`);
          return {
            success: true,
            rentRefunded,
            txHash: closeResult.txHash,
          };
        } else {
          // Check if there's remaining balance (dust or other positions)
          try {
            const { rawAmount: finalBalance } = await this.getRawTokenAmount(tokenMint);
            if (finalBalance > 0n) {
              const remainingUi = rawToUi(finalBalance, decimals);
              logger.debug(`🔮 ${context ? context + ': ' : ''}Not closing ATA: ${finalBalance.toString()} raw units remaining (${remainingUi} UI units) - may be other positions or dust`);
            } else {
              logger.debug(`🔮 ${context ? context + ': ' : ''}Could not close ATA: ${closeResult.error}`);
            }
          } catch (err) {
            logger.debug(`🔮 ${context ? context + ': ' : ''}Could not close ATA: ${closeResult.error}`);
          }
          return {
            success: false,
            error: closeResult.error || 'Unknown error',
          };
        }
      } else {
        const remainingUi = rawToUi(balance, decimals);
        logger.debug(`🔮 ${context ? context + ': ' : ''}Not closing ATA: ${remainingUi} tokens remaining (above small remainder threshold of 0.1 tokens)`);
        return {
          success: false,
          error: `Balance above small remainder threshold: ${remainingUi} tokens`,
        };
      }
    } catch (err: any) {
      logger.debug(`🔮 ${context ? context + ': ' : ''}Error checking/closing ATA: ${err.message}`);
      return {
        success: false,
        error: err.message || 'Unknown error',
      };
    }
  }

  /**
   * Clean up residual tokens left in wallet from prior swaps and close ATA to recover rent.
   * Call this when you know there are no other open positions for this token.
   *
   * Handles: swap rounding dust, accumulated residue from multiple trades, Token2022 fee artifacts.
   * Strategy: sell remaining tokens if possible (they have value), fall back to burn+close.
   */
  async cleanupResidualTokens(tokenMint: string): Promise<{
    success: boolean;
    rentRefunded?: number;
    solRecovered?: number;
    txHash?: string;
    error?: string;
  }> {
    try {
      const { rawAmount, decimals } = await this.getRawTokenAmount(tokenMint);
      const balanceUi = rawToUi(rawAmount, decimals);

      if (rawAmount === 0n) {
        // Balance is 0 but ATA might still be open - try direct close
        const closeResult = await this.closeTokenAccount(tokenMint, false, false);
        return {
          success: closeResult.success,
          rentRefunded: closeResult.rentRefunded,
          txHash: closeResult.txHash,
          error: closeResult.error,
        };
      }

      const balanceNum = parseFloat(balanceUi);
      logger.info(`🔮 [ATA Cleanup] ${balanceUi} residual tokens found for ${tokenMint.substring(0, 8)}..., attempting sell+close`);

      // Try to sell residual tokens (they have value)
      const sellResult = await this.sellToken(tokenMint, balanceNum, true, false);
      if (sellResult.success) {
        const solRecovered = parseFloat(sellResult.actualAmountOut || '0') / 1e9;
        logger.success(`🔮 [ATA Cleanup] Sold ${balanceUi} residual tokens for ${solRecovered.toFixed(8)} SOL`);

        return {
          success: sellResult.ataRentRefund ? sellResult.ataRentRefund > 0 : false,
          rentRefunded: sellResult.ataRentRefund,
          solRecovered,
          txHash: sellResult.closeAccountTxHash || sellResult.txHash,
          // If sell succeeded but ATA wasn't closed by sellToken, try explicit close
          ...(!sellResult.ataRentRefund ? await (async () => {
            const closeResult = await this.closeTokenAccount(tokenMint, true, true);
            return {
              success: closeResult.success,
              rentRefunded: closeResult.rentRefunded,
              txHash: closeResult.txHash,
              error: closeResult.success ? undefined : closeResult.error,
            };
          })() : {}),
        };
      }

      // Sell failed (no liquidity?) - try burn+close
      logger.warn(`🔮 [ATA Cleanup] Sell failed, attempting burn+close for ${balanceUi} tokens`);
      const closeResult = await this.closeTokenAccount(tokenMint, true, true);
      return {
        success: closeResult.success,
        rentRefunded: closeResult.rentRefunded,
        txHash: closeResult.txHash,
        error: closeResult.success ? undefined : closeResult.error,
      };
    } catch (err: any) {
      logger.warn(`🔮 [ATA Cleanup] Failed for ${tokenMint.substring(0, 8)}...: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Get token decimals from mint address
   */
  async getTokenDecimals(tokenMint: string): Promise<number> {
    try {
      const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(tokenMint));
      const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals;
      if (decimals !== undefined && decimals !== null) {
        return decimals;
      }
      // Fallback: try to get from token account if mint info fails
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { mint: new PublicKey(tokenMint) }
      );
      if (tokenAccounts.value.length > 0) {
        return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.decimals || 9;
      }
      return 9; // Default fallback
    } catch (error) {
      logger.warn(`Failed to get token decimals for ${tokenMint}, using default 9: ${error}`);
      return 9; // Default fallback
    }
  }

  /**
   * Find wallet's account index in transaction for SOL balance lookups
   * 
   * IMPORTANT: Do NOT assume wallet is at index 0.
   * The order of accounts in a transaction is determined by the transaction builder,
   * not by any fixed rule about wallet position.
   */
  private findWalletIndex(tx: any, ownerAddress: string): number {
    // For versioned transactions, check both static and loaded addresses
    const message = tx.transaction.message;
    
    // Try staticAccountKeys first (most common case)
    if (message.staticAccountKeys) {
      const idx = message.staticAccountKeys.findIndex(
        (k: PublicKey) => k.toBase58() === ownerAddress
      );
      if (idx !== -1) return idx;
    }
    
    // For legacy transactions, try accountKeys
    if (message.accountKeys) {
      const idx = message.accountKeys.findIndex(
        (k: PublicKey) => k.toBase58() === ownerAddress
      );
      if (idx !== -1) return idx;
    }
    
    // Fallback to index 0 with warning (should rarely happen)
    logger.warn(`[getActualAmountsFromTx] Could not find wallet ${ownerAddress} in transaction accounts, falling back to index 0`);
    return 0;
  }

  /**
   * Parse actual amounts from on-chain transaction using token balance changes
   * (Similar to shogun-bot-new/src/infra/rpc/solana.ts:getActualAmountFromTx)
   * 
   * NOTE: entryAtaRentPaid is best-effort telemetry, not accounting truth.
   * Jupiter may fund ATA via temp accounts, and some routes reuse existing ATAs.
   * Do not rely on this for PnL calculations.
   */
  private async getActualAmountsFromTx(
    signature: string,
    inputMint: string,
    outputMint: string,
    ownerAddress: string
  ): Promise<{ success: boolean; actualAmountIn?: string; actualAmountOut?: string; entryAtaRentPaid?: number; error?: string }> {
    try {
      // Fetch transaction with token balances
      const tx = await this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || !tx.meta) {
        return { success: false, error: 'Transaction not found or has no metadata' };
      }

      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];
      const preLamports = tx.meta.preBalances || [];
      const postLamports = tx.meta.postBalances || [];
      
      // Find the wallet's index in the transaction accounts
      // CRITICAL: Do not assume wallet is at index 0
      const walletIndex = this.findWalletIndex(tx, ownerAddress);

      // Detect ATA rent paid for new output token account (entry buys)
      // NOTE: This is best-effort telemetry. Jupiter may fund ATA via temp accounts,
      // and some routes reuse existing ATAs. Do not trust this for PnL calculations.
      let entryAtaRentPaid: bigint = 0n;
      if (inputMint === SOL_MINT && outputMint !== SOL_MINT) {
        const postToken = postBalances.find(
          b => b.mint === outputMint && b.owner === ownerAddress
        );
        const preToken = postToken
          ? preBalances.find(b => b.accountIndex === postToken.accountIndex)
          : null;
        if (postToken && !preToken) {
          const accountIndex = postToken.accountIndex;
          const preLamportBalance = BigInt(preLamports[accountIndex] || 0);
          const postLamportBalance = BigInt(postLamports[accountIndex] || 0);
          const rentPaid = postLamportBalance - preLamportBalance;
          if (rentPaid > 0n) {
            entryAtaRentPaid = rentPaid;
          }
        }
      }

      // Find input token balance change (SOL or token being sold)
      let actualIn: bigint | null = null;
      if (inputMint === SOL_MINT) {
        // For SOL input, use SOL balance change at wallet's index
        const preBalance = preLamports[walletIndex] || 0;
        const postBalance = postLamports[walletIndex] || 0;
        actualIn = BigInt(preBalance - postBalance); // Amount spent
      } else {
        // For token input, find balance change
        const preBalance = preBalances.find(b => b.mint === inputMint && b.owner === ownerAddress);
        const postBalance = postBalances.find(b => b.mint === inputMint && b.owner === ownerAddress);
        if (preBalance && postBalance) {
          actualIn = BigInt(preBalance.uiTokenAmount.amount) - BigInt(postBalance.uiTokenAmount.amount);
        }
      }

      // Find output token balance change (token being bought or SOL)
      let actualOut: bigint | null = null;
      if (outputMint === SOL_MINT) {
        // For SOL output, use SOL balance change at wallet's index
        const preBalance = preLamports[walletIndex] || 0;
        const postBalance = postLamports[walletIndex] || 0;
        actualOut = BigInt(postBalance - preBalance); // Amount received
      } else {
        // For token output, find balance change
        const postBalance = postBalances.find(b => b.mint === outputMint && b.owner === ownerAddress);
        const preBalance = preBalances.find(
          b => b.accountIndex === postBalance?.accountIndex && b.mint === outputMint
        );
        if (postBalance) {
          const postAmount = BigInt(postBalance.uiTokenAmount.amount);
          const preAmount = preBalance ? BigInt(preBalance.uiTokenAmount.amount) : 0n;
          actualOut = postAmount - preAmount;
        }
      }

      if (actualIn === null || actualOut === null || actualIn <= 0n || actualOut <= 0n) {
        return { 
          success: false, 
          error: `Invalid balance changes: in=${actualIn?.toString()}, out=${actualOut?.toString()}` 
        };
      }

      return {
        success: true,
        actualAmountIn: actualIn.toString(),
        actualAmountOut: actualOut.toString(),
        entryAtaRentPaid: entryAtaRentPaid > 0n ? Number(entryAtaRentPaid) : undefined,
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // ============================================================================
  // SECURITY: Transaction Validation (defense in depth for Ultra)
  // ============================================================================
  // Program IDs: warn-only (Ultra uses dynamic programs per route)
  // System transfers: hard block if > MAX_SOL_PER_TX (drain protection)
  // ALT resolution: skipped (Ultra-trusted, avoids RPC latency/failures)
  // ============================================================================

  /**
   * Validate a transaction before signing (defense in depth for Ultra)
   *
   * With Ultra, Jupiter constructs and executes the entire transaction.
   * We still validate as a safety net:
   * 1. Program IDs — logged as warnings if unknown (Ultra uses dynamic programs)
   * 2. System Program transfers — hard block if > MAX_SOL_PER_TX (drain protection)
   *
   * ALT resolution is skipped (would add latency and block trades if RPC lacks the ALT).
   *
   * @param transaction - The deserialized transaction to validate
   * @returns Validation result with details
   */
  private async validateTransaction(transaction: VersionedTransaction): Promise<TransactionValidationResult> {
    const result: TransactionValidationResult = {
      valid: true,
      warnings: [],
      programIds: [],
      systemTransferLamports: 0n,
    };

    try {
      // Fetch current balance for balance-aware limits
      const balance = await this.getSolBalance();
      const maxSolPerTxLamports = BigInt(Math.floor(getMaxSolPerTx(balance) * 1e9));
      
      const message = transaction.message;

      // Get all account keys (static + lookup tables if any)
      // For VersionedTransaction, we need to handle both static and dynamic keys
      const staticAccountKeys = message.staticAccountKeys;

      // With Ultra, we trust Jupiter to build the transaction. ALT resolution is
      // skipped — it added RPC latency and could block legitimate trades if our RPC
      // lacked the ALT. Program IDs in static keys are still checked (warn-only),
      // and System Program drain checks still apply to static-key instructions.
      const allAccountKeys: PublicKey[] = [...staticAccountKeys];

      if ('addressTableLookups' in message && (message as any).addressTableLookups?.length > 0) {
        const lookups = (message as any).addressTableLookups as Array<{ accountKey: PublicKey }>;
        logger.debug(`🔒 Transaction uses ${lookups.length} Address Lookup Table(s) — skipping resolution (Ultra-trusted)`);
      }

      // Check each instruction
      const compiledInstructions = message.compiledInstructions;

      for (let i = 0; i < compiledInstructions.length; i++) {
        const ix = compiledInstructions[i];
        const programIdIndex = ix.programIdIndex;

        // Get the program ID from static keys; skip ALT-resolved instructions
        let programId: string;
        if (programIdIndex < allAccountKeys.length) {
          programId = allAccountKeys[programIdIndex].toBase58();
        } else {
          // Program ID lives in an Address Lookup Table — can't resolve without
          // extra RPC calls. Since we trust Ultra, skip this instruction.
          logger.debug(`🔒 Instruction ${i} uses ALT-resolved program (index ${programIdIndex}) — skipping validation (Ultra-trusted)`);
          result.programIds.push(`ALT:${programIdIndex}`);
          continue;
        }
        
        result.programIds.push(programId);
        
        // Log unknown programs (Ultra uses dynamic program IDs per route)
        // Since Ultra constructs the entire tx, we trust Jupiter's routing
        // but still log for visibility. System Program drain check below remains a hard block.
        if (!ALLOWED_PROGRAM_IDS.has(programId)) {
          result.warnings.push(`Unknown program ID in instruction ${i}: ${programId}`);
          logger.warn(`🔒 Ultra tx uses program not in allowlist (instruction ${i}): ${programId} — allowed (Ultra-trusted)`);
        }
        
        // Special validation for System Program instructions that move lamports
        if (programId === '11111111111111111111111111111111') {
          const data = ix.data;

          if (data.length >= 4) {
            const instructionType = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);

            // Helper: read u64 little-endian from a byte slice
            const readU64 = (buf: Uint8Array, offset: number): bigint => {
              return BigInt(buf[offset]) |
                (BigInt(buf[offset + 1]) << 8n) |
                (BigInt(buf[offset + 2]) << 16n) |
                (BigInt(buf[offset + 3]) << 24n) |
                (BigInt(buf[offset + 4]) << 32n) |
                (BigInt(buf[offset + 5]) << 40n) |
                (BigInt(buf[offset + 6]) << 48n) |
                (BigInt(buf[offset + 7]) << 56n);
            };

            // Detect lamports moved and destination for all System Program
            // instruction types that transfer SOL:
            //   0 = CreateAccount       (lamports @ offset 4, dest = accounts[1])
            //   2 = Transfer            (lamports @ offset 4, dest = accounts[1])
            //   3 = CreateAccountWithSeed (lamports after variable seed, dest = accounts[1])
            //  11 = TransferWithSeed    (lamports @ offset 4, dest = accounts[1])
            let lamports: bigint | null = null;
            let destAccountIndex = 1; // destination is accounts[1] for all relevant types
            let instructionName = '';

            if (instructionType === 2 && data.length >= 12) {
              // Transfer: [4B type][8B lamports]
              lamports = readU64(data, 4);
              instructionName = 'Transfer';
            } else if (instructionType === 0 && data.length >= 12) {
              // CreateAccount: [4B type][8B lamports][8B space][32B owner]
              lamports = readU64(data, 4);
              instructionName = 'CreateAccount';
            } else if (instructionType === 11 && data.length >= 12) {
              // TransferWithSeed: [4B type][8B lamports][...seed][...owner]
              lamports = readU64(data, 4);
              instructionName = 'TransferWithSeed';
            } else if (instructionType === 3 && data.length >= 20) {
              // CreateAccountWithSeed: [4B type][32B base][4B seed_len][seed...][8B lamports][8B space][32B owner]
              // Seed length is at offset 36, seed follows, then lamports
              const seedLen = data[36] | (data[37] << 8) | (data[38] << 16) | (data[39] << 24);
              const lamportsOffset = 40 + seedLen;
              if (data.length >= lamportsOffset + 8) {
                lamports = readU64(data, lamportsOffset);
                instructionName = 'CreateAccountWithSeed';
              }
            }

            if (lamports !== null) {
              result.systemTransferLamports += lamports;

              // Resolve destination account
              const destKeyIndex = ix.accountKeyIndexes[destAccountIndex];
              const destAccount = (destKeyIndex !== undefined && destKeyIndex < allAccountKeys.length)
                ? allAccountKeys[destKeyIndex].toBase58()
                : null;

              // ----------------------------------------------------------------
              // System transfer validation
              // Ultra sends SOL to relay/executor addresses (not our WSOL ATA).
              // All System transfers are validated against MAX_SOL_PER_TX — the
              // same cap enforced in buyToken() before calling getUltraOrder().
              // This prevents drain attacks while allowing legitimate swap transfers.
              // ----------------------------------------------------------------
              if (lamports > maxSolPerTxLamports) {
                result.valid = false;
                result.error = `🚨 BLOCKED: System ${instructionName} too large in instruction ${i}: ${lamports} lamports (${Number(lamports) / 1e9} SOL) > max ${maxSolPerTxLamports} lamports (${Number(maxSolPerTxLamports) / 1e9} SOL) [balance: ${balance.toFixed(4)} SOL] [dest: ${destAccount ?? 'unknown'}]`;
                logger.error(result.error);
                return result;
              } else {
                logger.debug(`🔒 System ${instructionName} in instruction ${i}: ${lamports} lamports (${Number(lamports) / 1e9} SOL) → ${destAccount ?? 'unknown'} - within swap limit (max: ${Number(maxSolPerTxLamports) / 1e9} SOL)`);
              }
            }
          }
        }
      }
      
      // Log summary for audit trail
      const uniquePrograms = [...new Set(result.programIds)];
      logger.info(`🔒 Transaction validated: ${compiledInstructions.length} instructions, ${uniquePrograms.length} unique programs`);
      logger.debug(`   Programs: ${uniquePrograms.join(', ')}`);
      if (result.systemTransferLamports > 0n) {
        logger.debug(`   Total System transfers: ${result.systemTransferLamports} lamports (${Number(result.systemTransferLamports) / 1e9} SOL)`);
      }
      
      return result;
    } catch (error: any) {
      result.valid = false;
      result.error = `🚨 BLOCKED: Failed to validate transaction: ${error.message}`;
      logger.error(result.error);
      return result;
    }
  }

  /**
   * Simulate a transaction before signing
   * 
   * This catches errors that would fail on-chain and provides additional
   * security by showing what the transaction will do.
   * 
   * @param transaction - The unsigned transaction to simulate
   * @returns Simulation result
   */
  /**
   * Get Ultra order (combines quote + unsigned transaction in one call)
   *
   * IMPORTANT: Amount is passed as STRING to avoid BigInt → Number precision loss.
   * JavaScript Number cannot safely represent integers > 2^53.
   * Many meme tokens have supplies exceeding this limit.
   *
   * Ultra API handles slippage automatically via RTSE (Real-Time Slippage Estimator).
   * No slippageBps parameter needed.
   */
  async getUltraOrder(
    inputMint: string,
    outputMint: string,
    amount: string, // Amount in smallest unit as STRING (lamports for SOL, raw units for tokens)
  ): Promise<UltraOrderResponse | null> {
    const startedAt = Date.now();
    try {
      logger.debug(`Getting Ultra order: ${inputMint} -> ${outputMint}, amount: ${amount}`);

      const response = await axios.get(`${JUPITER_API_URL}/ultra/v1/order`, {
        params: {
          inputMint,
          outputMint,
          amount,
          taker: this.keypair.publicKey.toBase58(),
        },
        headers: getJupiterHeaders(),
        timeout: 30000,
      });

      if (!response.data) {
        logger.error(`Ultra order returned empty response for ${inputMint} -> ${outputMint}`);
        jupiterRequestTracker.logRequest('ultra_order', {
          statusCode: response.status,
          success: false,
          durationMs: Date.now() - startedAt,
          errorType: 'empty_response',
        });
        return null;
      }

      // Ultra returns 200 with error field on failures (e.g. "Insufficient funds")
      if (response.data.error || response.data.errorCode) {
        const errorMsg = response.data.error || response.data.errorMessage || `errorCode=${response.data.errorCode}`;
        logger.error(`Ultra order error for ${inputMint.slice(0, 8)}... -> ${outputMint.slice(0, 8)}...: ${errorMsg}`);

        jupiterRequestTracker.logRequest('ultra_order', {
          statusCode: response.status,
          success: false,
          durationMs: Date.now() - startedAt,
          errorType: response.data.errorCode || 'body_error',
        });

        // Check for no-route errors in body (PERMANENT ERROR)
        if (errorMsg.includes('no route') || errorMsg.includes('Could not find any route') ||
            response.data.errorCode === 'COULD_NOT_FIND_ANY_ROUTE') {
          throw new Error('NO_ROUTE_FOUND');
        }

        return null;
      }

      if (!response.data.transaction || !response.data.requestId) {
        logger.error(`Ultra order missing required fields:`, {
          hasTransaction: !!response.data.transaction,
          hasRequestId: !!response.data.requestId,
          keys: Object.keys(response.data),
        });
        jupiterRequestTracker.logRequest('ultra_order', {
          statusCode: response.status,
          success: false,
          durationMs: Date.now() - startedAt,
          errorType: 'missing_fields',
        });
        return null;
      }

      const order: UltraOrderResponse = response.data;
      logger.debug(`Ultra order received: requestId=${order.requestId}, swapType=${order.swapType}, slippage=${order.slippageBps}bps`);
      if (order.outAmount) {
        logger.debug(`  Quote: ${order.outAmount} output for ${order.inAmount} input`);
      }

      jupiterRequestTracker.logRequest('ultra_order', {
        statusCode: response.status,
        success: true,
        durationMs: Date.now() - startedAt,
      });

      return order;
    } catch (error: any) {
      // Re-throw NO_ROUTE_FOUND without double-logging to tracker
      // (already logged above as body_error when it came from response.data)
      const isNoRouteRethrow = error?.message === 'NO_ROUTE_FOUND';
      if (!isNoRouteRethrow) {
        const status: number | undefined = error?.response?.status;
        const isTimeout = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT';
        jupiterRequestTracker.logRequest('ultra_order', {
          statusCode: status,
          success: false,
          durationMs: Date.now() - startedAt,
          errorType: isTimeout
            ? 'timeout'
            : status != null
            ? `http_${status}`
            : (error?.code || 'network'),
        });
      }
      const errorDetails = {
        inputMint,
        outputMint,
        amount,
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
        code: error.code,
      };

      // Check for "no route found" error (PERMANENT ERROR - don't retry)
      const isNoRouteError = error.response?.status === 400 &&
        (error.response?.data?.errorCode === 'COULD_NOT_FIND_ANY_ROUTE' ||
         error.response?.data?.error?.includes('Could not find any route') ||
         error.response?.data?.error?.includes('no route'));

      if (isNoRouteError) {
        logger.error(`Ultra: No route found for ${inputMint.slice(0, 8)}... -> ${outputMint.slice(0, 8)}... (no liquidity)`);
        throw new Error('NO_ROUTE_FOUND');
      }

      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        logger.error(`Ultra order request timed out for ${inputMint.slice(0, 8)}... -> ${outputMint.slice(0, 8)}... (amount: ${amount}, code: ${error.code})`);
      } else if (error.response?.status === 401) {
        logger.error(`Ultra order unauthorized for ${inputMint.slice(0, 8)}... -> ${outputMint.slice(0, 8)}... - check JUPITER_API_KEY (status: 401)`);
      } else {
        const status = error.response?.status || 'N/A';
        const apiError = error.response?.data?.error || error.response?.data?.errorCode || error.message || 'unknown';
        logger.error(`Failed to get Ultra order for ${inputMint.slice(0, 8)}... -> ${outputMint.slice(0, 8)}... (status: ${status}, error: ${apiError}, amount: ${amount})`);
      }

      return null;
    }
  }

  /**
   * Execute Ultra order: validate → sign → submit to Ultra /execute endpoint.
   * Ultra handles transaction landing (Jupiter Beam, MEV-protected) and confirmation.
   */
  async executeUltraOrder(order: UltraOrderResponse): Promise<SwapResult> {
    const inputMint = order.inputMint || 'unknown';
    const outputMint = order.outputMint || 'unknown';

    try {
      // Deserialize unsigned transaction from Ultra
      let transaction: VersionedTransaction;
      try {
        const transactionBuf = Buffer.from(order.transaction, 'base64');
        transaction = VersionedTransaction.deserialize(transactionBuf);
      } catch (deserializeError: any) {
        logger.error(`Failed to deserialize Ultra transaction:`, {
          requestId: order.requestId,
          error: deserializeError.message,
        });
        return {
          success: false,
          error: `Transaction deserialization failed: ${deserializeError.message}`,
        };
      }

      // ========================================================================
      // SECURITY: Validate transaction before signing (defense in depth)
      // Even though Ultra is trusted, we validate what we sign
      // ========================================================================
      if (ENABLE_TX_VALIDATION) {
        logger.debug(`🔒 Validating Ultra transaction instructions...`);
        const validation = await this.validateTransaction(transaction);

        if (!validation.valid) {
          logger.error(`🚨 ULTRA TRANSACTION BLOCKED - VALIDATION FAILED`);
          logger.error(`   RequestId: ${order.requestId}`);
          logger.error(`   Input: ${inputMint}`);
          logger.error(`   Output: ${outputMint}`);
          logger.error(`   Reason: ${validation.error}`);
          logger.error(`   Programs found: ${validation.programIds.join(', ')}`);
          logger.error(`   ⚠️  This transaction was NOT signed or sent`);
          return {
            success: false,
            error: validation.error || 'Ultra transaction validation failed',
          };
        }

        if (validation.warnings.length > 0) {
          logger.warn(`🔒 Ultra transaction validation warnings: ${validation.warnings.join('; ')}`);
        }
      } else {
        logger.warn(`⚠️ SECURITY WARNING: Transaction validation is DISABLED (ENABLE_TX_VALIDATION=false)`);
      }

      // Sign transaction
      try {
        logger.debug(`🔒 Signing Ultra transaction (requestId: ${order.requestId})...`);
        transaction.sign([this.keypair]);
        logger.debug(`Transaction signed successfully`);
      } catch (signError: any) {
        logger.error(`Failed to sign Ultra transaction:`, {
          requestId: order.requestId,
          error: signError.message,
        });
        return {
          success: false,
          error: `Transaction signing failed: ${signError.message}`,
        };
      }

      // Submit to Ultra /execute endpoint
      // Ultra handles broadcasting, landing (Jupiter Beam), and confirmation
      const signedTransactionBase64 = Buffer.from(transaction.serialize()).toString('base64');

      logger.debug(`Submitting to Ultra /execute (requestId: ${order.requestId})...`);
      let executeResponse: UltraExecuteResponse;
      const executeStartedAt = Date.now();
      try {
        const response = await axios.post(
          `${JUPITER_API_URL}/ultra/v1/execute`,
          JSON.stringify({
            signedTransaction: signedTransactionBase64,
            requestId: order.requestId,
          }),
          {
            headers: getJupiterHeaders(),
            timeout: 60000, // 60s timeout - Ultra handles landing + confirmation internally
          }
        );

        executeResponse = response.data;
        jupiterRequestTracker.logRequest('ultra_execute', {
          statusCode: response.status,
          success: true,
          durationMs: Date.now() - executeStartedAt,
        });
      } catch (executeError: any) {
        const errorMessage = executeError.response?.data?.error || executeError.message;
        const status: number | undefined = executeError?.response?.status;
        const isTimeout = executeError?.code === 'ECONNABORTED' || executeError?.code === 'ETIMEDOUT';
        jupiterRequestTracker.logRequest('ultra_execute', {
          statusCode: status,
          success: false,
          durationMs: Date.now() - executeStartedAt,
          errorType: isTimeout
            ? 'timeout'
            : status != null
            ? `http_${status}`
            : (executeError?.code || 'network'),
        });
        logger.error(`Ultra /execute failed:`, {
          requestId: order.requestId,
          error: errorMessage,
          status: executeError.response?.status,
          data: executeError.response?.data,
        });
        return {
          success: false,
          error: `Ultra execute failed: ${errorMessage}`,
        };
      }

      // Check execution status
      if (executeResponse.status !== 'Success') {
        const errorMsg = executeResponse.error || executeResponse.status || 'Unknown Ultra execution error';
        logger.error(`Ultra execution failed:`, {
          requestId: order.requestId,
          status: executeResponse.status,
          signature: executeResponse.signature,
          error: errorMsg,
        });
        return {
          success: false,
          error: `Ultra execution failed: ${errorMsg}`,
        };
      }

      const signature = executeResponse.signature;
      logger.success(`Ultra swap executed successfully: ${signature}`);
      logger.info(`  Input: ${order.inAmount || '?'} (${inputMint})`);
      logger.info(`  Output: ${order.outAmount || '?'} (${outputMint})`);

      // Get actual amounts from on-chain transaction (not from order quote)
      // This is CRITICAL for accurate position tracking with multiple concurrent positions
      const actualAmounts = await this.getActualAmountsFromTx(
        signature,
        inputMint,
        outputMint,
        this.keypair.publicKey.toBase58()
      );

      if (actualAmounts.success) {
        logger.debug(`  Actual amounts from chain: in=${actualAmounts.actualAmountIn}, out=${actualAmounts.actualAmountOut}`);
        if (actualAmounts.entryAtaRentPaid && actualAmounts.entryAtaRentPaid > 0) {
          logger.debug(`  Entry ATA rent paid: ${actualAmounts.entryAtaRentPaid} lamports (${actualAmounts.entryAtaRentPaid / 1e9} SOL)`);
        }
        return {
          success: true,
          txHash: signature,
          actualAmountIn: actualAmounts.actualAmountIn,
          actualAmountOut: actualAmounts.actualAmountOut,
          entryAtaRentPaid: actualAmounts.entryAtaRentPaid,
        };
      } else {
        // Fall back to order amounts if we can't parse on-chain
        logger.warn(`  Failed to parse actual amounts from tx: ${actualAmounts.error} - falling back to order quote`);
        return {
          success: true,
          txHash: signature,
          actualAmountIn: order.inAmount,
          actualAmountOut: order.outAmount,
        };
      }
    } catch (error: any) {
      logger.error(`Ultra order execution failed with exception:`, {
        requestId: order.requestId,
        inputMint,
        outputMint,
        error: error.message,
        stack: error.stack,
      });
      return {
        success: false,
        error: error.message || 'Unknown error during Ultra execution',
      };
    }
  }

  /**
   * Buy token (SOL -> Token) via Jupiter Ultra API
   * Ultra handles slippage automatically via RTSE (Real-Time Slippage Estimator).
   * No manual slippage retries needed.
   *
   * @param onAttempt Optional callback called for each attempt (for DB logging/analytics)
   */
  async buyToken(
    tokenMint: string,
    solAmount: number, // Amount in SOL (will be converted to lamports)
    expectedPriceUsd?: number,  // Codex decision price in USD/token (optional)
    solPriceUsd?: number,        // SOL price in USD (optional, for Codex impact calc)
    onAttempt?: (attempt: number, slippageBps: number, result: SwapResult) => void | Promise<void>
  ): Promise<SwapResult> {
    try {
      logger.info(`Initiating BUY swap (Ultra): ${solAmount.toFixed(4)} SOL -> Token ${tokenMint.substring(0, 8)}...`);

      if (solAmount <= 0) {
        logger.error(`Invalid SOL amount for buy: ${solAmount}`);
        return {
          success: false,
          error: `Invalid SOL amount: ${solAmount}`,
        };
      }

      // ========================================================================
      // SECURITY: Maximum SOL per transaction check (balance-aware)
      // Prevents large drain attacks even if other checks fail
      // ========================================================================
      const balance = await this.getSolBalance();
      const maxSolPerTx = getMaxSolPerTx(balance);

      if (solAmount > maxSolPerTx) {
        logger.error(`🚨 CIRCUIT BREAKER: SOL amount (${solAmount}) exceeds max per transaction (${maxSolPerTx.toFixed(4)} SOL) [balance: ${balance.toFixed(4)} SOL]`);
        logger.error(`   Current limit: ${MAX_SOL_PER_TX_CONFIG} (${maxSolPerTx.toFixed(4)} SOL based on balance)`);
        logger.error(`   Adjust MAX_SOL_PER_TX env var if this limit is too restrictive`);
        return {
          success: false,
          error: `SOL amount ${solAmount} exceeds max ${maxSolPerTx.toFixed(4)} SOL per transaction (balance: ${balance.toFixed(4)} SOL)`,
        };
      }

      const solLamports = Math.floor(solAmount * 1e9);
      if (solLamports <= 0) {
        logger.error(`Invalid lamports amount: ${solLamports} (from ${solAmount} SOL)`);
        return {
          success: false,
          error: `Invalid lamports amount: ${solLamports}`,
        };
      }

      const solLamportsStr = solLamports.toString();

      // Get Ultra order (quote + unsigned transaction in one call)
      logger.debug(`Getting Ultra order for ${solLamportsStr} lamports (${solAmount} SOL)`);
      let order: UltraOrderResponse | null;
      try {
        order = await this.getUltraOrder(SOL_MINT, tokenMint, solLamportsStr);
      } catch (error: any) {
        if (error.message === 'NO_ROUTE_FOUND') {
          logger.error(`Cannot buy ${tokenMint}: No liquidity/route available on Jupiter`);
          return {
            success: false,
            error: 'No trading route found - token has no liquidity',
          };
        }
        throw error;
      }

      if (!order) {
        logger.error(`Failed to get Ultra order for BUY: ${tokenMint.substring(0, 8)}..., ${solAmount} SOL`);
        return {
          success: false,
          error: 'Failed to get Ultra order from Jupiter',
        };
      }

      // Optional: Enforce maximum Codex-based entry impact vs decision price
      if (expectedPriceUsd && expectedPriceUsd > 0 && solPriceUsd && solPriceUsd > 0 && order.outAmount) {
        try {
          const decimals = await this.getTokenDecimals(tokenMint).catch(() => 6);
          const tokensOut = parseFloat(order.outAmount) / Math.pow(10, decimals);
          const usdIn = solAmount * solPriceUsd;
          if (tokensOut > 0) {
            const impliedPriceUsd = usdIn / tokensOut;
            const codexImpactPct = ((impliedPriceUsd - expectedPriceUsd) / expectedPriceUsd) * 100;

            if (MAX_CODEX_PRICE_IMPACT_PCT > 0 && codexImpactPct > MAX_CODEX_PRICE_IMPACT_PCT) {
              const errorMsg = `Codex price impact too high: ${codexImpactPct.toFixed(2)}% (max ${MAX_CODEX_PRICE_IMPACT_PCT}%)`;
              logger.warn(
                `Codex price impact too high for BUY: implied=$${impliedPriceUsd.toFixed(10)}, codex=$${expectedPriceUsd.toFixed(10)} (${codexImpactPct.toFixed(2)}% > max ${MAX_CODEX_PRICE_IMPACT_PCT}%) for ${tokenMint}`,
              );

              const codexImpactResult: SwapResult = {
                success: false,
                error: errorMsg,
                errorType: 'codex_price_impact',
                quoteInAmount: order.inAmount,
                quoteOutAmount: order.outAmount,
                quotePriceImpactPct: order.priceImpactPct,
              };

              if (onAttempt) {
                await onAttempt(0, order.slippageBps, codexImpactResult);
              }

              return codexImpactResult;
            }
          }
        } catch (error: any) {
          logger.warn(`Failed to compute Codex price impact for BUY ${tokenMint}: ${error?.message || error}`);
        }
      }

      logger.debug(`Ultra order received: ${order.outAmount || '?'} tokens for ${order.inAmount || '?'} lamports (RTSE slippage: ${order.slippageBps}bps)`);

      // Execute via Ultra
      const swapResult = await this.executeUltraOrder(order);

      // Attach quote metadata for downstream logging/DB
      const resultWithQuote: SwapResult = {
        ...swapResult,
        quoteInAmount: order.inAmount,
        quoteOutAmount: order.outAmount,
        quotePriceImpactPct: order.priceImpactPct,
      };

      if (onAttempt) {
        await onAttempt(0, order.slippageBps, resultWithQuote);
      }

      if (swapResult.success) {
        return resultWithQuote;
      }

      // Check for PumpFun migration error — retry once after waiting
      const errorStr = swapResult.error || '';
      if (this.isPumpFunMigrationError(errorStr)) {
        logger.info(`[PumpFun Migration] Detected migration error during BUY for ${tokenMint.substring(0, 8)}...`);
        logger.info(`[PumpFun Migration] Will wait for migration and retry via Ultra`);

        const migrationOrder = await this.waitForPumpFunMigration(tokenMint, solLamportsStr);

        if (migrationOrder) {
          // Re-validate Codex price impact (price may have moved during wait)
          if (expectedPriceUsd && expectedPriceUsd > 0 && solPriceUsd && solPriceUsd > 0 && migrationOrder.outAmount) {
            try {
              const decimals = await this.getTokenDecimals(tokenMint).catch(() => 6);
              const tokensOut = parseFloat(migrationOrder.outAmount) / Math.pow(10, decimals);
              const usdIn = solAmount * solPriceUsd;
              if (tokensOut > 0) {
                const impliedPriceUsd = usdIn / tokensOut;
                const codexImpactPct = ((impliedPriceUsd - expectedPriceUsd) / expectedPriceUsd) * 100;

                if (MAX_CODEX_PRICE_IMPACT_PCT > 0 && codexImpactPct > MAX_CODEX_PRICE_IMPACT_PCT) {
                  logger.warn(`[PumpFun Migration] Codex price impact too high after migration: ${codexImpactPct.toFixed(2)}% (max ${MAX_CODEX_PRICE_IMPACT_PCT}%)`);
                  return {
                    success: false,
                    error: `Codex price impact too high after migration: ${codexImpactPct.toFixed(2)}%`,
                    errorType: 'codex_price_impact' as const,
                    quoteInAmount: migrationOrder.inAmount,
                    quoteOutAmount: migrationOrder.outAmount,
                    quotePriceImpactPct: migrationOrder.priceImpactPct,
                  };
                }
              }
            } catch (err: any) {
              logger.warn(`[PumpFun Migration] Failed Codex impact check: ${err?.message}`);
            }
          }

          // Execute through PumpSwap AMM via Ultra
          logger.info(`[PumpFun Migration] Executing buy through PumpSwap AMM pool (Ultra)...`);
          const migrationSwapResult = await this.executeUltraOrder(migrationOrder);

          const migrationResultWithQuote: SwapResult = {
            ...migrationSwapResult,
            quoteInAmount: migrationOrder.inAmount,
            quoteOutAmount: migrationOrder.outAmount,
            quotePriceImpactPct: migrationOrder.priceImpactPct,
          };

          if (onAttempt) {
            await onAttempt(1, migrationOrder.slippageBps, migrationResultWithQuote);
          }

          if (migrationSwapResult.success) {
            logger.info(`[PumpFun Migration] Buy succeeded through PumpSwap AMM after migration wait`);
          } else {
            logger.error(`[PumpFun Migration] Buy failed after migration: ${migrationSwapResult.error}`);
          }

          return migrationResultWithQuote;
        } else {
          logger.warn(`[PumpFun Migration] Migration wait timed out - giving up`);
          return {
            success: false,
            error: `PumpFun migration timed out after ${PUMPFUN_MIGRATION_TIMEOUT_MS / 1000}s - ${errorStr}`,
          };
        }
      }

      // Non-migration error — retry up to 2 times with fresh Ultra orders
      // RTSE recalculates slippage on each order, so a fresh quote often succeeds
      if (this.isSlippageError(errorStr)) {
        const maxSlippageRetries = 2;
        for (let retryAttempt = 1; retryAttempt <= maxSlippageRetries; retryAttempt++) {
          const retryDelayMs = retryAttempt === 1 ? 500 : 1000;
          logger.warn(`Ultra BUY failed (slippage/stale), retry ${retryAttempt}/${maxSlippageRetries} with fresh order in ${retryDelayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));

          try {
            const retryOrder = await this.getUltraOrder(SOL_MINT, tokenMint, solLamportsStr);
            if (retryOrder) {
              logger.info(`Ultra BUY retry ${retryAttempt}: fresh order (RTSE slippage: ${retryOrder.slippageBps}bps)`);
              const retryResult = await this.executeUltraOrder(retryOrder);

              const retryResultWithQuote: SwapResult = {
                ...retryResult,
                quoteInAmount: retryOrder.inAmount,
                quoteOutAmount: retryOrder.outAmount,
                quotePriceImpactPct: retryOrder.priceImpactPct,
              };

              if (onAttempt) {
                await onAttempt(retryAttempt, retryOrder.slippageBps, retryResultWithQuote);
              }

              if (retryResult.success) {
                logger.success(`Ultra BUY retry ${retryAttempt} succeeded for ${tokenMint.substring(0, 8)}...`);
                return retryResultWithQuote;
              }

              // If this retry also failed with slippage, continue loop; otherwise break
              if (!this.isSlippageError(retryResult.error || '')) {
                logger.warn(`Ultra BUY retry ${retryAttempt} failed (non-slippage): ${retryResult.error}`);
                return retryResultWithQuote;
              }
              logger.warn(`Ultra BUY retry ${retryAttempt} failed (slippage again): ${retryResult.error}`);
            }
          } catch (retryErr: any) {
            logger.warn(`Ultra BUY retry ${retryAttempt} failed to get fresh order: ${retryErr?.message}`);
            break;
          }
        }
      }

      return resultWithQuote;
    } catch (error: any) {
      logger.error(`BUY token failed with exception:`, {
        tokenMint,
        solAmount,
        error: error.message,
        stack: error.stack,
      });
      return {
        success: false,
        error: error.message || 'Unknown error during buy',
      };
    }
  }

  /**
   * Decode Solana transaction error into human-readable format
   * Handles InstructionError, Custom errors, and other Solana error types
   */
  private decodeSolanaError(error: any): {
    errorType: string;
    errorCode?: number;
    instructionIndex?: number;
    message: string;
    rawError: any;
  } {
    if (!error) {
      return {
        errorType: 'Unknown',
        message: 'No error details available',
        rawError: error,
      };
    }

    // Convert error to string for pattern matching
    const errorStr = typeof error === 'string' ? error : JSON.stringify(error);
    
    // Common Solana error codes and their meanings
    const errorCodeMap: Record<number, string> = {
      6000: 'Insufficient input amount',
      6001: 'Slippage tolerance exceeded (Jupiter/Orca) - price moved too much during execution',
      6002: 'Invalid route',
      6003: 'Invalid output mint',
      6004: 'Invalid input mint',
      6005: 'Pump.fun BondingCurveComplete - migration to PumpSwap AMM in progress',
      6023: 'Pump.fun NotEnoughTokensToSell - bonding curve reserves exhausted, migration imminent',
      6024: 'Pump.fun bonding curve error - insufficient SOL reserves or arithmetic overflow',
      6026: 'Jupiter swap validation failed - quote may be stale, route invalid, or output amount below minimum (try fresh quote)',
    };

    try {
      // Try to parse as JSON first
      let parsed: any;
      if (typeof error === 'string') {
        try {
          parsed = JSON.parse(error);
        } catch {
          parsed = error;
        }
      } else {
        parsed = error;
      }

      // Handle InstructionError format: [instructionIndex, error]
      if (Array.isArray(parsed) && parsed.length === 2) {
        const [instructionIndex, instructionError] = parsed;
        
        // Check for Custom error code
        if (instructionError && typeof instructionError === 'object' && 'Custom' in instructionError) {
          const customCode = instructionError.Custom;
          return {
            errorType: 'InstructionError',
            errorCode: customCode,
            instructionIndex,
            message: errorCodeMap[customCode] || `Custom program error: ${customCode}`,
            rawError: error,
          };
        }
        
        // Check for other error types
        if (typeof instructionError === 'string') {
          return {
            errorType: 'InstructionError',
            instructionIndex,
            message: instructionError,
            rawError: error,
          };
        }
      }

      // Handle direct Custom error: {"Custom": 6001}
      if (parsed && typeof parsed === 'object' && 'Custom' in parsed) {
        const customCode = parsed.Custom;
        return {
          errorType: 'Custom',
          errorCode: customCode,
          message: errorCodeMap[customCode] || `Custom program error: ${customCode}`,
          rawError: error,
        };
      }

      // Handle InstructionError object format: {"InstructionError": [index, error]}
      if (parsed && typeof parsed === 'object' && 'InstructionError' in parsed) {
        const instructionError = parsed.InstructionError;
        if (Array.isArray(instructionError) && instructionError.length === 2) {
          const [instructionIndex, err] = instructionError;
          if (err && typeof err === 'object' && 'Custom' in err) {
            const customCode = err.Custom;
            return {
              errorType: 'InstructionError',
              errorCode: customCode,
              instructionIndex,
              message: errorCodeMap[customCode] || `Custom program error: ${customCode}`,
              rawError: error,
            };
          }
        }
      }

      // Handle other common Solana error types
      const commonErrors = [
        'InsufficientFunds',
        'InvalidAccountData',
        'AccountNotFound',
        'InsufficientFundsForFee',
        'InvalidInstruction',
        'IncorrectProgramId',
        'MissingRequiredSignature',
        'AccountAlreadyExists',
        'UninitializedAccount',
        'NotEnoughAccountKeys',
        'InvalidAccountData',
        'BorshIoError',
        'AccountDataSizeChanged',
        'AccountNotExecutable',
        'AccountBorrowFailed',
        'AccountBorrowOutstanding',
        'DuplicateInstruction',
        'ExecutableModified',
        'ExecutableDataModified',
        'ExecutableLamportChange',
        'ExecutableAccountNotRentExempt',
        'UnsupportedProgramId',
        'CallDepth',
        'MissingAccount',
        'ReentrancyNotAllowed',
        'MaxSeedLengthExceeded',
        'InvalidSeeds',
        'InvalidRealloc',
        'ComputationalBudgetExceeded',
      ];

      for (const errType of commonErrors) {
        if (errorStr.includes(errType)) {
          return {
            errorType: errType,
            message: `${errType}: ${this.getErrorDescription(errType)}`,
            rawError: error,
          };
        }
      }

      // Fallback: return string representation
      return {
        errorType: 'Unknown',
        message: errorStr,
        rawError: error,
      };
    } catch (e) {
      // If parsing fails, return string representation
      return {
        errorType: 'ParseError',
        message: `Failed to parse error: ${errorStr}`,
        rawError: error,
      };
    }
  }

  /**
   * Get human-readable description for Solana error types
   */
  private getErrorDescription(errorType: string): string {
    const descriptions: Record<string, string> = {
      InsufficientFunds: 'Account does not have enough funds to complete the transaction',
      InvalidAccountData: 'Account data is invalid or corrupted',
      AccountNotFound: 'Required account was not found',
      InsufficientFundsForFee: 'Account does not have enough funds to pay transaction fees',
      InvalidInstruction: 'Instruction data is invalid',
      IncorrectProgramId: 'Program ID does not match expected program',
      MissingRequiredSignature: 'Required signature is missing',
      AccountAlreadyExists: 'Account already exists (should not exist)',
      UninitializedAccount: 'Account is not initialized',
      NotEnoughAccountKeys: 'Not enough account keys provided',
      BorshIoError: 'Error deserializing account data',
      AccountDataSizeChanged: 'Account data size changed unexpectedly',
      AccountNotExecutable: 'Account is not executable',
      AccountBorrowFailed: 'Failed to borrow account data',
      AccountBorrowOutstanding: 'Account borrow is still outstanding',
      DuplicateInstruction: 'Duplicate instruction in transaction',
      ExecutableModified: 'Executable account was modified',
      ExecutableDataModified: 'Executable account data was modified',
      ExecutableLamportChange: 'Executable account lamports changed',
      ExecutableAccountNotRentExempt: 'Executable account is not rent exempt',
      UnsupportedProgramId: 'Program ID is not supported',
      CallDepth: 'Maximum call depth exceeded',
      MissingAccount: 'Required account is missing',
      ReentrancyNotAllowed: 'Reentrancy is not allowed',
      MaxSeedLengthExceeded: 'Maximum seed length exceeded',
      InvalidSeeds: 'Invalid seeds provided',
      InvalidRealloc: 'Invalid reallocation',
      ComputationalBudgetExceeded: 'Transaction exceeded computational budget (out of compute units)',
    };
    return descriptions[errorType] || 'Unknown error type';
  }

  /**
   * Check if error indicates a slippage or stale-quote failure that is retryable.
   * Covers Jupiter, Orca, Raydium, Pump.fun, and Ultra RTSE errors.
   */
  private isSlippageError(errorMsg: string): boolean {
    if (!errorMsg) return false;

    // Check for specific custom program error codes in various formats
    for (const code of ['6001', '6026', '6024', '3005', '6036']) {
      if (errorMsg.includes(code)) {
        if (errorMsg.includes(`"Custom":${code}`) ||
            errorMsg.includes(`"custom":${code}`) ||
            errorMsg.includes(`custom program error: ${code}`) ||
            errorMsg.includes(`custom program error:${code}`)) {
          return true;
        }
        try {
          const re = new RegExp(`\\{[^}]*"Custom"\\s*:\\s*${code}[^}]*\\}`, 'i');
          if (re.test(errorMsg)) return true;
        } catch { /* continue */ }
      }
    }

    const slippagePatterns = [
      'slippage',
      'price moved',
      'minimum output',
      'MinimumOutputAmountNotReached',
      'InsufficientOutputAmount',
      'ReturnAmountIsNotEnough',
      'exceeds desired slippage',
      '0xff5f293c',   // Solana slippage error code
      '0x5c0dee5d',   // Insufficient output amount
      '0x064a4ec6',   // ReturnAmountIsNotEnough
      'stale',
    ];

    const lowerMsg = errorMsg.toLowerCase();
    return slippagePatterns.some(pattern => lowerMsg.includes(pattern.toLowerCase()));
  }

  /**
   * Check if error indicates a PumpFun bonding curve migration in progress.
   * Error 6023 = NotEnoughTokensToSell (reserves exhausted, migration starting)
   * Error 6005 = BondingCurveComplete (curve complete, migration imminent)
   */
  private isPumpFunMigrationError(errorMsg: string): boolean {
    if (!errorMsg) return false;

    for (const code of ['6023', '6005']) {
      if (errorMsg.includes(code)) {
        if (errorMsg.includes(`"Custom":${code}`) ||
            errorMsg.includes(`"custom":${code}`) ||
            errorMsg.includes(`Custom program error: ${code}`) ||
            errorMsg.includes(`custom program error: ${code}`) ||
            errorMsg.includes(`custom program error:${code}`)) {
          return true;
        }
        try {
          const re = new RegExp(`\\{[^}]*"Custom"\\s*:\\s*${code}[^}]*\\}`, 'i');
          if (re.test(errorMsg)) return true;
        } catch { /* fall through */ }
      }
    }

    if (errorMsg.includes('NotEnoughTokensToSell') || errorMsg.includes('BondingCurveComplete')) {
      return true;
    }

    return false;
  }

  /**
   * Derive the PumpFun bonding curve PDA for a given token mint.
   */
  private derivePumpFunBondingCurvePDA(tokenMint: string): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), new PublicKey(tokenMint).toBuffer()],
      PUMPFUN_PROGRAM_ID,
    );
    return pda;
  }

  /**
   * Wait for a PumpFun token migration to complete, then return a fresh Ultra order.
   *
   * Phase 1: Poll bonding curve account for `complete` flag at offset 0x30
   * Phase 2: Poll Ultra for a valid order (proves PumpSwap pool exists)
   */
  private async waitForPumpFunMigration(
    tokenMint: string,
    solLamportsStr: string,
  ): Promise<UltraOrderResponse | null> {
    const startTime = Date.now();
    const bondingCurvePda = this.derivePumpFunBondingCurvePDA(tokenMint);

    logger.info(`[PumpFun Migration] Waiting for migration: ${tokenMint.substring(0, 8)}...`);
    logger.info(`[PumpFun Migration] Bonding curve PDA: ${bondingCurvePda.toBase58()}`);
    logger.info(`[PumpFun Migration] Timeout: ${PUMPFUN_MIGRATION_TIMEOUT_MS / 1000}s`);

    // Phase 1: Poll bonding curve account for `complete` flag
    let migrationDetected = false;

    while (Date.now() - startTime < PUMPFUN_MIGRATION_TIMEOUT_MS) {
      try {
        const accountInfo = await this.connection.getAccountInfo(bondingCurvePda);

        if (!accountInfo || !accountInfo.data) {
          logger.info(`[PumpFun Migration] Bonding curve account not found - migration may have already completed`);
          migrationDetected = true;
          break;
        }

        if (accountInfo.data.length > 0x30) {
          const completeFlag = accountInfo.data[0x30];
          const elapsedMs = Date.now() - startTime;

          if (completeFlag === 1) {
            logger.info(`[PumpFun Migration] Bonding curve marked complete after ${elapsedMs}ms`);
            migrationDetected = true;
            break;
          } else {
            logger.debug(`[PumpFun Migration] Not yet complete (flag=${completeFlag}), elapsed=${elapsedMs}ms`);
          }
        } else {
          logger.warn(`[PumpFun Migration] Account data too short: ${accountInfo.data.length} bytes`);
        }
      } catch (error: any) {
        logger.warn(`[PumpFun Migration] Error polling bonding curve: ${error.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, PUMPFUN_MIGRATION_POLL_INTERVAL_MS));
    }

    if (!migrationDetected) {
      logger.warn(`[PumpFun Migration] Timed out waiting for bonding curve completion after ${Date.now() - startTime}ms`);
      return null;
    }

    // Phase 2: Poll Ultra for a valid order (proves AMM pool exists)
    logger.info(`[PumpFun Migration] Migration detected, waiting for Jupiter to discover PumpSwap pool...`);

    while (Date.now() - startTime < PUMPFUN_MIGRATION_TIMEOUT_MS) {
      try {
        const order = await this.getUltraOrder(SOL_MINT, tokenMint, solLamportsStr);

        if (order) {
          const elapsed = Date.now() - startTime;
          logger.info(`[PumpFun Migration] Ultra order available after ${elapsed}ms`);
          logger.info(`[PumpFun Migration] Order: ${order.outAmount || '?'} tokens for ${order.inAmount || '?'} lamports`);
          return order;
        }

        logger.debug(`[PumpFun Migration] No order yet from Ultra, retrying...`);
      } catch (error: any) {
        if (error.message === 'NO_ROUTE_FOUND') {
          logger.debug(`[PumpFun Migration] Ultra: no route yet (${Date.now() - startTime}ms elapsed)`);
        } else {
          logger.warn(`[PumpFun Migration] Error getting Ultra order: ${error.message}`);
        }
      }

      await new Promise(resolve => setTimeout(resolve, PUMPFUN_MIGRATION_QUOTE_POLL_MS));
    }

    logger.warn(`[PumpFun Migration] Timed out waiting for Ultra order after ${Date.now() - startTime}ms`);
    return null;
  }

  /**
   * Sell token (Token -> SOL) via Jupiter Ultra API
   * Ultra handles slippage automatically via RTSE.
   * Partial exit ladder still used for thin liquidity (100% -> 75% -> 50% -> 25%).
   *
   * @param tokenAmount Optional amount in token units. If not provided, sells ALL tokens (100% exact)
   * @param closeAccountAfterSell If true, closes the ATA after selling to recover rent (~0.00203928 SOL)
   * @param enablePartialExitLadder If true, tries partial exits on failure (default: true for microcaps)
   * @param onAttempt Optional callback called for each attempt (for DB logging/analytics)
   */
  async sellToken(
    tokenMint: string,
    tokenAmount?: number,
    closeAccountAfterSell: boolean = true,
    enablePartialExitLadder: boolean = true,
    onAttempt?: (attempt: number, slippageBps: number, result: SwapResult) => void | Promise<void>
  ): Promise<SwapResult> {
    try {
      // Get RAW token amount (authoritative - exact on-chain balance)
      let rawAmount: bigint;
      let decimals: number;

      try {
        const tokenInfo = await this.getRawTokenAmount(tokenMint);
        rawAmount = tokenInfo.rawAmount;
        decimals = tokenInfo.decimals;
      } catch (error: any) {
        const errorMsg = error.message || 'Unknown error';
        logger.error(`Cannot sell ${tokenMint.substring(0, 8)}... - ATA does not exist`);
        logger.error(`   Error: ${errorMsg}`);
        logger.error(`   This usually indicates the buy transaction failed or ATA was never created`);
        return {
          success: false,
          error: `ATA does not exist - buy transaction may have failed or ATA was never created: ${errorMsg}`,
        };
      }

      if (rawAmount === 0n) {
        logger.warn(`No tokens to sell for ${tokenMint}`);
        return { success: false, error: 'No tokens to sell' };
      }

      // If tokenAmount provided, use it; otherwise sell 100%
      let amountToSell: bigint;
      if (tokenAmount !== undefined && tokenAmount > 0) {
        const userAmountRaw = uiToRaw(tokenAmount.toString(), decimals);
        amountToSell = userAmountRaw > rawAmount ? rawAmount : userAmountRaw;
        logger.info(`🔮 Initiating SELL swap (Ultra): ${tokenAmount.toExponential(4)} tokens (${tokenMint.substring(0, 8)}...) -> SOL`);
      } else {
        amountToSell = rawAmount;
        const uiAmount = rawToUi(rawAmount, decimals);
        logger.info(`🔮 Initiating SELL swap (Ultra): ALL tokens (${uiAmount} tokens, ${tokenMint.substring(0, 8)}...) -> SOL`);
      }

      const tokenAmountStr = amountToSell.toString();

      if (amountToSell <= 0n) {
        logger.error(`Invalid smallest unit amount: ${tokenAmountStr}`);
        return {
          success: false,
          error: `Invalid token amount in smallest units: ${tokenAmountStr}`,
        };
      }

      if (exceedsSolanaU64(amountToSell)) {
        logger.error(`Token amount ${tokenAmountStr} exceeds Solana u64 max ${SOLANA_U64_MAX}`);
        return {
          success: false,
          error: `Token amount too large (exceeds u64 max): ${tokenAmountStr}.`,
        };
      }

      if (!isSafeForNumber(amountToSell)) {
        logger.warn(`Token amount ${tokenAmountStr} exceeds JavaScript MAX_SAFE_INTEGER - using string-based handling`);
      }

      logger.debug(`Selling ${tokenAmountStr} smallest units (${rawToUi(amountToSell, decimals)} UI units, decimals: ${decimals})`);

      // Partial exit ladder for thin liquidity: 100% -> 75% -> 50% -> 25%
      const partialExitFractions = enablePartialExitLadder ? [1.0, 0.75, 0.50, 0.25] : [1.0];

      let cumulativeSolReceived = 0;
      let cumulativeAtaRentRefund = 0;
      let anyPartialSuccess = false;
      let lastError = '';
      let remainingToSell = amountToSell;
      let cumulativeSold = 0n;

      for (let fractionIdx = 0; fractionIdx < partialExitFractions.length; fractionIdx++) {
        const fraction = partialExitFractions[fractionIdx];

        remainingToSell = amountToSell - cumulativeSold;
        if (remainingToSell <= 0n) {
          logger.debug(`All tokens for this trade sold - no remaining amount`);
          break;
        }

        const currentAmountToSell = BigInt(Math.floor(Number(remainingToSell) * fraction));
        const currentTokenAmountStr = currentAmountToSell.toString();

        // Safety check: wallet balance
        try {
          const { rawAmount: walletBalance } = await this.getRawTokenAmount(tokenMint);
          if (walletBalance < currentAmountToSell) {
            logger.warn(`Wallet balance (${rawToUi(walletBalance, decimals)}) is less than requested (${rawToUi(currentAmountToSell, decimals)})`);
            if (walletBalance === 0n) {
              logger.error(`Wallet has 0 balance - cannot continue`);
              break;
            }
          }
        } catch (error: any) {
          logger.error(`Cannot continue partial exit - ATA check failed: ${error.message}`);
          break;
        }

        if (currentAmountToSell <= 0n) {
          continue;
        }

        // Minimum viable trade size check
        const minViableTradeRaw = 10n ** BigInt(Math.max(0, decimals - 2)); // 0.01 tokens
        if (currentAmountToSell < minViableTradeRaw) {
          const uiRemaining = rawToUi(remainingToSell, decimals);
          logger.warn(`🔮 Skipping partial exit at ${(fraction * 100).toFixed(0)}% - amount too small for viable trade (${rawToUi(currentAmountToSell, decimals)} tokens)`);
          // If last fraction and amount is tiny, auto-burn dust
          if (fractionIdx === partialExitFractions.length - 1 && remainingToSell > 0n) {
            logger.warn(`   Remaining ${uiRemaining} tokens is dust (too small to sell)`);
            const burnResult = await this.burnDustSmart(tokenMint, remainingToSell, decimals, closeAccountAfterSell);
            if (burnResult.burnSuccess) {
              cumulativeSold += burnResult.cumulativeSold || remainingToSell;
              if (burnResult.ataRentRefund) cumulativeAtaRentRefund = burnResult.ataRentRefund;
              anyPartialSuccess = true;
              break;
            }
          }
          continue;
        }

        if (fractionIdx > 0) {
          logger.warn(`🔮 Retrying SELL with PARTIAL EXIT: ${(fraction * 100).toFixed(0)}% of remaining (thin liquidity fallback)`);
          logger.warn(`   Remaining: ${rawToUi(remainingToSell, decimals)} tokens, trying: ${rawToUi(currentAmountToSell, decimals)} tokens`);
        }

        // Get Ultra order for this fraction
        let order: UltraOrderResponse | null;
        try {
          order = await this.getUltraOrder(tokenMint, SOL_MINT, currentTokenAmountStr);
        } catch (error: any) {
          if (error.message === 'NO_ROUTE_FOUND') {
            logger.error(`Cannot sell ${tokenMint}: No liquidity/route available on Jupiter`);
            return {
              success: false,
              error: 'No trading route found - token has no liquidity or is not tradeable',
            };
          }
          logger.error(`Unexpected error getting Ultra order:`, error);
          order = null;
        }

        if (!order) {
          lastError = 'Failed to get Ultra order for sell';
          logger.warn(`Failed to get Ultra order for SELL at ${(fraction * 100).toFixed(0)}% fraction`);
          continue; // Try next fraction
        }

        logger.debug(`Ultra order received: ${order.outAmount || '?'} lamports for ${order.inAmount || '?'} tokens (RTSE slippage: ${order.slippageBps}bps)`);

        // Execute via Ultra
        const swapResult = await this.executeUltraOrder(order);

        const resultWithQuote: SwapResult = {
          ...swapResult,
          quoteInAmount: order.inAmount,
          quoteOutAmount: order.outAmount,
          quotePriceImpactPct: order.priceImpactPct,
        };

        if (onAttempt) {
          await onAttempt(fractionIdx, order.slippageBps, resultWithQuote);
        }

        if (swapResult.success) {
          if (fractionIdx > 0) {
            logger.info(`🔮 SELL swap succeeded with partial exit (${(fraction * 100).toFixed(0)}% of tokens)`);
          }

          anyPartialSuccess = true;
          const solReceived = swapResult.actualAmountOut ? parseFloat(swapResult.actualAmountOut) / 1e9 : 0;
          cumulativeSolReceived += solReceived;

          const actualTokensSoldRaw = swapResult.actualAmountIn ? BigInt(swapResult.actualAmountIn) : currentAmountToSell;
          cumulativeSold += actualTokensSoldRaw;

          const remainingForThisTrade = amountToSell - cumulativeSold;
          const soldEverything = remainingForThisTrade <= 0n;

          // ATA close logic
          let walletBalanceAfterSell = 0n;
          try {
            const { rawAmount: remainingRaw } = await this.getRawTokenAmount(tokenMint);
            walletBalanceAfterSell = remainingRaw;
          } catch (err) {
            // ATA might not exist
          }

          if (closeAccountAfterSell && soldEverything) {
            const minViableTrade = 10n ** BigInt(Math.max(0, decimals - 2));
            const smallRemainderRaw = 10n ** BigInt(Math.max(0, decimals - 1));
            const isDust = walletBalanceAfterSell > 0n && walletBalanceAfterSell < minViableTrade;
            const isSmallRemainder = walletBalanceAfterSell >= minViableTrade && walletBalanceAfterSell < smallRemainderRaw;

            if (walletBalanceAfterSell === 0n || isDust) {
              const closeResult = await this.tryCloseAtaIfEmpty(tokenMint, decimals, "After selling all tokens");
              if (closeResult.success) {
                resultWithQuote.ataRentRefund = closeResult.rentRefunded;
                resultWithQuote.closeAccountTxHash = closeResult.txHash;
                cumulativeAtaRentRefund = closeResult.rentRefunded || 0;
              }
            } else if (isSmallRemainder) {
              const remainingUi = rawToUi(walletBalanceAfterSell, decimals);
              logger.info(`🔮 Small remainder detected (${remainingUi} tokens) - attempting to burn and close ATA`);
              try {
                const burnResult = await this.burnDust(tokenMint, walletBalanceAfterSell);
                if (burnResult.success) {
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  const closeResult = await this.tryCloseAtaIfEmpty(tokenMint, decimals, "After burning small remainder");
                  if (closeResult.success) {
                    resultWithQuote.ataRentRefund = closeResult.rentRefunded;
                    resultWithQuote.closeAccountTxHash = closeResult.txHash;
                    cumulativeAtaRentRefund = closeResult.rentRefunded || 0;
                  }
                }
              } catch (err: any) {
                logger.warn(`🔮 Error burning small remainder: ${err.message}`);
              }
            } else {
              const remainingUi = rawToUi(walletBalanceAfterSell, decimals);
              logger.info(`🔮 Wallet still has ${remainingUi} tokens after sell - waiting 2s before re-checking for ATA close`);
              const closeResult = await this.tryCloseAtaIfEmpty(tokenMint, decimals, "After selling all tokens (delayed check)");
              if (closeResult.success) {
                resultWithQuote.ataRentRefund = closeResult.rentRefunded;
                resultWithQuote.closeAccountTxHash = closeResult.txHash;
                cumulativeAtaRentRefund = closeResult.rentRefunded || 0;
              }
            }
          }

          if (soldEverything) {
            logger.success(`🔮 Successfully sold 100% of tokens for this trade (${rawToUi(amountToSell, decimals)} tokens)`);
            return resultWithQuote;
          } else {
            const remainingPct = Number(remainingForThisTrade) / Number(amountToSell) * 100;
            const remainingPctStr = remainingPct < 0.1 ? remainingPct.toFixed(4) : remainingPct.toFixed(1);
            logger.warn(`🔮 Partial exit successful - ${(fraction * 100).toFixed(0)}% sold, ${remainingPctStr}% remaining`);
            continue; // Try next fraction for remaining
          }
        }

        // Swap failed — retry up to 2 times with fresh orders on slippage/stale errors before moving to next fraction
        lastError = swapResult.error || '';

        if (this.isSlippageError(lastError)) {
          const maxSellSlippageRetries = 2;
          let sellRetrySucceeded = false;

          for (let sellRetry = 1; sellRetry <= maxSellSlippageRetries; sellRetry++) {
            const sellRetryDelayMs = sellRetry === 1 ? 500 : 1000;
            logger.warn(`🔮 SELL slippage/stale at ${(fraction * 100).toFixed(0)}% fraction, retry ${sellRetry}/${maxSellSlippageRetries} in ${sellRetryDelayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, sellRetryDelayMs));

            try {
              const retryOrder = await this.getUltraOrder(tokenMint, SOL_MINT, currentTokenAmountStr);
              if (retryOrder) {
                logger.info(`🔮 SELL retry ${sellRetry}: fresh order (RTSE slippage: ${retryOrder.slippageBps}bps)`);
                const retryResult = await this.executeUltraOrder(retryOrder);

                if (onAttempt) {
                  await onAttempt(fractionIdx, retryOrder.slippageBps, {
                    ...retryResult,
                    quoteInAmount: retryOrder.inAmount,
                    quoteOutAmount: retryOrder.outAmount,
                    quotePriceImpactPct: retryOrder.priceImpactPct,
                  });
                }

                if (retryResult.success) {
                  logger.success(`🔮 SELL retry ${sellRetry} succeeded at ${(fraction * 100).toFixed(0)}% fraction`);
                  anyPartialSuccess = true;
                  const solReceived = retryResult.actualAmountOut ? parseFloat(retryResult.actualAmountOut) / 1e9 : 0;
                  cumulativeSolReceived += solReceived;
                  const actualTokensSoldRaw = retryResult.actualAmountIn ? BigInt(retryResult.actualAmountIn) : currentAmountToSell;
                  cumulativeSold += actualTokensSoldRaw;

                  const remainingForThisTrade = amountToSell - cumulativeSold;
                  if (remainingForThisTrade <= 0n) {
                    return {
                      ...retryResult,
                      quoteInAmount: retryOrder.inAmount,
                      quoteOutAmount: retryOrder.outAmount,
                      quotePriceImpactPct: retryOrder.priceImpactPct,
                    };
                  }
                  sellRetrySucceeded = true;
                  break; // Sold this fraction, exit retry loop
                }

                // If non-slippage error, stop retrying
                if (!this.isSlippageError(retryResult.error || '')) {
                  logger.warn(`🔮 SELL retry ${sellRetry} failed (non-slippage): ${retryResult.error}`);
                  break;
                }
                logger.warn(`🔮 SELL retry ${sellRetry} failed (slippage again): ${retryResult.error}`);
              }
            } catch (retryErr: any) {
              logger.warn(`🔮 SELL retry ${sellRetry} failed to get fresh order: ${retryErr?.message}`);
              break;
            }
          }

          if (sellRetrySucceeded) continue; // Move to next fraction if needed
        }

        logger.warn(`🔮 SELL failed at ${(fraction * 100).toFixed(0)}% fraction: ${lastError}`);
        continue; // Try next smaller fraction
      } // End partial exit ladder loop

      // After all attempts, check for remaining dust to auto-burn
      remainingToSell = amountToSell - cumulativeSold;
      if (remainingToSell > 0n) {
        const minViableTradeRaw = 10n ** BigInt(Math.max(0, decimals - 2));
        if (remainingToSell < minViableTradeRaw) {
          const burnResult = await this.burnDustSmart(tokenMint, remainingToSell, decimals, closeAccountAfterSell);
          if (burnResult.burnSuccess) {
            cumulativeSold += burnResult.cumulativeSold || remainingToSell;
            if (burnResult.ataRentRefund) cumulativeAtaRentRefund = burnResult.ataRentRefund;
            anyPartialSuccess = true;
          }
        } else {
          logger.warn(`Remaining ${rawToUi(remainingToSell, decimals)} tokens could not be sold`);
        }
      } else if (remainingToSell === 0n && anyPartialSuccess && closeAccountAfterSell && cumulativeAtaRentRefund === 0) {
        const closeResult = await this.tryCloseAtaIfEmpty(tokenMint, decimals, "After partial exit ladder");
        if (closeResult.success) {
          cumulativeAtaRentRefund = closeResult.rentRefunded || 0;
        }
      }

      if (anyPartialSuccess) {
        logger.warn(`🔮 Partial exit completed - Total SOL received: ${cumulativeSolReceived.toFixed(8)} SOL`);
        return {
          success: true,
          txHash: 'partial_exit',
          actualAmountOut: (cumulativeSolReceived * 1e9).toString(),
          ataRentRefund: cumulativeAtaRentRefund,
          error: 'Partial exit - not all tokens sold due to thin liquidity',
          quoteInAmount: amountToSell.toString(),
          quoteOutAmount: (cumulativeSolReceived * 1e9).toString(),
        };
      }

      return {
        success: false,
        error: lastError || 'SELL swap failed after all partial exit attempts',
      };
    } catch (error: any) {
      logger.error(`SELL token failed with exception:`, {
        tokenMint,
        tokenAmount,
        error: error.message,
        stack: error.stack,
      });
      return {
        success: false,
        error: error.message || 'Unknown error during sell',
      };
    }
  }
}

// Singleton instance
let swapServiceInstance: SolanaSwapService | null = null;

export function getSwapService(): SolanaSwapService {
  if (!swapServiceInstance) {
    swapServiceInstance = new SolanaSwapService();
  }
  return swapServiceInstance;
}
