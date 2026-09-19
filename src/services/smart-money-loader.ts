/**
 * Smart Money Wallets Loader
 * 
 * Loads smart money wallets from database
 * Provides fast O(1) lookup structures for scanner
 */

import { query } from '../infra/database';
import { logger } from '../utils/logger';

export interface SmartMoneyWallet {
  address: string;
  name?: string;
  tier: 1 | 2 | 3;
  notes?: string;
}

// Simple in-memory cache for fast lookups (Set = O(1), Array.find = O(n))
// With 1-10k wallets, Set/Map is necessary for performance
let wallets: SmartMoneyWallet[] = [];
let walletSet: Set<string> = new Set();
let tierMap: Map<string, 1 | 2 | 3> = new Map();

/**
 * Load smart money wallets from database
 * Called before each scan to get latest wallets
 */
export async function loadSmartMoneyWallets(): Promise<void> {
  const result = await query<SmartMoneyWallet>(`
    SELECT 
      address,
      name,
      tier::integer as tier,
      notes
    FROM smart_money_wallets
    WHERE is_active = TRUE
    ORDER BY tier DESC, address ASC
  `);
  
  wallets = result.rows.map(row => ({
    address: row.address,
    name: row.name || undefined,
    tier: row.tier as 1 | 2 | 3,
    notes: row.notes || undefined,
  }));
  
  // Build fast lookup structures (O(1) instead of O(n))
  walletSet = new Set(wallets.map(w => w.address));
  tierMap = new Map(wallets.map(w => [w.address, w.tier]));
  
  if (wallets.length === 0) {
    logger.warn('⚠️  No smart money wallets found in database');
  } else {
    const tier1 = wallets.filter(w => w.tier === 1).length;
    const tier2 = wallets.filter(w => w.tier === 2).length;
    const tier3 = wallets.filter(w => w.tier === 3).length;
    logger.debug(`📊 Loaded ${wallets.length} wallets (T1: ${tier1}, T2: ${tier2}, T3: ${tier3})`);
  }
}

/**
 * Check if a wallet is smart money (O(1) with Set)
 */
export function isSmartMoneyWallet(address: string): boolean {
  return walletSet.has(address);
}

/**
 * Get tier for a smart money wallet (O(1) with Map)
 */
export function getSmartMoneyTier(address: string): 1 | 2 | 3 | undefined {
  return tierMap.get(address);
}

/**
 * Get tier weight multiplier
 * Tier 1 = usual/good (1x weight)
 * Tier 2 = consistent (2x weight)
 * Tier 3 = legendary (3x weight)
 */
export function getSmartMoneyWeight(tier: 1 | 2 | 3): number {
  return tier; // Tier 1 = 1x, Tier 2 = 2x, Tier 3 = 3x
}

/**
 * Get full wallet info
 */
export function getSmartMoneyInfo(address: string): SmartMoneyWallet | undefined {
  return wallets.find(w => w.address === address);
}

/**
 * Get all smart money wallets
 */
export function getAllSmartMoneyWallets(): SmartMoneyWallet[] {
  return wallets;
}

/**
 * Get wallet stats
 */
export function getSmartMoneyStats() {
  return {
    total: wallets.length,
    tier1: wallets.filter(w => w.tier === 1).length,
    tier2: wallets.filter(w => w.tier === 2).length,
    tier3: wallets.filter(w => w.tier === 3).length,
    active: wallets.length,
  };
}

