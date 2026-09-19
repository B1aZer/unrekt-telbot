# ============================================================================
# Multi-stage Dockerfile for Unrekt Telbot
# Optimized for Google Cloud Run
# ============================================================================

FROM oven/bun:1.2.19-alpine AS base
WORKDIR /app

# ============================================================================
# Dependencies stage - install only production dependencies
# ============================================================================
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ============================================================================
# Build stage - copy source code
# ============================================================================
FROM base AS builder
COPY package.json bun.lock ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY tsconfig.json ./
COPY analytics.html ./
COPY hybrid-analytics.html ./
COPY index.html ./
COPY style.css ./
COPY script.js ./

# ============================================================================
# Production stage - minimal runtime image
# ============================================================================
FROM oven/bun:1.2.19-alpine AS runner
WORKDIR /app

# Create non-root user for security
RUN addgroup --system --gid 1001 bunuser && \
    adduser --system --uid 1001 bunuser

# Copy dependencies and source from previous stages
COPY --from=deps --chown=bunuser:bunuser /app/node_modules ./node_modules
COPY --from=builder --chown=bunuser:bunuser /app/src ./src
COPY --from=builder --chown=bunuser:bunuser /app/package.json ./
COPY --from=builder --chown=bunuser:bunuser /app/tsconfig.json ./
COPY --from=builder --chown=bunuser:bunuser /app/analytics.html ./
COPY --from=builder --chown=bunuser:bunuser /app/hybrid-analytics.html ./
COPY --from=builder --chown=bunuser:bunuser /app/index.html ./
COPY --from=builder --chown=bunuser:bunuser /app/style.css ./
COPY --from=builder --chown=bunuser:bunuser /app/script.js ./

# Switch to non-root user
USER bunuser

# Expose port (Google Cloud Run uses PORT env variable)
EXPOSE 8080

# Health check (optional, for monitoring)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD bun run -e "console.log('healthy')" || exit 1

# Start the bot
CMD ["bun", "run", "src/bot.ts"]

