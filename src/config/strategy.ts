/**
 * Strategy Configuration
 * 
 * Tracks the current scoring strategy version
 * Used for database logging and performance comparison
 * 
 * Strategy IDs correspond to the strategies table in the database
 */

import { query } from '../infra/database';
import { logger } from '../utils/logger';

export const STRATEGY_CONFIG = {
  // Strategy version - update this when making significant changes to scoring.
  // Each version is a row in the `strategies` table so trades can be compared across versions.
  // The versions and parameters used in production are not part of this repository.
  VERSION: 'v0.0-example',

  // Description of current strategy
  DESCRIPTION: 'Example strategy: tune entry filters and exits for your own data',
} as const;

// Cache the strategy ID and version to avoid repeated queries
let cachedStrategyId: number | null = null;
let cachedStrategyVersion: string | null = null;

/**
 * Get current strategy info for logging
 */
export function getStrategyInfo() {
  return {
    version: STRATEGY_CONFIG.VERSION,
    description: STRATEGY_CONFIG.DESCRIPTION,
  };
}

/**
 * Get or create the strategy ID from the database
 * Returns the ID from the strategies table for the active strategy
 * 
 * Priority:
 * 1. Active strategy from database (is_active = TRUE)
 * 2. Fallback to hardcoded version if no active strategy found
 * 
 * This ensures the bot automatically picks up newly deployed strategies
 * without requiring code changes and redeployment.
 * 
 * The cache is checked on every call to detect when a new strategy becomes active.
 */
export async function getStrategyId(): Promise<number | null> {
  try {
    // Always check for the active strategy first (allows automatic pickup of newly deployed strategies)
    // If we have a cached strategy, we still check to see if a new one became active
    const activeResult = await query(`
      SELECT id, version FROM strategies 
      WHERE is_active = TRUE
      ORDER BY deployed_at DESC
      LIMIT 1
    `);
    
    if (activeResult.rows.length > 0) {
      const activeStrategy = activeResult.rows[0];
      const activeStrategyId = activeStrategy.id;
      const activeStrategyVersion = activeStrategy.version;
      
      // Update cache if we have a new active strategy (different ID or version)
      if (cachedStrategyId !== activeStrategyId || cachedStrategyVersion !== activeStrategyVersion) {
        if (cachedStrategyId !== null) {
          logger.info(`🔄 Active strategy changed: ${cachedStrategyVersion || 'none'} (ID: ${cachedStrategyId}) → ${activeStrategyVersion} (ID: ${activeStrategyId})`);
        } else {
          logger.debug(`📊 Caching active strategy: ${activeStrategyVersion} (ID: ${activeStrategyId})`);
        }
        cachedStrategyId = activeStrategyId;
        cachedStrategyVersion = activeStrategyVersion;
      }
      
      return activeStrategyId;
    }
    
    // Fallback: If no active strategy, try to find strategy by hardcoded version
    // This ensures backwards compatibility and allows the bot to work even if
    // no strategy is explicitly marked as active
    logger.warn(`⚠️ No active strategy found in database, falling back to hardcoded version: ${STRATEGY_CONFIG.VERSION}`);
    const versionResult = await query(`
      SELECT id FROM strategies 
      WHERE version = $1
      LIMIT 1
    `, [STRATEGY_CONFIG.VERSION]);
    
    if (versionResult.rows.length > 0) {
      const fallbackStrategyId = versionResult.rows[0].id;
      
      // Update cache if fallback strategy is different
      if (cachedStrategyId !== fallbackStrategyId || cachedStrategyVersion !== STRATEGY_CONFIG.VERSION) {
        logger.debug(`📊 Using fallback strategy: ${STRATEGY_CONFIG.VERSION} (ID: ${fallbackStrategyId})`);
        cachedStrategyId = fallbackStrategyId;
        cachedStrategyVersion = STRATEGY_CONFIG.VERSION;
      }
      
      return fallbackStrategyId;
    }
    
    // No strategy found at all
    logger.error(`❌ No strategy found in database (neither active nor version ${STRATEGY_CONFIG.VERSION}) - run deploy-strategy.ts or add-strategy.ts`);
    return null;
  } catch (error) {
    logger.error('Failed to get strategy ID:', error);
    return null;
  }
}

/**
 * Clear the cached strategy ID (useful after config changes or strategy deployment)
 * The cache will be automatically refreshed on the next call to getStrategyId()
 */
export function clearStrategyCache() {
  logger.debug('🗑️ Clearing strategy cache');
  cachedStrategyId = null;
  cachedStrategyVersion = null;
}

