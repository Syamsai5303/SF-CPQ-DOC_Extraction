# syntax=docker/dockerfile:1.7
# ---------- Stage 1: install all deps (incl. dev, for the Vite build) ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---------- Stage 2: build the React client ----------
FROM deps AS build
WORKDIR /app
COPY vite.config.js ./
COPY client ./client
RUN npm run build

# ---------- Stage 3: production dependencies only ----------
FROM deps AS prod-deps
WORKDIR /app
RUN npm prune --omit=dev && npx prisma generate

# ---------- Stage 4: minimal runtime image ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node server ./server
COPY --chown=node:node --from=build /app/client/dist ./client/dist
COPY --chown=node:node docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "./docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
