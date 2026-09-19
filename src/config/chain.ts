/**
 * Blockchain Configuration
 * Centralizes chain-specific settings for multi-chain support
 */

export enum Chain {
  BNB = 'BNB',
  SOLANA = 'SOLANA',
}

export interface ChainConfig {
  chain: Chain;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  explorerApiKey?: string;
  nativeCurrency: string;
  
  // Scanner config
  blocksToScan: number;
  
  // Security scanner endpoints
  securityApiUrl?: string;
  
  // DexScreener chain ID
  dexScreenerChainId: string;
  
  // Codex chain ID (for OHLCV candles)
  codexChainId: string;
}

/**
 * Get current chain from environment
 */
export function getCurrentChain(): Chain {
  const chainEnv = process.env.CHAIN?.toUpperCase();
  
  if (chainEnv === 'SOLANA') {
    return Chain.SOLANA;
  }
  
  // Default to BNB
  return Chain.BNB;
}

/**
 * Get chain configuration
 */
export function getChainConfig(): ChainConfig {
  const chain = getCurrentChain();
  
  switch (chain) {
    case Chain.BNB:
      return {
        chain: Chain.BNB,
        name: 'BNB Smart Chain',
        rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
        explorerUrl: 'https://bscscan.com',
        explorerApiKey: process.env.BSCSCAN_API_KEY,
        nativeCurrency: 'BNB',
        blocksToScan: parseInt(process.env.BLOCKS_TO_SCAN || '150', 10),
        securityApiUrl: 'https://api.gopluslabs.io/api/v1/token_security/56',
        dexScreenerChainId: 'bsc',
        codexChainId: 'bsc',
      };
      
    case Chain.SOLANA:
      return {
        chain: Chain.SOLANA,
        name: 'Solana',
        rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
        explorerUrl: 'https://solscan.io',
        nativeCurrency: 'SOL',
        blocksToScan: parseInt(process.env.BLOCKS_TO_SCAN || '100', 10),
        securityApiUrl: 'https://api.gopluslabs.io/api/v1/token_security/solana',
        dexScreenerChainId: 'solana',
        codexChainId: 'solana',
      };
      
    default:
      throw new Error(`Unsupported chain: ${chain}`);
  }
}

/**
 * Check if current chain is supported
 */
export function isChainSupported(chain: string): boolean {
  return chain.toUpperCase() === 'BNB' || chain.toUpperCase() === 'SOLANA';
}

/**
 * Validate chain configuration
 */
export function validateChainConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const chain = getCurrentChain();
  const config = getChainConfig();
  
  if (!config.rpcUrl) {
    errors.push(`Missing RPC URL for ${chain}`);
  }
  
  if (chain === Chain.BNB && !config.explorerApiKey) {
    errors.push('Missing BSCSCAN_API_KEY for BNB chain');
  }
  
  if (chain === Chain.SOLANA && !process.env.SOLANA_RPC_URL) {
    errors.push('Missing SOLANA_RPC_URL for Solana chain (public RPC not recommended)');
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

