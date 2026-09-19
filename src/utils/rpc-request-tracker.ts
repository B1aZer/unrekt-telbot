/**
 * RPC Request Tracker
 *
 * Tracks all RPC calls for monitoring and cost analysis.
 * Records HTTP status code (when available — most RPC call sites
 * catch errors from viem/solana-web3 and extract the code via
 * extractHttpStatusFromError()) so the dashboard can break requests
 * down into 4xx / 5xx / rate-limited buckets.
 */

interface RpcRequestLog {
  timestamp: Date;
  method: 'getBlockNumber' | 'getBlock' | 'getTransaction' | 'getTransactionReceipt' | 'readContract' | 'call' | 'getSignaturesForAddress' | 'other';
  chain: string;
  blockNumber?: bigint;
  success: boolean;
  statusCode?: number;    // HTTP status (undefined if not an HTTP error)
  errorType?: string;     // short category for grouping (e.g. 'http_429', 'timeout')
}

class RpcRequestTracker {
  private requests: RpcRequestLog[] = [];
  private maxLogSize = 500000; // Keep last 500k requests in memory (batched calls can be 50x more)

  logRequest(
    method: RpcRequestLog['method'],
    options: {
      chain?: string;
      blockNumber?: bigint;
      success?: boolean;
      count?: number; // For batch requests: number of actual RPC calls in the batch
      statusCode?: number;
      errorType?: string;
    } = {}
  ): void {
    const timestamp = new Date();
    const chain = options.chain || 'unknown';
    const success = options.success !== false;
    const count = options.count || 1;
    const statusCode = options.statusCode;
    const errorType = options.errorType;

    // Log each request in the batch (for accurate counting)
    for (let i = 0; i < count; i++) {
      const log: RpcRequestLog = {
        timestamp,
        method,
        chain,
        blockNumber: options.blockNumber,
        success,
        statusCode,
        errorType,
      };

      this.requests.push(log);
    }

    // Trim old logs if we exceed max size
    if (this.requests.length > this.maxLogSize) {
      this.requests = this.requests.slice(-this.maxLogSize);
    }
  }

  /**
   * Get request statistics for a time period
   */
  getStats(sinceMinutes: number = 60): {
    total: number;
    byMethod: Record<string, number>;
    byChain: Record<string, number>;
    successful: number;
    failed: number;
    successRate: number;
    rateLimited: number;
    rateLimitedPct: number;
    clientErrors4xx: number;
    clientErrors4xxPct: number;
    serverErrors5xx: number;
    serverErrors5xxPct: number;
    byStatusCode: Record<string, number>;
  } {
    const cutoff = new Date(Date.now() - sinceMinutes * 60 * 1000);
    const recent = this.requests.filter(r => r.timestamp >= cutoff);

    const stats = {
      total: recent.length,
      byMethod: {} as Record<string, number>,
      byChain: {} as Record<string, number>,
      successful: 0,
      failed: 0,
      successRate: 0,
      rateLimited: 0,
      rateLimitedPct: 0,
      clientErrors4xx: 0,
      clientErrors4xxPct: 0,
      serverErrors5xx: 0,
      serverErrors5xxPct: 0,
      byStatusCode: {} as Record<string, number>,
    };

    for (const req of recent) {
      // Count by method
      stats.byMethod[req.method] = (stats.byMethod[req.method] || 0) + 1;

      // Count by chain
      stats.byChain[req.chain] = (stats.byChain[req.chain] || 0) + 1;

      // Count success/failure
      if (req.success) {
        stats.successful++;
      } else {
        stats.failed++;
      }

      // Status-code bucketing
      if (req.statusCode === 429) stats.rateLimited++;
      if (req.statusCode != null) {
        if (req.statusCode >= 400 && req.statusCode < 500) stats.clientErrors4xx++;
        else if (req.statusCode >= 500 && req.statusCode < 600) stats.serverErrors5xx++;
      }
      const codeKey = req.statusCode != null ? String(req.statusCode) : (req.success ? 'ok' : 'no_status');
      stats.byStatusCode[codeKey] = (stats.byStatusCode[codeKey] || 0) + 1;
    }

    // Calculate rates
    if (stats.total > 0) {
      stats.successRate = (stats.successful / stats.total) * 100;
      stats.rateLimitedPct = (stats.rateLimited / stats.total) * 100;
      stats.clientErrors4xxPct = (stats.clientErrors4xx / stats.total) * 100;
      stats.serverErrors5xxPct = (stats.serverErrors5xx / stats.total) * 100;
    }

    return stats;
  }

  /**
   * Get hourly request rate
   */
  getHourlyRate(): number {
    const stats = this.getStats(60);
    return stats.total; // Requests in last 60 minutes = requests/hour
  }

  /**
   * Clear old logs (keep only last N minutes)
   */
  clearOldLogs(keepMinutes: number = 60): void {
    const cutoff = new Date(Date.now() - keepMinutes * 60 * 1000);
    this.requests = this.requests.filter(r => r.timestamp >= cutoff);
  }

  /**
   * Get all requests (for debugging)
   */
  getAllRequests(): RpcRequestLog[] {
    return [...this.requests];
  }
}

/**
 * Best-effort extraction of an HTTP status code from an arbitrary error
 * thrown by viem / solana-web3.js / fetch / axios.
 *
 * Most RPC clients don't surface HTTP status codes as a first-class field,
 * but they do include things like "HTTP request failed. Status: 429" or
 * "Too Many Requests (429)" in the message. We grep for those.
 *
 * Returns undefined when no HTTP status can be identified — callers should
 * still log the request as failed with an errorType.
 */
export function extractHttpStatusFromError(err: unknown): { statusCode?: number; errorType?: string } {
  if (err == null) return {};

  // Direct numeric fields that libraries sometimes expose
  const anyErr = err as any;
  const direct = anyErr?.response?.status ?? anyErr?.status ?? anyErr?.statusCode;
  if (typeof direct === 'number' && direct >= 100 && direct < 600) {
    return { statusCode: direct, errorType: `http_${direct}` };
  }

  const msg = typeof anyErr?.message === 'string' ? anyErr.message : String(err);
  if (!msg) return {};

  // Common shapes: "Status: 429", "HTTP 503", "(429)", "429 Too Many Requests"
  const m = msg.match(/\b(4\d{2}|5\d{2})\b/);
  if (m) {
    const code = parseInt(m[1], 10);
    return { statusCode: code, errorType: `http_${code}` };
  }

  const lower = msg.toLowerCase();
  if (lower.includes('too many requests') || lower.includes('rate limit')) {
    return { statusCode: 429, errorType: 'http_429' };
  }
  if (lower.includes('timeout') || anyErr?.name === 'TimeoutError' || anyErr?.name === 'AbortError') {
    return { errorType: 'timeout' };
  }
  if (lower.includes('econnreset') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('fetch failed')) {
    return { errorType: 'network' };
  }

  return {};
}

export const rpcRequestTracker = new RpcRequestTracker();
