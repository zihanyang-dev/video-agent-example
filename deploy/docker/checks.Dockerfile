FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
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

COPY . .
CMD ["bun", "run", "check"]
