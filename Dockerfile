# syntax=docker/dockerfile:1.7

# ---- 1. install all deps (with dev) for the build ----
FROM node:22-alpine AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
# tolerate missing lockfile during fresh setup; in CI prefer --frozen-lockfile
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prefer-frozen-lockfile

# ---- 2. compile TypeScript ----
FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---- 3. install production deps only (smaller node_modules) ----
FROM node:22-alpine AS prod-deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --prefer-frozen-lockfile

# ---- 4. minimal runtime image ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    MCP_PORT=3334
WORKDIR /app

# drop privileges to the node user shipped with the image
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3334

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O - "http://127.0.0.1:${MCP_PORT}/health" >/dev/null || exit 1

CMD ["node", "dist/index.js"]
