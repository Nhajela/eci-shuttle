# ECI Shuttle 🚌

Live shuttle tracking for [Edge City India 2026](https://eci-shuttle.positivesumcompany.com) (Mandrem, Goa, 11 Oct – 1 Nov).
Attendees pick their stop and see where the shuttle is and when it reaches them. Drivers' phones report GPS, the server
decides when phones track, and ops run everything from an admin site, a Telegram bot, or an AI agent over MCP.

- **Live:** https://eci-shuttle.positivesumcompany.com
- **Bot:** [@eci_shuttles_bot](https://t.me/eci_shuttles_bot): `/start` for updates on your stop
- **Status:** built for one event and running it. Ideas and bugs are welcome as issues.

## What's in the box

| Part | Where | What it does |
|---|---|---|
| Web | `apps/web` | Next.js 15 site: public page + 3D map, phone-first admin, Telegram webhook, MCP server (`/api/mcp`, OAuth) |
| Worker | `apps/worker` | Same image with `ROLE=worker`: watchdog, service windows, arrival alerts, notice and push queue, nightly learning |
| Driver app | `apps/driver` | Expo (Android) app: pairing, GPS, server-controlled modes, over-the-air updates. iPhones use Telegram live location or Traccar |
| Shared | `packages/shared` | Contracts, schedule maths, IST time helpers |

Postgres with Drizzle holds everything. Every change goes through one service layer and writes one audit-log row.
The public side never shows lateness: it says where the shuttle is, calmly. Design notes live in [`docs/`](docs):
[SPEC](docs/SPEC.md) (the design), [OVERVIEW](docs/OVERVIEW.md) (what exists), [CONTRACTS](docs/CONTRACTS.md) (code layout
and ownership), [RESUME](docs/RESUME.md) (operating notes).

## Drivers' phones

Each vehicle has one phone sharing its location. **Android:** install the driver app (`apps/driver`) and pair it with a
code or QR. **iPhone:** no app needed, share Telegram live location with the bot (`/pair <code>` first); the Traccar
Client app also works as a backup.

## Run it locally

You need Node 22+, pnpm, and Docker (for Postgres).

```sh
pnpm install
docker compose -f docker-compose.dev.yml up -d     # Postgres on 127.0.0.1:5548
cp apps/web/.env.example apps/web/.env.local       # fill in SESSION_SECRET and TOKEN_SECRETS (random strings)
pnpm dev                                           # web + worker
```

Telegram is optional: leave `TELEGRAM_BOT_TOKEN` empty and the bot stays off. To try it with fake shuttles driving the
route, see `pnpm sim`. Tests:

```sh
pnpm test-db        # throwaway Postgres for tests (port 5547)
pnpm test           # unit + database tests
pnpm typecheck && pnpm lint
```

## Make it yours (another event, another route)

Stops, routes, services, vehicles and staffing are data, not code: set them up in the admin site (or over MCP), then
pair a phone per vehicle. You'll need your own Telegram bot (via @BotFather), a Postgres, and, for the Android driver
app, your own Expo and Firebase projects (replace `apps/driver/google-services.json`, `eas.json` and the package id in
`app.config.ts`). Stop names, copy and art are Edge City India's; swap them freely.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Naman Hajela
