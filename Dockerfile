# One image, two roles (SPEC §2b). Coolify runs it twice, picked by the ROLE env (start.sh):
#   web    → (default) applies drizzle migrations, then the Next standalone server on :3000, health check GET /api/health
#   worker → ROLE=worker: node worker.cjs (scheduler + outbox queue; bundled, needs no node_modules)
# Env comes from Coolify (see apps/web/.env.example); nothing secret is baked in.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# next.config inlines it as NEXT_PUBLIC_TELEGRAM_BOT_USERNAME for the login button (not a secret)
ARG TELEGRAM_BOT_USERNAME
ENV TELEGRAM_BOT_USERNAME=$TELEGRAM_BOT_USERNAME
# only web, worker and what they depend on (not the Expo driver app)
RUN pnpm install --frozen-lockfile --filter "@eci-shuttle/web..." --filter "@eci-shuttle/worker..."
RUN pnpm --filter @eci-shuttle/web build && pnpm --filter @eci-shuttle/worker build

FROM node:22-alpine AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/worker/dist/worker.cjs ./worker.cjs
COPY --from=build --chown=node:node /app/apps/worker/dist/migrate.cjs ./migrate.cjs
COPY --from=build --chown=node:node /app/apps/web/drizzle ./drizzle
COPY --chown=node:node --chmod=755 start.sh ./start.sh
USER node
EXPOSE 3000
CMD ["./start.sh"]
