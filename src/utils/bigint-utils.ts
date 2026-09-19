/**
 * BigInt Utilities for Safe Token Amount Handling
 * 
 * GOLDEN RULE: Raw token amounts must remain BigInt or string from RPC → Jupiter → swap.
 * The moment you touch Number, correctness is gone.
 * 
 * JavaScript Number cannot safely represent integers > 2^53 (9,007,199,254,740,991).
 * Many meme tokens (especially Pump.fun tokens) have supplies that exceed this limit.
 * 
 * This module provides safe conversion utilities that never lose precision.
 */

/**
 * Maximum safe integer in JavaScript (2^53 - 1)
 * Any integer larger than this cannot be safely represented as a Number
 */
export const JS_MAX_SAFE_INTEGER = 9007199254740991n;

/**
 * Solana u64 maximum value
 */
export const SOLANA_U64_MAX = 18446744073709551615n;

/**
 * Convert UI amount (human-readable) to raw amount (smallest units) safely
 * 
 * Example: uiToRaw("1.5", 9) → 1500000000n
 * Example: uiToRaw("0.000001", 6) → 1n
 * 
 * @param ui - Human-readable amount as string (e.g., "1.5", "1000000")
 * @param decimals - Token decimals (e.g., 9 for SOL, 6 for USDC)
 * @returns Raw amount as bigint in smallest units
 */
export function uiToRaw(ui: string, decimals: number): bigint {
  // Handle empty or invalid input
  if (!ui || ui.trim() === '') {
    return 0n;
  }

  // Normalize: remove leading/trailing whitespace
  const normalized = ui.trim();

  // Split by decimal point
  const parts = normalized.split('.');
  const wholePart = parts[0] || '0';
  const fracPart = parts[1] || '';

  // Pad or truncate fractional part to match decimals
  // Example: "1.5" with 9 decimals → whole="1", frac="500000000"
  const fracPadded = (fracPart + '0'.repeat(decimals)).slice(0, decimals);

  // Combine and convert to bigint
  const combined = wholePart + fracPadded;
  
  // Handle negative numbers
  if (combined.startsWith('-')) {
    return -BigInt(combined.slice(1));
  }
  
  return BigInt(combined);
}

/**
 * Convert raw amount (smallest units) to UI amount (human-readable) safely
 * 
 * Example: rawToUi(1500000000n, 9) → "1.5"
 * Example: rawToUi(1n, 6) → "0.000001"
 * 
 * @param raw - Raw amount as bigint in smallest units
 * @param decimals - Token decimals (e.g., 9 for SOL, 6 for USDC)
 * @returns Human-readable amount as string
 */
export function rawToUi(raw: bigint, decimals: number): string {
  if (raw === 0n) {
    return '0';
  }

  const isNegative = raw < 0n;
  const absRaw = isNegative ? -raw : raw;
  const rawStr = absRaw.toString();

  // If raw value is shorter than decimals, we need leading zeros
  if (rawStr.length <= decimals) {
    const padded = '0'.repeat(decimals - rawStr.length + 1) + rawStr;
    const wholePart = '0';
    const fracPart = padded.slice(-decimals);
    const trimmedFrac = fracPart.replace(/0+$/, '');
    
    const result = trimmedFrac ? `${wholePart}.${trimmedFrac}` : wholePart;
    return isNegative ? `-${result}` : result;
  }

  // Split into whole and fractional parts
  const wholePart = rawStr.slice(0, -decimals);
  const fracPart = rawStr.slice(-decimals);
  
  // Trim trailing zeros from fractional part
  const trimmedFrac = fracPart.replace(/0+$/, '');
  
  const result = trimmedFrac ? `${wholePart}.${trimmedFrac}` : wholePart;
  return isNegative ? `-${result}` : result;
}

/**
 * Safely convert a bigint to Number for display purposes only
 * Returns Infinity if the value exceeds MAX_SAFE_INTEGER
 * 
 * WARNING: Only use this for logging/display, NEVER for calculations!
 * 
 * @param value - BigInt value to convert
 * @returns Number representation (may be Infinity for large values)
 */
export function bigintToDisplayNumber(value: bigint): number {
  if (value > JS_MAX_SAFE_INTEGER) {
    return Infinity;
  }
  if (value < -JS_MAX_SAFE_INTEGER) {
    return -Infinity;
  }
  return Number(value);
}

/**
 * Check if a bigint value is safe to convert to Number without precision loss
 * 
 * @param value - BigInt value to check
 * @returns true if the value can be safely represented as a Number
 */
export function isSafeForNumber(value: bigint): boolean {
  return value >= -JS_MAX_SAFE_INTEGER && value <= JS_MAX_SAFE_INTEGER;
}

/**
 * Check if a bigint value exceeds Solana's u64 maximum
 * 
 * @param value - BigInt value to check
 * @returns true if the value exceeds Solana u64 max (would fail on-chain)
 */
export function exceedsSolanaU64(value: bigint): boolean {
  return value < 0n || value > SOLANA_U64_MAX;
}

/**
 * Parse a string that might be a bigint (from Jupiter API, RPC, etc.)
 * Handles both string and bigint inputs safely
 * 
 * @param value - String, bigint, or number to parse
 * @returns BigInt representation
 */
export function parseBigInt(value: string | bigint | number): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    // Warn if precision might be lost
    if (!Number.isSafeInteger(value)) {
      console.warn(`[bigint-utils] Warning: Converting unsafe number ${value} to bigint - precision may be lost`);
    }
    return BigInt(Math.floor(value));
  }
  // String - parse directly
  return BigInt(value);
}

/**
 * Compare two raw amounts and return the minimum
 * Useful for "sell min(userAmount, walletBalance)" logic
 * 
 * @param a - First bigint
 * @param b - Second bigint
 * @returns The smaller of the two values
 */
export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Compare two raw amounts and return the maximum
 * 
 * @param a - First bigint
 * @param b - Second bigint
 * @returns The larger of the two values
 */
export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Format a raw amount with its decimals for logging
 * Shows both raw and UI representation
 * 
 * Example: formatRawForLog(1500000000n, 9) → "1500000000 (1.5 UI units)"
 * 
 * @param raw - Raw amount as bigint
 * @param decimals - Token decimals
 * @returns Formatted string for logging
 */
export function formatRawForLog(raw: bigint, decimals: number): string {
  const ui = rawToUi(raw, decimals);
  return `${raw.toString()} (${ui} UI units)`;
}
