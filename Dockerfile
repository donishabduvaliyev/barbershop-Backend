# ==========================================
# Production Multi-Stage Dockerfile
# Base: Node 20 on lightweight Alpine Linux
# ==========================================

FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Install build dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ==========================================
# Runner Stage
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production \
    PORT=5000 \
    TZ=Asia/Tashkent

# Install tzdata for accurate Uzbekistan timezone alignment
RUN apk add --no-cache tzdata

# Copy production dependencies from builder
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY package*.json ./

# Copy application source code
COPY . .

# Set file ownership to non-root user
RUN chown -R node:node /usr/src/app

# Run as non-root node user for container security
USER node

EXPOSE 5000

# Health check to ensure zero-downtime rolling deploys
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/health || exit 1

CMD ["node", "server.js"]
