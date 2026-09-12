# ── Production Multi-Platform Dockerfile ─────────────────────────────
# Designed for 100% Free Cloud Hosting:
#   • Hugging Face Spaces (Docker SDK - 16GB RAM / 2 vCPU FREE forever)
#   • Render.com (Web Service Free Tier)
#   • Railway / Koyeb / Fly.io
# ─────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim

# Prevent interactive prompts during apt install
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies:
# - tor: privacy router
# - chromium: headless browser runtime
# - dumb-init: lightweight PID 1 init process for zombie reaping & clean signals
# - fonts: ensure beautiful web typography and emoji rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    tor \
    chromium \
    dumb-init \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

# Set up Tor data directory for the non-root node user (UID 1000)
RUN mkdir -p /tmp/tor-data && \
    chown -R node:node /tmp/tor-data && \
    chmod 700 /tmp/tor-data

# Set up working directory
WORKDIR /home/node/app

# Ensure Puppeteer uses system Chromium, Tor data directory, and port 7860
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    TOR_EXECUTABLE_PATH=/usr/bin/tor \
    TOR_DATA_DIR=/tmp/tor-data \
    NODE_ENV=production \
    PORT=7860 \
    HOME=/home/node

# Copy package files and install dependencies
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY --chown=node:node server/ ./server/
COPY --chown=node:node public/ ./public/

# Switch to non-root user for safe Chromium & Tor execution
USER node

# Expose server port for Hugging Face Spaces
EXPOSE 7860

# Use dumb-init to handle process signals cleanly (SIGTERM/SIGINT)
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start the RBI Proxy server
CMD ["node", "server/index.js"]

