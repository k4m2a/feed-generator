# Built in CI (GitHub Actions) and pushed to GHCR; Coolify only ever pulls the
# finished image. The box therefore runs plain `node`, never a TypeScript build.
FROM node:20-slim AS build
WORKDIR /app

# better-sqlite3 is a native module and needs a toolchain to compile.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# Carry over the already-compiled node_modules (incl. the native better-sqlite3
# binary and ts-node, so `yarn backfill` still works from the container shell)
# plus the compiled JS.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json yarn.lock ./
COPY scripts ./scripts
COPY src ./src

# tsconfig is required at RUNTIME, not just at build time: `scripts/` is never
# compiled into dist/ (tsconfig `include` is src-only), so `yarn backfill` runs
# it through ts-node. Without this file ts-node falls back to its default
# `module: ESNext`, node hands the .ts to the ESM loader, and it dies with
# `ERR_UNKNOWN_FILE_EXTENSION`. The repo tsconfig pins `module: CommonJS`.
COPY tsconfig.json ./

EXPOSE 3000

CMD ["node", "dist/index.js"]
