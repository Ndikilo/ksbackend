# kanasante API — production image.
#
# Deploy-agnostic (12-factor): all config via environment variables, resolved
# and validated by varlock at process start against the committed .env.schema.
# In prod, APP_ENV=prod makes BETTER_AUTH_SECRET and DATABASE_URL required —
# boot fails loudly if they're missing.
#
# Migrations run on boot via scripts/start.sh (the drizzle folder is baked into
# the image; scripts/migrate.ts uses only prod deps so no drizzle-kit needed).
# The same flow works on any deploy platform that honors the CMD / docker command.

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
COPY drizzle ./drizzle
COPY scripts/migrate.ts scripts/start.sh ./scripts/

# varlock's codegen writes /app/env.d.ts at boot — the app dir must be writable
# by the non-root runtime user.
RUN chown bun:bun /app

USER bun
EXPOSE 3000

CMD ["bunx", "varlock", "run", "--", "sh", "scripts/start.sh"]
