# The gateway, as a container, so sandboxes can reach it by name on a network they share
# with nothing else.
FROM oven/bun:1.4.2-alpine

WORKDIR /app
COPY package.json bun.lock ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/agent/package.json apps/agent/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contract/package.json packages/contract/
COPY packages/queue/package.json packages/queue/
COPY packages/object-storage/package.json packages/object-storage/
COPY packages/turn-token/package.json packages/turn-token/
RUN bun install --frozen-lockfile --production --filter '@vid/gateway'

COPY tsconfig.json ./
COPY apps/gateway apps/gateway
COPY packages/turn-token packages/turn-token

EXPOSE 8080
CMD ["bun", "apps/gateway/src/main.ts"]
