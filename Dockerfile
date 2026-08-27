ARG BUN_VERSION=1
ARG NODE_VERSION=24

# ---- deps --------------------------------------------------------------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- build -------------------------------------------------------------
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# ---- runtime -----------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache tini \
 && addgroup -S app && adduser -S app -G app \
 && mkdir -p /app && chown app:app /app
USER app
WORKDIR /app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/server ./server
# worker uses src/ at runtime (Node 24+ type-stripping)
COPY --from=build --chown=app:app /app/src/ ./src/
COPY --from=build --chown=app:app /app/drizzle ./drizzle
COPY --from=build --chown=app:app /app/scripts ./scripts
COPY --from=build --chown=app:app /app/package.json ./package.json
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/healthz || exit 1
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","server/entry.fastify.js"]
