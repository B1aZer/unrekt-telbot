/**
 * Codex API Request Tracker
 *
 * Tracks all Codex API requests for monitoring and cost analysis.
 * Records HTTP status code so the dashboard can break requests down
 * into 4xx / 5xx / rate-limited buckets.
 */

interface RequestLog {
  timestamp: Date;
  type: 'batch_price' | 'batch_metadata' | 'individual_metadata' | 'candle';
  tokenCount?: number;
  resolution?: string;
  chain: string;
  statusCode?: number;     // HTTP status (undefined if fetch threw before response)
  success: boolean;
  errorType?: string;      // short category for grouping (e.g. 'http_429', 'timeout', 'network')
}

class CodexRequestTracker {
  private requests: RequestLog[] = [];
  private maxLogSize = 10000; // Keep last 10k requests in memory

  logRequest(
    type: RequestLog['type'],
    options: {
      tokenCount?: number;
      resolution?: string;
      chain?: string;
      statusCode?: number;
      success?: boolean;
      errorType?: string;
    } = {}
  ): void {
    const statusCode = options.statusCode;
    const log: RequestLog = {
      timestamp: new Date(),
      type,
      tokenCount: options.tokenCount,
      resolution: options.resolution,
      chain: options.chain || 'unknown',
      statusCode,
      success: options.success !== false && (statusCode == null || statusCode < 400),
      errorType: options.errorType,
    };

    this.requests.push(log);

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
    byType: Record<string, number>;
    batched: number;
    individual: number;
    candles: number;
    tokensFetched: number;
    successful: number;
    failed: number;
    rateLimited: number;
    rateLimitedPct: number;
    clientErrors4xx: number;
    clientErrors4xxPct: number;
    serverErrors5xx: number;
    serverErrors5xxPct: number;
    successRate: number;
    byStatusCode: Record<string, number>;
  } {
    const cutoff = new Date(Date.now() - sinceMinutes * 60 * 1000);
    const recent = this.requests.filter(r => r.timestamp >= cutoff);

    const stats = {
      total: recent.length,
      byType: {} as Record<string, number>,
      batched: 0,
      individual: 0,
      candles: 0,
      tokensFetched: 0,
      successful: 0,
      failed: 0,
      rateLimited: 0,
      rateLimitedPct: 0,
      clientErrors4xx: 0,
      clientErrors4xxPct: 0,
      serverErrors5xx: 0,
      serverErrors5xxPct: 0,
      successRate: 0,
      byStatusCode: {} as Record<string, number>,
    };

    for (const req of recent) {
      // Count by type
      stats.byType[req.type] = (stats.byType[req.type] || 0) + 1;

      // Categorize
      if (req.type === 'candle') {
        stats.candles++;
      } else if (req.type === 'batch_price' || req.type === 'batch_metadata') {
        stats.batched++;
        stats.tokensFetched += req.tokenCount || 0;
      } else {
        stats.individual++;
        stats.tokensFetched += req.tokenCount || 1;
      }

      // Success / failure / status-code bucketing
      if (req.success) stats.successful++;
      else stats.failed++;
      if (req.statusCode === 429) stats.rateLimited++;
      if (req.statusCode != null) {
        if (req.statusCode >= 400 && req.statusCode < 500) stats.clientErrors4xx++;
        else if (req.statusCode >= 500 && req.statusCode < 600) stats.serverErrors5xx++;
      }
      const codeKey = req.statusCode != null ? String(req.statusCode) : 'no_response';
      stats.byStatusCode[codeKey] = (stats.byStatusCode[codeKey] || 0) + 1;
    }

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
  getAllRequests(): RequestLog[] {
    return [...this.requests];
  }
}

export const codexRequestTracker = new CodexRequestTracker();
