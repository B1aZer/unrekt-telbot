/**
 * Shared Paper Trading Instance
 * 
 * Single PaperTrader instance shared across the entire application
 * to avoid multiple connections and ensure consistent state.
 */

import { PaperTrader } from './paper-trader';

// Create single shared instance
// This is the ONLY place where PaperTrader should be instantiated
export const sharedPaperTrader = new PaperTrader();

