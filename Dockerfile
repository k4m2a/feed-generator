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
# binary and ts-node, so `yarn backfill` / `yarn publishAll` still work via
# `docker exec`) plus the compiled JS.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json yarn.lock ./
COPY scripts ./scripts
COPY src ./src

EXPOSE 3000

CMD ["node", "dist/index.js"]
