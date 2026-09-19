/**
 * On-chain Pool Quote Service
 *
 * Replaces Jupiter's quote HTTP API for the security scanner's liquidity check.
 * Reads pool reserves from pump.fun `pf_tokens.pool_{base,quote}_token_account`,
 * batch-fetches their balances via a single `getMultipleAccountsInfo` RPC call,
 * and computes constant-product AMM quotes for the standard 1-SOL position size.
 *
 * IMPORTANT — pump.fun scope only:
 *   `pf_tokens` covers graduated pump.fun tokens exclusively. Non-pump.fun tokens
 *   (raydium / meteora / orca / etc.) and pump.fun tokens not yet indexed by
 *   pf-collector simply aren't in the output map. Callers MUST treat a missing
 *   entry as "unknown, skip the liquidity check" — NOT as a failure signal —
 *   otherwise we re-create the exact problem we're fixing (wrongly penalizing
 *   tokens for external-data gaps).
 *
 * Why this exists: Jupiter's `quote` endpoint hit a 4.5-day 429 storm in April 2026
 * that silently kicked ~2500 tokens from `ai_ready` to `security_hardstop`. On-chain
 * reads eliminate that external dependency. See docs/JUPITER_QUOTE_ML_IMPACT_ANALYSIS.md.
 *
 * DB column compatibility: emits the same 5 fields per side that `checkJupiterQuotes`
 * used to emit (`success`, `priceImpact`, `outAmount`, `routesCount`, `error`) so the
 * ML training columns stay unchanged and models don't need retraining to read them.
 *
 * Parity vs fresh Jupiter quotes (validated on n=59 recent tokens, Helius RPC):
 *   - priceImpact: median 0.49pp error at fee=0  (Jupiter reports pure slippage)
 *   - outAmount:   median 0.23%  error at fee=1% (Jupiter reports post-fee received)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { AccountLayout } from '@solana/spl-token';
import { query } from '../../infra/database';
import { logger } from '../../utils/logger';

const SOL_LAMPORTS = 1_000_000_000n; // 1 SOL = 1e9 lamports
const POOL_SWAP_FEE = 0.01; // PumpSwap CP-AMM fee (validated against Jupiter out_amount parity)
const RPC_BATCH_SIZE = 100; // getMultipleAccountsInfo limit per call

export interface PoolQuoteResult {
  canGetQuote: boolean;
  priceImpact?: number; // decimal ratio, e.g. 0.01 = 1%
  outAmount?: string; // atomic units, string to match existing DB column type (text)
  routesCount?: number;
  error?: string;
}

export interface PoolQuotePair {
  buy: PoolQuoteResult;
  sell: PoolQuoteResult;
}

/**
 * Error marker for transient RPC failures — caller should NOT penalize risk score
 * when it sees this. Mirrors the old `isTransientJupiterError` treatment of HTTP
 * 429/5xx / timeouts on the Jupiter code path.
 */
export const POOL_RPC_ERROR = 'rpc error';

interface PoolInfo {
  baseVault: string; // holds the token side
  quoteVault: string; // holds the SOL side
}

/**
 * Compute a CP-AMM quote for `amountIn` of the `in` asset → `out` asset.
 *
 * Returns two different fee treatments on purpose — they match how Jupiter reports
 * its fields, which is what the existing ML pipeline was trained on:
 *
 *   outAmount   = tokens received *after* POOL_SWAP_FEE is applied to the input
 *                 → matches Jupiter's `outAmount` (post-fee received)
 *   priceImpact = 1 - (outNoFee * reserveIn) / (amountIn * reserveOut)
 *                 → computed with fee=0 to match Jupiter's `priceImpactPct`
 *                   (pure slippage from mid, excludes fees)
 *
 * Parity: median 0.23% outAmount error, 0.49pp impact error on 59 fresh quotes.
 */
function cpAmmQuote(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): { outAmount: bigint; priceImpact: number } {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) {
    return { outAmount: 0n, priceImpact: 1 };
  }

  // 1e9-scaled integer math on the fee to keep precision on bigint
  const FEE_DENOM = 1_000_000_000n;
  const feeNum = BigInt(Math.round((1 - POOL_SWAP_FEE) * Number(FEE_DENOM)));
  const amountInAfterFee = (amountIn * feeNum) / FEE_DENOM;

  // outAmount with fee (matches Jupiter's post-fee receive)
  const outAmount =
    (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);

  // priceImpact with fee=0 (matches Jupiter's priceImpactPct definition)
  const outNoFee = (reserveOut * amountIn) / (reserveIn + amountIn);
  const exec = Number(outNoFee) / Number(amountIn);
  const mid = Number(reserveOut) / Number(reserveIn);
  const priceImpact = 1 - exec / mid;

  return { outAmount, priceImpact };
}

/**
 * Batch-read SPL token account balances via getMultipleAccountsInfo (100/call).
 * Returns `null` for any account in a chunk that threw an RPC error so the caller
 * can tag those as transient (don't penalize).
 */
async function readVaultBalances(
  connection: Connection,
  vaults: string[],
): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>();
  const unique = Array.from(new Set(vaults));

  for (let i = 0; i < unique.length; i += RPC_BATCH_SIZE) {
    const chunk = unique.slice(i, i + RPC_BATCH_SIZE);
    try {
      const infos = await connection.getMultipleAccountsInfo(
        chunk.map((k) => new PublicKey(k)),
        'confirmed',
      );
      infos.forEach((info, idx) => {
        if (!info) {
          // Account doesn't exist on-chain — real "stale pool" signal
          out.set(chunk[idx], 0n);
          return;
        }
        try {
          const decoded = AccountLayout.decode(info.data);
          out.set(chunk[idx], decoded.amount);
        } catch (e) {
          // Not a valid SPL token account layout — treat as stale
          out.set(chunk[idx], 0n);
        }
      });
    } catch (e: any) {
      // Transient RPC failure — tag with null so caller can mark error='rpc error'
      logger.warn(`Pool vault batch RPC failed (${chunk.length} accts): ${e.message}`);
      for (const k of chunk) out.set(k, null);
    }
  }

  return out;
}

/**
 * Look up pool vault addresses from pf_tokens for a list of mints.
 * Only returns rows where both pool_base_token_account and pool_quote_token_account
 * are populated. Post-backfill via migration 049, this is ~100% of graduated pump.fun
 * tokens — but pf_tokens is pump.fun-only, so non-pump.fun mints simply won't be in
 * the result (caller treats them as "skip, not fail").
 */
async function lookupPoolVaults(mints: string[]): Promise<Map<string, PoolInfo>> {
  if (mints.length === 0) return new Map();

  try {
    const { rows } = await query<{
      token_address: string;
      pool_base_token_account: string;
      pool_quote_token_account: string;
    }>(
      `SELECT token_address, pool_base_token_account, pool_quote_token_account
       FROM pf_tokens
       WHERE token_address = ANY($1)
         AND pool_base_token_account IS NOT NULL
         AND pool_quote_token_account IS NOT NULL`,
      [mints],
    );

    const out = new Map<string, PoolInfo>();
    for (const r of rows) {
      out.set(r.token_address, {
        baseVault: r.pool_base_token_account,
        quoteVault: r.pool_quote_token_account,
      });
    }
    return out;
  } catch (e: any) {
    logger.error(`pf_tokens lookup failed: ${e.message}`);
    return new Map();
  }
}

/**
 * Batch-compute on-chain pool quotes for a set of mints.
 *
 * Pipeline:
 *   1. One DB query    — pf_tokens lookup for vault addresses (pump.fun only)
 *   2. One RPC batch   — getMultipleAccountsInfo for all vaults (100/call)
 *   3. Per-token math  — constant-product quote for buy (1 SOL → tok)
 *                        and sell (buy_out_tok → SOL), mirrors the old Jupiter
 *                        roundtrip pattern in checkJupiterQuotes
 *
 * Return contract:
 *   - Mints present in the map: quote was attempted. Check `canGetQuote` + `error`.
 *   - Mints NOT in the map: skipped because they aren't in pf_tokens
 *     (= not a pump.fun token, OR pf-collector hasn't indexed them yet).
 *     Callers MUST treat this as "unknown, don't penalize" — NOT as failure.
 *     The DB columns for these tokens stay null/undefined which imputes to 0
 *     in the ML pipeline, matching the 56% NaN training distribution.
 */
export async function batchPoolQuotes(
  connection: Connection,
  mints: string[],
): Promise<Map<string, PoolQuotePair>> {
  const out = new Map<string, PoolQuotePair>();

  // 1. DB lookup — this also acts as the pump.fun filter
  const pools = await lookupPoolVaults(mints);

  if (pools.size === 0) {
    logger.debug(
      `Pool quotes: 0/${mints.length} mints have pf_tokens entries (none are indexed pump.fun graduates)`,
    );
    return out;
  }

  // 2. Batch RPC — collect all unique vaults
  const allVaults: string[] = [];
  for (const p of pools.values()) {
    allVaults.push(p.baseVault, p.quoteVault);
  }
  const balances = await readVaultBalances(connection, allVaults);

  // 3. Per-token quote computation
  let successes = 0;
  let stale = 0;
  let rpcErrors = 0;

  for (const [mint, pool] of pools.entries()) {
    const reserveTok = balances.get(pool.baseVault);
    const reserveSol = balances.get(pool.quoteVault);

    // null = transient RPC failure on this vault's chunk — don't penalize.
    // undefined shouldn't happen in practice (readVaultBalances sets an entry for
    // every pubkey) but handle it the same way to satisfy the type narrower.
    // Mirrors the old isTransientJupiterError handling for HTTP 429/5xx/timeout.
    if (reserveTok == null || reserveSol == null) {
      const transientFail: PoolQuoteResult = {
        canGetQuote: false,
        error: POOL_RPC_ERROR,
        routesCount: 0,
      };
      out.set(mint, { buy: transientFail, sell: { ...transientFail } });
      rpcErrors++;
      continue;
    }

    // Zero reserves = stale pool. The pf_tokens sniper-pool-address bug that caused
    // shared wrong addresses is fixed (migration 049 + new extractor in pf-collector,
    // see pf-collector/docs/incident-pool-extraction-2026-04-11.md), but this guard
    // stays as belt-and-braces. Permanent signal: +30 risk downstream.
    if (reserveTok === 0n || reserveSol === 0n) {
      const staleFail: PoolQuoteResult = {
        canGetQuote: false,
        error: 'stale pool (zero reserves)',
        routesCount: 0,
      };
      out.set(mint, { buy: staleFail, sell: { ...staleFail } });
      stale++;
      continue;
    }

    // Buy: 1 SOL → token
    const buyQ = cpAmmQuote(SOL_LAMPORTS, reserveSol, reserveTok);
    const buy: PoolQuoteResult = {
      canGetQuote: true,
      priceImpact: buyQ.priceImpact,
      outAmount: buyQ.outAmount.toString(),
      routesCount: 1,
    };

    // Sell: buy_outAmount token → SOL (mirrors Jupiter roundtrip pattern —
    // we sell exactly what we just bought, matching the old checkJupiterQuotes flow)
    const sellQ = cpAmmQuote(buyQ.outAmount, reserveTok, reserveSol);
    const sell: PoolQuoteResult = {
      canGetQuote: true,
      priceImpact: sellQ.priceImpact,
      outAmount: sellQ.outAmount.toString(),
      routesCount: 1,
    };

    out.set(mint, { buy, sell });
    successes++;
  }

  const skipped = mints.length - pools.size;
  logger.info(
    `Pool quotes: ${successes} ok, ${stale} stale, ${rpcErrors} rpc_err, ${skipped} skipped (non-pump.fun / not indexed) — n=${mints.length}`,
  );

  return out;
}
