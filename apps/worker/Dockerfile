# Build context is the repository root (the worker depends on packages/core).
FROM node:22-slim
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @hive/worker... build
CMD ["node", "apps/worker/dist/index.js"]
