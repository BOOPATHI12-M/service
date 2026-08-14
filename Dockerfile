# Backend image for Railway.
#
# This repo holds BOTH the Node backend (server.js) and the Windows Python
# agent (agent.py + requirements.txt). Auto-detection picks Python and fails,
# so the build is pinned to Node here. The agent is not part of this image —
# it is built into agent.exe by .github/workflows/build.yml.
FROM node:20-alpine

WORKDIR /app

# Install deps first so this layer is cached when only app code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code (see .dockerignore — the Python agent is excluded).
COPY server.js ./
COPY static ./static
COPY templates ./templates

ENV NODE_ENV=production

# Railway injects PORT; server.js falls back to 8000 and binds 0.0.0.0.
EXPOSE 8000

# Container-level health check (independent of the platform's HTTP probe).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
