# Open Assistant 2.0 — frontend (Bun) : serves the SPA + API routes.
FROM docker.io/oven/bun:1 AS base
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# App source (node_modules / .env / dbs excluded via .dockerignore).
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# `start` = NODE_ENV=production bun src/index.ts
CMD ["bun", "run", "start"]
