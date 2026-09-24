# syntax=docker/dockerfile:1.7

FROM node:22.23.3-bookworm-slim AS build
ENV WRANGLER_SEND_METRICS=false
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:console \
    && test -f dist/uglink_console/index.mjs \
    && test -f dist/client/index.html \
    && test -f dist/node-console/index.mjs \
    && test ! -e dist/uglink_console/.dev.vars

FROM node:22.23.3-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="UGLINK Worker NAS" \
      org.opencontainers.image.description="Local management console for deploying UGLINK gateway Workers" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=8787 \
    UGLINK_DATA_DIR=/data

WORKDIR /app

COPY --from=build --chown=node:node /app/dist/client ./dist/client
COPY --from=build --chown=node:node /app/dist/node-console ./dist/node-console

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && test -s /etc/ssl/certs/ca-certificates.crt \
    && mkdir -p /data \
    && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8787
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "/app/dist/node-console/index.mjs"]
