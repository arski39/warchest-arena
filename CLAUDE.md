# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run inst             # Install deps (uses npm ci --ignore-scripts — do NOT use npm install)
npm run dev              # Run client + server in dev mode with hot reload
npm run start:client     # Client only
npm run start:server-dev # Server only
npm run dev:auth         # Client + server + the fork's auth service (real JWTs)
npm run start:auth       # Auth service only (src/auth, see docs/Auth.md)
npm test                 # Run all tests (Vitest)
npm run test:coverage    # Tests with coverage
npm run lint             # Oxlint + ESLint
npm run lint:fix         # Oxlint + ESLint with auto-fix
npm run format           # Prettier
npm run build-prod       # Production build
```

**Run a single test file:**

```bash
npx vitest tests/YourTest.test.ts --run
npx vitest NationAllianceBehavior --run # match by name pattern
```

## Architecture

OpenFront.io is a real-time multiplayer territorial strategy game. There are four components:

1. **`src/core/`** — Deterministic game simulation. Pure TypeScript with **no external dependencies**. Must remain fully deterministic (seeded PRNG, no floating-point math). Runs in a Web Worker thread. All `src/core` changes **must** include tests.
2. **`src/client/`** — Rendering (Pixi.js/WebGL), UI (Lit web components + Tailwind CSS 4), WebSocket communication.
3. **`src/server/`** — Game coordination, intent relay, WebSocket management (Node.js/Express/ws).
4. **API** — Upstream's is a closed-source Cloudflare Worker handling auth, stats, cosmetics and monetization, and it is not in this repo. **This fork ships its own replacement for the auth half in `src/auth/`** — JWKS, `/auth/refresh`, `/users/@me` and wallet login, stateless, run as a second container at `api.$DOMAIN`. Everything else upstream's API served (matchmaking, leaderboards, clans, cosmetics catalogues, Stripe) is absent. **Most callers fail open; two do not, and both are now hidden from the menu rather than fixed** — Ranked (its queue 404s) and Clans. Clans is the instructive one: `/reserved_clan_tags` works fine, but `ClanModal`'s no-args path reads `/users/@me`'s deliberate `user: {}` as "not signed in", so it toasts, closes itself and redirects to the account page even for a wallet session. That is a shape mismatch, not an absent endpoint. Restoring clans needs a datastore, which `src/auth/` does not have by design. The clan **tag** (`[TAG] Name`) is a separate mechanism and works. The cosmetics **storefront** is deleted outright, since this deployment sells nothing. See `docs/Auth.md` and `docs/upstream-map.md`.

### Simulation Flow (Intent → Execution)

The game simulation runs **on each client**, not the server. The server only relays intents.

1. Player action → client creates an **Intent** → sent to server
2. Server bundles all intents for the tick into a **Turn** → relays to all clients
3. Client forwards Turn to the Core worker
4. Core creates an **Execution** for each intent
5. Core calls `executeNextTick()` — all executions run and mutate game state
6. Core sends **GameUpdates** back to client → client renders

Intents and all wire messages are Zod-validated schemas defined in `src/core/Schemas.ts`.

### CDN / Static Assets

The game server only serves `index.html` and the WebSocket. All other assets (JS bundle, images, maps, worker) come from a CDN bucket. `CDN_BASE` is an empty string in dev (falls back to same-origin) and a full origin (e.g. `https://cdn.example.com`) in production. It is set as both a Vite build-time variable and a server runtime env var.

## Key Files

| File                        | Purpose                                |
| --------------------------- | -------------------------------------- |
| `src/core/Schemas.ts`       | All intent/message types (Zod schemas) |
| `src/core/GameRunner.ts`    | Simulation orchestrator                |
| `src/core/game/GameImpl.ts` | Game state implementation              |
| `src/server/GameServer.ts`  | Main WebSocket server, game loop       |
| `src/server/Master.ts`      | Lobby and game registry                |
| `tests/util/Setup.ts`       | Test helper — creates test games       |
| `docs/Architecture.md`      | Architecture overview                  |
| `docs/Auth.md`              | JWT/auth flow                          |
| `docs/API.md`               | Public API endpoints                   |
| `vite.config.ts`            | Build config, CDN handling             |

## UI Text / i18n

All user-visible text must go through `translateText()` and have a corresponding entry added to `resources/lang/en.json`. Translations are managed via Crowdin. DO NOT modify any other translation files.

## Testing Patterns

Tests use a `setup()` helper from `tests/util/Setup.ts` that creates a full game instance with map data from `tests/testdata/maps/`. Write tests that exercise the core simulation directly — not mocks.

## Tech Stack

- **Bundler:** Vite + TypeScript 5.7
- **Rendering:** Pixi.js (WebGL)
- **UI Components:** Lit (LitElement) + Tailwind CSS 4
- **Audio:** Howler.js
- **Schemas/Validation:** Zod
- **Testing:** Vitest
- **Server:** Node.js, Express, ws (WebSocket)
