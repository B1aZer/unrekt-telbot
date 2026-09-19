/**
 * Jupiter Request Tracker
 *
 * Tracks all Jupiter API requests (quote + swap) for monitoring.
 * Records HTTP status code so the dashboard can break requests down
 * into 4xx / 5xx / rate-limited buckets. A silent 429 storm on
 * Jupiter's quote endpoint caused the April 2026 AI-ready funnel
 * collapse (see docs/JUPITER_429_AI_READY_COLLAPSE.md) — this is
 * what gives us visibility on the next one.
 */

type JupiterEndpoint =
  | 'quote_buy'
  | 'quote_sell'
  | 'ultra_order'
  | 'ultra_execute'
  | 'other';

interface JupiterRequestLog {
  timestamp: Date;
  endpoint: JupiterEndpoint;
  statusCode?: number;        // HTTP status (undefined if fetch threw before response)
  success: boolean;
  rateLimited: boolean;       // true if statusCode === 429
  durationMs?: number;
  errorType?: string;         // short category for grouping (e.g. 'http_429', 'timeout')
}

class JupiterRequestTracker {
  private requests: JupiterRequestLog[] = [];
  private maxLogSize = 50_000;

  logRequest(
    endpoint: JupiterEndpoint,
    options: {
      statusCode?: number;
      success?: boolean;
      durationMs?: number;
      errorType?: string;
    } = {}
  ): void {
    const statusCode = options.statusCode;
    const rateLimited = statusCode === 429;
    const log: JupiterRequestLog = {
      timestamp: new Date(),
      endpoint,
      statusCode,
      success: options.success !== false && !rateLimited && (statusCode == null || statusCode < 400),
      rateLimited,
      durationMs: options.durationMs,
      errorType: options.errorType,
    };

    this.requests.push(log);

    if (this.requests.length > this.maxLogSize) {
      this.requests = this.requests.slice(-this.maxLogSize);
    }
  }

  /**
   * Stats for the most recent `sinceMinutes` minutes.
   */
  getStats(sinceMinutes: number = 60): {
    total: number;
    byEndpoint: Record<string, number>;
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
    avgDurationMs: number;
  } {
    const cutoff = new Date(Date.now() - sinceMinutes * 60 * 1000);
    const recent = this.requests.filter((r) => r.timestamp >= cutoff);

    const stats = {
      total: recent.length,
      byEndpoint: {} as Record<string, number>,
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
      avgDurationMs: 0,
    };

    let durationSum = 0;
    let durationCount = 0;

    for (const req of recent) {
      stats.byEndpoint[req.endpoint] = (stats.byEndpoint[req.endpoint] || 0) + 1;
      if (req.success) stats.successful++;
      else stats.failed++;
      if (req.rateLimited) stats.rateLimited++;
      if (req.statusCode != null) {
        if (req.statusCode >= 400 && req.statusCode < 500) stats.clientErrors4xx++;
        else if (req.statusCode >= 500 && req.statusCode < 600) stats.serverErrors5xx++;
      }
      const codeKey = req.statusCode != null ? String(req.statusCode) : 'no_response';
      stats.byStatusCode[codeKey] = (stats.byStatusCode[codeKey] || 0) + 1;
      if (req.durationMs != null) {
        durationSum += req.durationMs;
        durationCount++;
      }
    }

    if (stats.total > 0) {
      stats.successRate = (stats.successful / stats.total) * 100;
      stats.rateLimitedPct = (stats.rateLimited / stats.total) * 100;
      stats.clientErrors4xxPct = (stats.clientErrors4xx / stats.total) * 100;
      stats.serverErrors5xxPct = (stats.serverErrors5xx / stats.total) * 100;
    }
    if (durationCount > 0) {
      stats.avgDurationMs = durationSum / durationCount;
    }

    return stats;
  }

  getHourlyRate(): number {
    return this.getStats(60).total;
  }

  clearOldLogs(keepMinutes: number = 60): void {
    const cutoff = new Date(Date.now() - keepMinutes * 60 * 1000);
    this.requests = this.requests.filter((r) => r.timestamp >= cutoff);
  }
}

export const jupiterRequestTracker = new JupiterRequestTracker();
