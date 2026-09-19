# The gateway, as a container, so sandboxes can reach it by name on a network they share
# with nothing else.
FROM oven/bun:1.4.2-alpine

WORKDIR /app
COPY package.json bun.lock ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/turn-token/package.json packages/turn-token/
RUN bun install --frozen-lockfile --production >/dev/null 2>&1 || bun install --production >/dev/null 2>&1

COPY tsconfig.json ./
COPY apps/gateway apps/gateway
COPY packages/turn-token packages/turn-token

EXPOSE 8080
CMD ["bun", "apps/gateway/src/main.ts"]
