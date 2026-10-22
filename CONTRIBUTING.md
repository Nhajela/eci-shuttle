# Contributing to ECI Shuttle

Built in the open by people at Edge City India. Small, useful changes are the best kind.

## Ways to help
- **Use it and tell us.** Found a wrong ETA or a confusing screen? Open an issue with what you saw and when.
- **Pick something up.** Ideas are listed under "Ideas for later" in [docs/OVERVIEW.md](docs/OVERVIEW.md). Comment on an
  issue first so two people don't build the same thing.
- **Send a pull request.** Fork, branch, change, then `pnpm test && pnpm typecheck && pnpm lint`. We deploy `main`.

## Ground rules (full list in [CLAUDE.md](CLAUDE.md))
- **pnpm only**, Node 22+. Tests first: write the real test, watch it fail, then implement.
- **One service layer** (`apps/web/src/services`): roles and rules live there. Pages, API routes, the bot, MCP tools and
  worker jobs only parse input, call a service and map errors. Every write goes through `mutate()` (one audit-log row).
- **Pure logic takes `now` as a parameter.** Times shown to people are IST (`Asia/Kolkata`) via the helpers in
  `@eci-shuttle/shared`.
- **Attendees never see lateness.** No "late", no planned-vs-expected on public surfaces. Calm and truthful.
- **Phone first** (390px), tap targets at least 44px, no horizontal scroll.
- **Never commit secrets.** Configuration is environment variables (`apps/web/.env.example`). Tests never call Telegram,
  Expo or OSRM: pass a fake `fetchImpl`.
- Schema changes: `drizzle-kit generate` in `apps/web` and commit the SQL; never edit an applied migration.

By contributing you agree your work is released under the [MIT license](LICENSE).
