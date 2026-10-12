# ECI Shuttle: project rules

Source of truth: `docs/SPEC.md`. Interfaces and file ownership: `docs/CONTRACTS.md`. Progress: `docs/progress/LEDGER.md`.

## Always
- **pnpm only** (never npm/yarn). Node 22+.
- **Never read `.env` files** (`.env`, `.env.local`, …). `apps/web/.env.example` lists every variable.
- **TDD**: write the real test first, watch it fail, then implement. Turn any `it.todo` in your files into real tests.
- **Before every commit**: your tests, `pnpm typecheck`, `pnpm lint` (fix with `pnpm format`). Commit only green.
- Stay inside the files you own (`docs/CONTRACTS.md` → Ownership). Frozen contracts are never edited by a module:
  `packages/shared/src/contracts/*`, `apps/web/src/db/schema.ts`, `apps/web/src/services/kernel/*`. Need a change?
  Make the smallest local workaround and report it as a contract change request.

## Architecture
- **One service layer** (`apps/web/src/services`): `fn(db, actor, input, now?)` with zod input (`parseInput`) and
  typed `ServiceError`s. Roles and workspace scope are checked there and nowhere else (`requireRole`, `readable`,
  `getInWorkspace`).
- **Adapters are thin**: admin pages/server actions, API routes, the bot webhook, MCP tools and worker jobs only
  parse, build the Actor, call a service, and map errors (`httpStatus`, `userMessage`). No SQL, no rules in adapters.
- **Every write goes through `mutate()`** (`services/kernel/mutate.ts`): one transaction, exactly one `audit_log`
  row per mutation. Side effects (Telegram, push) go through `enqueue()` in the same transaction.
  Not audited: derived data (pings, vehicle_state, trips, stats) and worker bookkeeping columns
  (`sent_at`, `fired_at`, outbox status, `last_used_at`, heartbeat).
- **Pure functions take `now`** as a parameter (epoch ms or `Date`); never call `Date.now()` inside logic.
  Services that depend on time take `now: Date` as their last argument.
- **Times shown to people are IST** (`Asia/Kolkata`): use `istHHMM`, `istDate`, `formatIst` from
  `@eci-shuttle/shared`, never `toLocale*` without the zone. Store timestamptz; HH:MM / dates are IST.
- **Attendees never see lateness**: no "late", no planned-vs-expected in public surfaces.
- **One origin**: build URLs with `origin()` from `lib/env`, never a hardcoded host.

## UI
- Admin is **phone-first at 390px**: bottom tab bar, cards not tables, tap targets ≥ 44px, one-column forms with
  sticky Save, native date/time pickers. Desktop gets more columns, never more features. No horizontal scroll.
- Usability over decoration. shadcn/ui components live in `apps/web/src/components/ui`.

## Tests
- Unit tests: `*.test.ts`. Anything touching Postgres: `*.db.test.ts` (runs on the local Docker test Postgres:
  `pnpm test-db` once, then `pnpm test:db`). Never a remote DB; never pull Docker images (postgres:18 is cached).
- Each test makes its own rows (`tests/factories/core.ts`; add module factories in `tests/factories/<module>.ts`).
- Never call external APIs from tests (Telegram, Expo, OSRM): pass a fake `fetchImpl`.
- Run one file: `pnpm exec vitest run --project unit path` or `--project db path`.

## Commits
- Atomic, `feat(<task>): …` / `fix(<task>): …`, ending with the Co-Authored-By line you were given.
