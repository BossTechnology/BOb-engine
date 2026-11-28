# The feeder's image (task 3.7, P-H8).
#
# Bzzz's scripts/construir-imagen-bob.sh builds it from a clean commit of this
# repository with `SERVICIO=bob-feeder` and no DOCKERFILE: the script's default
# is a `Dockerfile` at the root, and the context is the root.
#
# What it holds: feeder/, package.json and the production dependencies (pg).
# What it does not: tests, supabase/, scripts/, docs, any .env, any secret. The
# secrets of a run are files the box mounts, named by BOB_*_FILE variables
# (.env.example). tests/feeder-image.test.mjs measures all of this.
#
# pnpm goes in with npm: `corepack enable` does not find the binary of
# pnpm@12.3.4. The version is the one package.json pins.

FROM node:22.21.1-alpine@sha256:0340fa682d72068edf603c305bfbc10e23219fb0e40df58d9ea4d6f33a9798bf AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g --no-audit --no-fund pnpm@12.3.4 \
 && pnpm install --prod --frozen-lockfile

FROM node:22.21.1-alpine@sha256:0340fa682d72068edf603c305bfbc10e23219fb0e40df58d9ea4d6f33a9798bf AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY feeder ./feeder
# Nobody (65534). The code stays owned by root: the user that runs it can read
# it and cannot change it, even on a box that mounts the root writable.
USER 65534:65534
ENTRYPOINT ["node", "feeder/main.mjs"]
