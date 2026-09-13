# kanasante API — production image.
#
# Deploy-agnostic (12-factor): all config via environment variables, resolved
# and validated by varlock at process start against the committed .env.schema.
# In prod, APP_ENV=prod makes BETTER_AUTH_SECRET and DATABASE_URL required —
# boot fails loudly if they're missing.
#
# Migrations are NOT run by this image. Run them as a separate release step
# (with dev dependencies available):   bun install && bun run db:migrate

FROM oven/bun:1.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV APP_ENV=prod

COPY --from=deps /app/node_modules ./node_modules
COPY package.json .env.schema ./
COPY src ./src

USER bun
EXPOSE 3000

CMD ["bunx", "varlock", "run", "--", "bun", "src/server.ts"]
