/**
 * PostgreSQL Database Connection
 * 
 * Centralized database connection for all services
 */

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { logger } from '../utils/logger';

let pool: Pool | null = null;

/**
 * Get or create PostgreSQL connection pool
 */
export function getPool(): Pool {
  if (!pool) {
    // Detect if running in Cloud Run (K_SERVICE is set by Cloud Run)
    const isCloudRun = !!process.env.K_SERVICE;
    const connectionName = process.env.CLOUD_SQL_CONNECTION_NAME;
    
    let config: any = {
      database: process.env.POSTGRES_DB || 'unrekt',
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS || '20', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    };

    // Use Unix socket for Cloud Run, TCP for local
    if (isCloudRun && connectionName) {
      // Cloud Run with Cloud SQL Proxy via Unix socket
      config.host = `/cloudsql/${connectionName}`;
      logger.info('🔌 Connecting via Cloud SQL Unix socket');
    } else {
      // Local development with TCP
      config.host = process.env.POSTGRES_HOST || 'localhost';
      config.port = parseInt(process.env.POSTGRES_PORT || '5432');
      logger.info('🔌 Connecting via TCP');
    }

    pool = new Pool(config);

    pool.on('error', (err: Error) => {
      logger.warn(`PG pool idle connection dropped: ${err.message} (code=${(err as any).code || 'N/A'})`);
    });

    logger.info('✅ PostgreSQL connection pool created');
    logger.info(`   - Database: ${config.database}`);
    logger.info(`   - User: ${config.user}`);
    if (isCloudRun && connectionName) {
      logger.info(`   - Connection: ${connectionName}`);
    } else {
      logger.info(`   - Host: ${config.host}:${config.port}`);
    }
  }

  return pool;
}

/**
 * Execute a query
 * 
 * Note: TypeScript can't validate SQL parameter counts/names because SQL is just a string.
 * This function adds runtime validation to catch parameter mismatches early.
 */
export async function query<T = any>(text: string, params?: any[]): Promise<QueryResult<T & QueryResultRow>> {
  // Runtime validation: Check parameter count matches SQL placeholders
  if (params && params.length > 0) {
    const paramMatches = text.match(/\$(\d+)/g);
    if (paramMatches) {
      const paramNumbers = paramMatches.map(m => parseInt(m.replace('$', '')));
      const maxParam = Math.max(...paramNumbers);
      const uniqueParams = new Set(paramMatches);
      
      // Check for duplicate parameters (e.g., $1, $2, $1 again)
      if (paramMatches.length !== uniqueParams.size) {
        const duplicates = paramMatches.filter((p, i) => paramMatches.indexOf(p) !== i);
        throw new Error(
          `SQL parameter error: Duplicate parameters found: ${duplicates.join(', ')}\n` +
          `SQL preview: ${text.substring(0, 200)}...`
        );
      }
      
      // Check parameter count matches
      if (params.length !== maxParam) {
        throw new Error(
          `SQL parameter mismatch: SQL expects ${maxParam} parameters (found up to $${maxParam}), but got ${params.length} values\n` +
          `SQL preview: ${text.substring(0, 200)}...`
        );
      }
    }
  }
  
  const pool = getPool();
  return pool.query<T & QueryResultRow>(text, params);
}

/**
 * Get a client from the pool for transactions
 */
export async function getClient(): Promise<PoolClient> {
  const pool = getPool();
  return pool.connect();
}

/**
 * Close the pool (for graceful shutdown)
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('PostgreSQL connection pool closed');
  }
}

/**
 * Initialize database schema
 */
export async function initializeSchema(): Promise<void> {
  logger.info('📊 Initializing database schema...');

  try {
    // Create decisions table (AI decisions - lightweight, no market data duplication)
    await query(`
      CREATE TABLE IF NOT EXISTS decisions (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        chain VARCHAR(10) NOT NULL DEFAULT 'UNKNOWN',
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT,
        should_buy BOOLEAN NOT NULL,
        confidence INTEGER NOT NULL,
        reasoning TEXT,
        freshness_score INTEGER,
        position_size_percent DOUBLE PRECISION,
        stop_loss_percent DOUBLE PRECISION,
        take_profit_1_percent DOUBLE PRECISION,
        take_profit_2_percent DOUBLE PRECISION,
        take_profit_3_percent DOUBLE PRECISION,
        ml_predicted_return DOUBLE PRECISION,
        ml_expected_value DOUBLE PRECISION,
        executed BOOLEAN DEFAULT FALSE,
        trade_id INTEGER,
        scan_id TEXT,
        
        -- AI Analysis Details (for Telegram messages)
        opportunities TEXT[],
        risks TEXT[],
        warnings TEXT[]
      );
    `);

    // Create trades table
    await query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        decision_id INTEGER NOT NULL,
        chain VARCHAR(10) NOT NULL DEFAULT 'UNKNOWN',
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        
        -- Entry
        entry_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        entry_price DOUBLE PRECISION NOT NULL,
        entry_amount_usd DOUBLE PRECISION NOT NULL,
        entry_slippage_percent DOUBLE PRECISION DEFAULT 0.5,
        entry_fee_percent DOUBLE PRECISION DEFAULT 0.3,
        actual_entry_price DOUBLE PRECISION,
        actual_entry_cost DOUBLE PRECISION,
        tokens_bought DOUBLE PRECISION,
        
        -- Exit
        exit_timestamp TIMESTAMP,
        exit_price DOUBLE PRECISION,
        exit_reason TEXT,
        exit_slippage_percent DOUBLE PRECISION DEFAULT 0.5,
        exit_fee_percent DOUBLE PRECISION DEFAULT 0.3,
        actual_exit_price DOUBLE PRECISION,
        actual_exit_amount DOUBLE PRECISION,
        
        -- P&L
        pnl_percent DOUBLE PRECISION,
        net_pnl_usd DOUBLE PRECISION,
        cumulative_pnl_usd DOUBLE PRECISION DEFAULT 0,
        hold_duration_minutes INTEGER,
        max_price_reached DOUBLE PRECISION,
        max_price_timestamp TIMESTAMP,
        max_gain_percent DOUBLE PRECISION,
        
        -- Risk Management
        stop_loss_percent DOUBLE PRECISION,
        take_profit_1 DOUBLE PRECISION,
        take_profit_1_sell_percent DOUBLE PRECISION,
        take_profit_2 DOUBLE PRECISION,
        take_profit_2_sell_percent DOUBLE PRECISION,
        take_profit_3 DOUBLE PRECISION,
        take_profit_3_sell_percent DOUBLE PRECISION,
        time_based_exit_seconds INTEGER,
        
        -- Position tracking
        remaining_tokens DOUBLE PRECISION,
        tp1_hit BOOLEAN DEFAULT FALSE,
        tp2_hit BOOLEAN DEFAULT FALSE,
        tp3_hit BOOLEAN DEFAULT FALSE,
        
        -- Market benchmark (for beta/alpha calculation)
        sol_price_entry DOUBLE PRECISION,
        sol_price_exit DOUBLE PRECISION,
        
        -- Status
        status TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed'))
      );
    `);

    // Create indices for better query performance
    await query(`
      CREATE INDEX IF NOT EXISTS idx_trades_chain ON trades(chain);
      CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_address);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_entry_timestamp ON trades(entry_timestamp);
      CREATE INDEX IF NOT EXISTS idx_decisions_chain ON decisions(chain);
      CREATE INDEX IF NOT EXISTS idx_decisions_token ON decisions(token_address);
      CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_decisions_should_buy ON decisions(should_buy);
      CREATE INDEX IF NOT EXISTS idx_decisions_scan_id ON decisions(scan_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_opportunities ON decisions USING gin(opportunities);
      CREATE INDEX IF NOT EXISTS idx_decisions_risks ON decisions USING gin(risks);
      CREATE INDEX IF NOT EXISTS idx_decisions_warnings ON decisions USING gin(warnings);
    `);

    // Create watchlist table (Dual-AI entry strategy)
    await query(`
      CREATE TABLE IF NOT EXISTS watchlist_entries (
        id SERIAL PRIMARY KEY,
        
        -- Token identification
        token_address VARCHAR(100) NOT NULL,
        chain VARCHAR(20) NOT NULL,
        symbol VARCHAR(50),
        
        -- AI decision context (from Sonnet - get via decision_id JOIN)
        decision_id INTEGER REFERENCES decisions(id),
        signal_price DOUBLE PRECISION NOT NULL,
        
        -- Monitoring data (updated every 30s)
        signal_timestamp TIMESTAMP NOT NULL,
        max_price_reached DOUBLE PRECISION,
        max_gain_percent DOUBLE PRECISION,
        min_price_reached DOUBLE PRECISION,
        max_dump_percent DOUBLE PRECISION,
        
        -- Status tracking
        status VARCHAR(20) NOT NULL DEFAULT 'monitoring',
        skip_reason VARCHAR(100),
        executed_at TIMESTAMP,
        executed_price DOUBLE PRECISION,
        
        -- Haiku decision (if called)
        haiku_checked BOOLEAN DEFAULT false,
        haiku_analysis TEXT,
        haiku_decision VARCHAR(10),
        
        -- Timestamps
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create watchlist unique constraint
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_unique_monitoring 
      ON watchlist_entries(token_address, chain) 
      WHERE status = 'monitoring';
    `);

    // Create watchlist indices
    await query(`
      CREATE INDEX IF NOT EXISTS idx_watchlist_status ON watchlist_entries(status);
      CREATE INDEX IF NOT EXISTS idx_watchlist_signal_time ON watchlist_entries(signal_timestamp);
      CREATE INDEX IF NOT EXISTS idx_watchlist_token_chain ON watchlist_entries(token_address, chain);
    `);

    // Create price_history table (for analytics and opportunity cost tracking)
    await query(`
      CREATE TABLE IF NOT EXISTS price_history (
        id SERIAL PRIMARY KEY,
        token_address TEXT NOT NULL,
        chain TEXT NOT NULL,
        price_usd DOUBLE PRECISION NOT NULL,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Create price_history indices
    await query(`
      CREATE INDEX IF NOT EXISTS idx_price_history_lookup 
        ON price_history(token_address, chain, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_price_history_timestamp 
        ON price_history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_price_history_chain_timestamp 
        ON price_history(chain, timestamp DESC);
    `);

    // Create scans table (for scanner performance tracking)
    await query(`
      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        chain TEXT NOT NULL,
        tokens_found INTEGER NOT NULL,
        tokens_filtered_security INTEGER DEFAULT 0,
        tokens_filtered_activity INTEGER DEFAULT 0,
        tokens_filtered_liquidity INTEGER DEFAULT 0,
        tokens_analyzed INTEGER DEFAULT 0,
        tokens_buy INTEGER DEFAULT 0,
        tokens_skip INTEGER DEFAULT 0,
        bot_tx_breakdown JSONB,              -- Transaction counts per bot
        bot_tokens_breakdown JSONB,         -- Unique tokens per bot
        total_transactions INTEGER DEFAULT 0, -- Total bot transactions found
        duration_ms INTEGER
      );
    `);

    // Create scans indices
    await query(`
      CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp);
      CREATE INDEX IF NOT EXISTS idx_scans_chain ON scans(chain);
    `);

    // Create scanned_tokens table (comprehensive token snapshots for missed opportunity tracking)
    // NOTE: This schema includes all columns added via migrations. For new databases, run migrations
    // to ensure all columns are created. This CREATE TABLE IF NOT EXISTS will not modify existing tables.
    await query(`
      CREATE TABLE IF NOT EXISTS scanned_tokens (
        id SERIAL PRIMARY KEY,
        scan_id TEXT NOT NULL,
        token_address TEXT NOT NULL,
        chain TEXT NOT NULL,
        symbol TEXT,
        name TEXT,
        discovered_by_bots TEXT[],
        
        -- Market data (from Codex)
        price_usd DOUBLE PRECISION,
        market_cap DOUBLE PRECISION,
        liquidity DOUBLE PRECISION,
        volume_24h DOUBLE PRECISION,
        price_change_24h DOUBLE PRECISION,
        holders INTEGER,
        
        -- Trading activity (from scanner - bot trades)
        scanner_data JSONB,
        bot_buys INTEGER,
        bot_sells INTEGER,
        net_buys INTEGER,
        unique_users INTEGER,
        total_activity INTEGER,
        bot_activity_json JSONB,
        total_bots_count INTEGER,
        multi_bot_signal BOOLEAN,
        
        -- Trading activity (from DexScreener - all DEX trades)
        volume_5m DOUBLE PRECISION,
        volume_1h DOUBLE PRECISION,
        volume_6h DOUBLE PRECISION,
        txn_buys_5m INTEGER,
        txn_sells_5m INTEGER,
        txn_buys_1h INTEGER,
        txn_sells_1h INTEGER,
        txn_buys_6h INTEGER,
        txn_sells_6h INTEGER,
        txn_buys_24h INTEGER,
        txn_sells_24h INTEGER,
        buy_sell_ratio DOUBLE PRECISION,
        price_change_5m DOUBLE PRECISION,
        price_change_1h DOUBLE PRECISION,
        price_change_6h DOUBLE PRECISION,
        price_change_24h_dex DOUBLE PRECISION,
        pair_address TEXT,
        dex_id TEXT,
        quote_token TEXT,
        pair_created_at BIGINT,
        liquidity_base DOUBLE PRECISION,
        liquidity_quote DOUBLE PRECISION,
        fdv DOUBLE PRECISION,
        
        -- Extended Codex data (volumes, transactions, wallet metrics)
        volume_5m_codex DOUBLE PRECISION,
        volume_1h_codex DOUBLE PRECISION,
        volume_4h_codex DOUBLE PRECISION,
        volume_24h_codex DOUBLE PRECISION,
        buy_count_5m_codex INTEGER,
        sell_count_5m_codex INTEGER,
        buy_count_1h_codex INTEGER,
        sell_count_1h_codex INTEGER,
        buy_count_4h_codex INTEGER,
        sell_count_4h_codex INTEGER,
        buy_count_24h_codex INTEGER,
        sell_count_24h_codex INTEGER,
        unique_buys_5m_codex INTEGER,
        unique_sells_5m_codex INTEGER,
        unique_buys_1h_codex INTEGER,
        unique_sells_1h_codex INTEGER,
        unique_buys_24h_codex INTEGER,
        unique_sells_24h_codex INTEGER,
        unique_transactions_5m_codex INTEGER,
        unique_transactions_1h_codex INTEGER,
        unique_transactions_24h_codex INTEGER,
        swap_pct_1d_old_wallet DOUBLE PRECISION,
        swap_pct_7d_old_wallet DOUBLE PRECISION,
        wallet_age_avg DOUBLE PRECISION,
        wallet_age_std DOUBLE PRECISION,
        is_scam_codex BOOLEAN,
        
        -- Wallet Type Metrics (risk signals)
        bundler_count INTEGER,
        sniper_count INTEGER,
        insider_count INTEGER,
        bundler_held_percentage DOUBLE PRECISION,
        sniper_held_percentage DOUBLE PRECISION,
        insider_held_percentage DOUBLE PRECISION,
        dev_held_percentage DOUBLE PRECISION,
        
        -- Security analysis (from GoPlus/RugCheck)
        is_safe BOOLEAN,
        risk_score INTEGER,
        honeypot_detected BOOLEAN,
        ownership_risk BOOLEAN,
        blacklist_detected BOOLEAN,
        hidden_functions BOOLEAN,
        buy_tax DOUBLE PRECISION,
        sell_tax DOUBLE PRECISION,
        can_take_back_ownership BOOLEAN,
        owner_percent DOUBLE PRECISION,
        top10_holder_percent DOUBLE PRECISION,
        age_hours DOUBLE PRECISION,
        
        -- Filter tracking (for missed opportunity analysis)
        filter_stage TEXT,
        filter_reason TEXT,
        selection_score DOUBLE PRECISION,
        
        -- Peak gain tracking (maximum gain % during tracking period)
        peak_gain DOUBLE PRECISION,
        peak_drawdown DOUBLE PRECISION,
        
        -- Calculated Quantitative Fields
        volatility_5m DOUBLE PRECISION,
        volatility_1h DOUBLE PRECISION,
        volatility_24h DOUBLE PRECISION,
        momentum_score DOUBLE PRECISION,
        momentum_direction TEXT,
        volume_ratio_5m_1h DOUBLE PRECISION,
        volume_ratio_1h_24h DOUBLE PRECISION,
        volume_velocity DOUBLE PRECISION,
        volume_acceleration DOUBLE PRECISION,
        
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create scanned_tokens indices
    await query(`
      CREATE INDEX IF NOT EXISTS idx_scanned_tokens_scan_id ON scanned_tokens(scan_id);
      CREATE INDEX IF NOT EXISTS idx_scanned_tokens_token ON scanned_tokens(token_address, chain);
      CREATE INDEX IF NOT EXISTS idx_scanned_tokens_discovered_by_bots ON scanned_tokens USING gin(discovered_by_bots);
      CREATE INDEX IF NOT EXISTS idx_scanned_tokens_is_safe ON scanned_tokens(is_safe);
      CREATE INDEX IF NOT EXISTS idx_scanned_tokens_risk_score ON scanned_tokens(risk_score);
      CREATE INDEX IF NOT EXISTS idx_scanned_tokens_market_cap ON scanned_tokens(market_cap);
      CREATE INDEX IF NOT EXISTS idx_scanned_tokens_liquidity ON scanned_tokens(liquidity);
    `);

    logger.success('✅ Database schema initialized');
  } catch (error) {
    logger.error('❌ Failed to initialize database schema:', error);
    throw error;
  }
}

