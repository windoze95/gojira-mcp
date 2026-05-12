# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22-alpine

# --- builder ---
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# --- runtime ---
FROM node:${NODE_VERSION} AS runtime
LABEL org.opencontainers.image.title="gojira-mcp" \
      org.opencontainers.image.description="Atlassian Cloud admin MCP server" \
      org.opencontainers.image.source="https://github.com/windoze95/gojira-mcp" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="UNLICENSED"

ENV NODE_ENV=production
ENV HEALTHCHECK_PROTOCOL=http

RUN addgroup -S mcp && adduser -S mcp -G mcp
USER mcp
WORKDIR /app

COPY --from=builder --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=builder --chown=mcp:mcp /app/dist ./dist
COPY --from=builder --chown=mcp:mcp /app/package.json ./package.json

ENV MCP_PORT=8081
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --spider --tries=1 "${HEALTHCHECK_PROTOCOL}://127.0.0.1:${MCP_PORT}/health" || exit 1

CMD ["node", "dist/index.js"]
