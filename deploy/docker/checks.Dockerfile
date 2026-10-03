FROM node:24-bookworm-slim AS node
FROM oven/bun:1.4.2
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/agent/package.json ./apps/agent/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/execution-protocol/package.json ./packages/execution-protocol/package.json
COPY packages/messaging/package.json ./packages/messaging/package.json
COPY packages/object-storage/package.json ./packages/object-storage/package.json
RUN bun install --frozen-lockfile

COPY . .
CMD ["bun", "run", "check"]
