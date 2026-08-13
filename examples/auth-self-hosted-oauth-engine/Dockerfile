# syntax=docker/dockerfile:1

FROM node:22.23.1-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS development-dependencies
RUN npm ci

FROM development-dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS production-dependencies
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22.23.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json invokta.mcp.json ./
COPY --chown=node:node migrations ./migrations

USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node dist/healthcheck.js

CMD ["node", "dist/mcp-http.js"]
