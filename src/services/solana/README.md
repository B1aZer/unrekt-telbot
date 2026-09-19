# Solana Implementation Plan

This directory contains placeholder files for Solana chain support.

## Status: 🚧 NOT IMPLEMENTED

Currently, **only BNB chain is supported**. The files in this directory serve as a roadmap for future Solana implementation.

## What Needs to Be Implemented

### 1. **Scanner** (`scanner.ts`)
- [ ] Monitor Raydium/Jupiter program logs
- [ ] Parse swap transactions to identify hot tokens
- [ ] Track token volume and unique users
- [ ] Aggregate activity by token mint
- [ ] Handle slot-based scanning (not block-based like EVM)

**APIs Needed:**
- Helius/QuickNode Solana RPC (with enhanced APIs)
- Solana Web3.js library
- Raydium SDK or raw program interaction

### 2. **Security Scanner** (`security-scanner.ts`)
- [ ] Check mint authority (can creator mint unlimited?)
- [ ] Check freeze authority (can creator freeze wallets?)
- [ ] Verify token metadata (Metaplex)
- [ ] Analyze holder distribution
- [ ] Check LP lock status (Raydium lock program)
- [ ] Calculate risk score

**APIs Needed:**
- Rugcheck.xyz API (https://api.rugcheck.xyz)
- Solscan API for holder data
- On-chain SPL Token account parsing

### 3. **Monitor Integration**
- [ ] Update `monitor.ts` to accept scanner as dependency injection
- [ ] Create factory function to return correct scanner based on `CHAIN`
- [ ] No separate Solana monitor needed - existing monitor is chain-agnostic!

**Changes needed in `monitor.ts`:**
```typescript
// Instead of:
const scanResult = await scanHotTokens();

// Use dependency injection:
constructor(scanner: IScanner, ...) {
  this.scanner = scanner;
}

const scanResult = await this.scanner.scan();
```

### 4. **Price Data Adapter**
- [ ] Fetch OHLCV candles from Birdeye API
- [ ] Get current price from Jupiter API
- [ ] Adapt `PriceActionAnalyzer` for Solana data format

### 5. **Chain Config Updates**
- [ ] Add Solana-specific RPC endpoints
- [ ] Configure Birdeye/Jupiter API keys
- [ ] Set up Rugcheck API integration

## Architecture

```
src/services/
├── solana/              # Solana-specific implementations
│   ├── scanner.ts       # Slot scanning, swap detection
│   └── security-scanner.ts  # Authority checks, LP locks
│
├── monitor.ts           # Universal monitor (works for BNB + Solana)
├── trading-analyzer.ts  # AI analyzer (chain-agnostic)
└── paper-trader.ts      # Paper trading (chain-agnostic)
```

**Key Insight:** Only scanner and security scanner need Solana versions!
Everything else (monitor, AI, paper trading, alerts) works for any chain.

## Key Differences: Solana vs BNB

| Feature | BNB | Solana |
|---------|-----|--------|
| Block structure | EVM blocks | Slots (no blocks) |
| Transaction detection | Filter bot router addresses | Monitor program logs (Raydium/Jupiter) |
| Security checks | BSCScan source code | SPL Token authority checks |
| Honeypot detection | GoPlus API | Rugcheck.xyz API |
| Price data | DexScreener | Birdeye/Jupiter |
| LP locks | Check contract | Check Raydium lock program |
| Explorer | BSCScan | Solscan |

## Environment Variables Needed

```bash
CHAIN=SOLANA
SOLANA_RPC_URL=https://your-helius-url  # Need enhanced RPC
BIRDEYE_API_KEY=your_key                # For price/candles
RUGCHECK_API_KEY=your_key               # For security (if required)
```

## Recommended Libraries

```json
{
  "@solana/web3.js": "^1.90.0",
  "@solana/spl-token": "^0.4.0",
  "@metaplex-foundation/js": "^0.20.0"  // For metadata
}
```

## Implementation Steps (When Ready)

1. **Phase 1: Scanner**
   - Set up Solana connection
   - Monitor Raydium pool creation events
   - Parse swap transactions
   - Test with known hot tokens
   - **Output**: Same `ScanResult` format as BNB scanner

2. **Phase 2: Security**
   - Integrate Rugcheck.xyz API
   - Implement authority checks
   - Test with safe/unsafe tokens
   - **Output**: Same `SecurityAnalysis` format as BNB scanner

3. **Phase 3: Price Data**
   - Integrate Birdeye API
   - Fetch OHLCV candles
   - Adapt PriceActionAnalyzer for Birdeye format

4. **Phase 4: Integration**
   - Update `monitor.ts` to use dependency injection for scanner
   - Create scanner factory based on `CHAIN` env var
   - Test with Solana scanner
   - Verify Telegram alerts work

5. **Phase 5: Deployment**
   - Deploy as separate Cloud Run service
   - Set `CHAIN=SOLANA`
   - Monitor and iterate

## Cost Considerations

- **Helius RPC**: ~$50-100/month (need enhanced APIs for efficient scanning)
- **Birdeye API**: Check pricing for OHLCV candles
- **Rugcheck**: May be free or low-cost

## Notes

- Solana transactions are more complex to parse than EVM
- Need to handle account structure (not just addresses)
- Raydium program logs contain swap data in binary format
- Consider using Helius Enhanced APIs for simpler data access
- May need to monitor Pump.fun for meme coin launches

## When to Implement?

Implement Solana support when:
1. ✅ BNB version is stable and profitable
2. ✅ Have budget for Helius/Birdeye APIs (~$100-150/month)
3. ✅ Have time to test thoroughly (Solana is more complex)
4. ✅ Want to diversify chains for risk management

