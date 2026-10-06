FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS workspace-manifests
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/agent/package.json ./apps/agent/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/contract/package.json ./packages/contract/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/object-storage/package.json ./packages/object-storage/package.json
# Bun installs only these workspaces and their workspace dependency closure.
# Keep manifests/lock intact; production excludes root and workspace dev tooling.
FROM workspace-manifests AS production-dependencies
# Do not auto-install UI peers of better-auth; native optional dependencies stay enabled.
RUN bun install --frozen-lockfile --production --omit=peer --filter '@vid/server...' --filter '@vid/agent...' \
    && bun pm cache rm

# Native TS entrypoints need source exports, not generated SDKs or DB type files.
FROM workspace-manifests AS runtime-source
COPY packages/config/src ./packages/config/src
COPY packages/contract/src ./packages/contract/src
COPY packages/database/src ./packages/database/src
COPY packages/object-storage/src ./packages/object-storage/src
COPY apps/server/src ./apps/server/src
COPY apps/agent/src ./apps/agent/src
RUN find apps packages -type f -name '*.test.ts' -delete \
    && chmod -R a+rX apps packages

# Native setup has the exact dbmate binary and PostgreSQL client, not Bun tooling.
FROM ghcr.io/amacneil/dbmate:2.36.0@sha256:520c740c6e0ad73fde2cd1ea7e2b779aaf789d22aca8858f87a478e7094535fb AS dbmate
FROM postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873 AS migrate
COPY --from=dbmate /usr/local/bin/dbmate /usr/local/bin/dbmate
COPY packages/database/migrations /app/migrations
COPY deploy/database.sql /app/database.sql
ENTRYPOINT ["sh", "-ec"]
CMD ["dbmate --migrations-dir /app/migrations --no-dump-schema --wait migrate && psql -X -w --single-transaction -f /app/database.sql"]

FROM production-dependencies AS runtime
COPY --from=runtime-source /app/packages/config/src ./packages/config/src
COPY --from=runtime-source /app/packages/contract/src ./packages/contract/src
COPY --from=runtime-source /app/packages/database/src ./packages/database/src
COPY --from=runtime-source /app/packages/object-storage/src ./packages/object-storage/src
USER bun

FROM runtime AS worker
COPY apps/agent/prompt.md ./apps/agent/prompt.md
COPY --from=runtime-source /app/apps/agent/src ./apps/agent/src
CMD ["bun", "apps/agent/src/main.ts"]

FROM runtime AS server
COPY --from=runtime-source /app/apps/server/src ./apps/server/src
CMD ["bun", "apps/server/src/main.ts"]

FROM caddy:2.11.6-alpine@sha256:c776e0c6413b544d0459665e54ec7b8b2a15000c0cbee8b254da0067b1d184ff AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
