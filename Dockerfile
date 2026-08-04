# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
ENV WRANGLER_SEND_METRICS=false
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:console \
    && test -f dist/uglink_console/index.mjs \
    && test -f dist/client/index.html \
    && test ! -e dist/uglink_console/.dev.vars

FROM node:22-bookworm-slim AS runtime-dependencies
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="UGLINK Worker Gateway" \
      org.opencontainers.image.description="Local management console for deploying UGLINK gateway Workers" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=8787 \
    UGLINK_DATA_DIR=/data \
    WRANGLER_SEND_METRICS=false

WORKDIR /app

COPY --from=runtime-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/client ./dist/client
COPY --from=build --chown=node:node /app/dist/uglink_console/index.mjs ./dist/uglink_console/index.mjs
COPY --chown=node:node docker ./docker

RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8787
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "/app/docker/entrypoint.mjs"]
