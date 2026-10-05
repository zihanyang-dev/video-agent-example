FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS dependencies
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/agent/package.json ./apps/agent/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/contract/package.json ./packages/contract/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/object-storage/package.json ./packages/object-storage/package.json
RUN bun install --frozen-lockfile

# Native setup has the exact dbmate binary and PostgreSQL client, not Bun tooling.
FROM ghcr.io/amacneil/dbmate:2.36.0@sha256:520c740c6e0ad73fde2cd1ea7e2b779aaf789d22aca8858f87a478e7094535fb AS dbmate
FROM postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873 AS migrate
COPY --from=dbmate /usr/local/bin/dbmate /usr/local/bin/dbmate
COPY packages/database/migrations /app/migrations
COPY deploy/database.sql /app/database.sql
ENTRYPOINT ["sh", "-ec"]
CMD ["dbmate --migrations-dir /app/migrations --no-dump-schema --wait migrate && psql -X -w --single-transaction -f /app/database.sql"]

FROM dependencies AS web-build
COPY packages/contract ./packages/contract
COPY apps/web ./apps/web
RUN bun run --cwd apps/web build

FROM dependencies AS runtime
COPY packages ./packages
USER bun

FROM runtime AS worker
COPY profiles ./profiles
COPY apps/agent ./apps/agent
CMD ["bun", "apps/agent/src/main.ts"]

FROM runtime AS server
COPY apps/server ./apps/server
CMD ["bun", "apps/server/src/main.ts"]

FROM caddy:2.11.6-alpine@sha256:c776e0c6413b544d0459665e54ec7b8b2a15000c0cbee8b254da0067b1d184ff AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv
