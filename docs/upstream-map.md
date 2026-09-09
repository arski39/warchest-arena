# OpenFront Upstream Map (v0.33.10)

Reference doc for the OpenFront Arena wagering integration. Update whenever you
discover new internals. Mark any upstream file you edit with `// [ARENA]`.

---

## Entry Points

| Layer            | File                   | Notes                                            |
| ---------------- | ---------------------- | ------------------------------------------------ |
| Server bootstrap | `src/server/Server.ts` | Node cluster: master + N workers                 |
| Master process   | `src/server/Master.ts` | HTTP server on port 3000                         |
| Worker process   | `src/server/Worker.ts` | WebSocket server, game dispatch                  |
| Client bootstrap | `src/client/Main.ts`   | loaded by `index.html` line 472                  |
| Build tool       | `vite.config.ts`       | Vite, entry `/src/client/Main.ts`, out `static/` |
| Dev run          | `npm run start:client` | Vite dev server on port 9000                     |

---

## Match Lifecycle

### Creation

- **`src/server/GameManager.ts` lines 68–112** — `createGame()` instantiates
  `GameServer` and stores it in `games: Map<GameID, GameServer>`.

### Joining

- **`src/server/GameServer.ts` ~line 980** — `GameServer.joinClient()` returns
  `"joined" | "kicked" | "rejected" | "not_allowlisted" | "not_found"`.
- **`src/server/WorkerLobbyService.ts`** — routes WebSocket upgrade to the right game.
- **`src/client/ClientGameRunner.ts` lines 113–143** — client-side: `joinLobby()` →
  `transport.joinGame()`.

### Phase transitions

```
GamePhase.Lobby → Active → Finished
```

- Managed in `GameManager.tick()` lines 137–162.
- `game.prestart()` then `game.start()` moves Lobby → Active.
- `GamePhase.Finished` detected by manager triggers cleanup.

---

## Game Tick / Simulation Loop

- **Server tick:** `GameServer.ts` line 1397 — `setInterval(() => this.endTurn(), TICK_INTERVAL)`.
- Each tick bundles intents into a `Turn { turnNumber, intents: StampedIntent[] }` and
  broadcasts a `ServerTurnMessage` to all clients.
- **Client-side simulation:** `src/core/GameRunner.ts` lines 137–150 —
  `executeNextTick()` runs the deterministic sim in a Web Worker.
- The simulation is **client-authoritative / deterministic with server turn feed**.
  The server does NOT run a physics/game loop — it only batches intents.

---

## Match End — Settlement Hook (CRITICAL)

### Winner detection (client-side, deterministic)

- **`src/core/execution/WinCheckExecution.ts`** — runs every 10 ticks.
  - FFA: last player above tile-% threshold, OR time limit.
  - Team: last team with living players, OR tile-% threshold.
  - Calls `game.setWinner(player | team, stats)` when condition met.

### Consensus vote (server-side)

1. Each client independently detects the winner and sends:
   ```ts
   ClientSendWinnerMessage = {
     type: "winner",
     winner: Winner, // ["player", ClientID] | ["team", Team] | undefined
     allPlayersStats: AllPlayersStats, // Record<ClientID, PlayerStats>
   };
   ```
   Schema in `src/core/Schemas.ts` lines 881–885.
2. Server collects votes in `VoteRound<ClientSendWinnerMessage>` (majority by IP weight).
3. Consensus reached → **`GameServer.archiveGame()`** (line 2208) — **this is our hook**.

### archiveGame() payload

```ts
GameEndInfo = GameStartInfo & {
  players: PlayerRecord[],
  start: number, end: number, duration: number,
  num_turns: number,
  winner: Winner,           // the consensus winner
  lobbyFillTime: number,
}
```

`GameEndInfo` schema: `src/core/Schemas.ts` lines 992–1000.

### Our integration point

Add an async call **inside `archiveGame()`** (or immediately after):

```ts
// [ARENA] — in GameServer.ts archiveGame()
await arenaSettler.settle(this.gameID, endInfo);
```

`arenaSettler` lives in `src/server/arena/settler.ts` (our file — no upstream edits
beyond the single call site injection).

---

## Player Identity Model

| ID             | Type     | Scope          | Notes                                        |
| -------------- | -------- | -------------- | -------------------------------------------- |
| `ClientID`     | `string` | Per-connection | Reset on reconnect; key in `allPlayersStats` |
| `persistentID` | `string` | Per-user       | Survives reconnects; JWT sub or opaque token |
| `PlayerID`     | `string` | Per-game       | Internal sim ID, generated via seeded PRNG   |

**For wagering**, `persistentID` is the natural wallet-mapping key:

- Store `{ persistentID → walletPubkey }` after SIWS verification.
- `allPlayersStats` (winner vote payload) is keyed by `ClientID`, but
  `GameServer` can translate via `allClients` map.

**Client object** (`src/server/Client.ts` lines 6–30):

```ts
class Client {
  clientID: ClientID;
  persistentID: string;
  claims: TokenPayload | null; // JWT
  username: string;
  ws: WebSocket;
  spectator: boolean;
}
```

---

## Divergence from upstream — what a merge will touch

Regenerate this list with:

```bash
grep -rln "\[ARENA\]" src/ index.html tests/ resources/ | grep -v "/arena/" | sort
```

### Files we own outright (absent upstream — merges never conflict)

```
src/auth/           AuthServer.ts, AuthEnv.ts, AuthLogger.ts, http.ts,
                    identity.ts, routes.ts, signingKey.ts, tokens.ts,
                    userMe.ts        <- the whole directory is ours (H4)
src/core/arena/     arenaProgram.ts (bindings, decoder, ix builders),
                    authMessage.ts, walletSignature.ts
src/server/arena/   auth.ts, devBypass.ts, matchCreator.ts, matchRegistry.ts,
                    preflight.ts, rpcClient.ts, serverKeypair.ts, settler.ts,
                    sweeper.ts, walletRegistry.ts
src/client/arena/   WagerLobby.ts, WalletProvider.ts, onchainJoin.ts,
                    wagerJoinFlow.ts, walletAuth.ts
scripts/            generateAuthKey.ts
tests/              ArenaWalletAuth.test.ts, server/ArenaDevBypass.test.ts,
                    server/ArenaPreflight.test.ts, server/ArenaStartGate.test.ts,
                    server/ArenaSweeper.test.ts, server/AuthService.test.ts,
                    server/AppShellBranding.test.ts
docs/               branding.md, this file
```

`src/auth/` is a **separate process in a separate container** and must never
import `src/server/` — `ServerEnv` throws for vars it has no business setting
(`NUM_WORKERS`, `GIT_COMMIT`, `TURNSTILE_SITE_KEY`) and `server/Logger.ts` wires
OpenTelemetry at import time. It shares only `src/core/` with the game, which is
the point: `TokenPayloadSchema` and `UserMeResponseSchema` are literally the
same module on both ends of the contract.

### Upstream files we edit (every edit marked `// [ARENA]`)

The original plan here said "1 line in GameServer.ts". That has not been true
since Stage 2 — this is the real list. Counts are `[ARENA]` markers, not lines.

| File                               | Marks | What we changed                                                                                                                                                                                                                    |
| ---------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/Worker.ts`             |    10 | wagered-join gate, `POST /:id/wager` (+ stake cap), wager info on `GET /:id`, listing/wager mutual exclusion, boot `resolveDevBypass()` + `runWagerPreflight()`                                                                    |
| `src/server/GameServer.ts`         |    10 | settle hook in `archiveGame()`; wagered start-gate in `toggle_game_start_timer`; `cancelUnfilledWageredMatch()`; refund in `end()`'s not-started branch; `kick_reason.wager_not_full`; `maxGameDuration` from the hoisted constant |
| `src/client/HostLobbyModal.ts`     |     9 | host stake control, `handleAttachWager`, `join-lobby` re-dispatch                                                                                                                                                                  |
| `src/server/Master.ts`             |     6 | AGPL source-URL boot warning; `resolveDevBypass()` before the app shell renders; `runWagerPreflight()` + `startSweeper()` after the fork loop                                                                                      |
| `src/client/Main.ts`               |     5 | lazy `wagerJoinFlow` gate in the join funnel (keep the dynamic import — static costs ~294 kB in the main chunk)                                                                                                                    |
| `src/core/Schemas.ts`              |     4 | wallet fields on `ClientJoinMessage`; `MAX_GAME_DURATION_MS` hoisted out of `GameServer`'s private field so the sweeper can derive its window from it                                                                              |
| `src/client/ClientEnv.ts`          |     4 | `sourceRepoUrl()` with the empty-string fallback; `arenaDevBypass()`                                                                                                                                                               |
| `src/client/Api.ts`                |     4 | `fetchLobbyWager`                                                                                                                                                                                                                  |
| `src/server/ServerEnv.ts`          |     4 | `siteOrigin()`, `siteName()`, `sourceRepoUrl()`, `warnIfSourceRepoUnset()`; `JwksSchema` exported so the auth suite pins the real schema instead of a copy                                                                         |
| `src/server/RenderHtml.ts`         |     3 | those three vars plus `arenaDevBypass`; logos repointed off the removed proprietary PNGs                                                                                                                                           |
| `src/client/ClientGameRunner.ts`   |     3 | `wager_lobby_not_full` and `kick_reason.wager_not_full` handling                                                                                                                                                                   |
| `src/core/configuration/Config.ts` |     2 | `sourceRepoUrl` and `arenaDevBypass` on `BOOTSTRAP_CONFIG`                                                                                                                                                                         |
| `index.html`                       |     2 | ads/analytics removed; canonical/og from `siteOrigin`/`siteName`; `sourceRepoUrl`/`arenaDevBypass` in BOOTSTRAP_CONFIG                                                                                                             |
| `src/server/GameManager.ts`        |     1 | `cancelUnfilledWageredMatch()` in `tick()`                                                                                                                                                                                         |
| `src/client/components/Footer.ts`  |     1 | source link from `ClientEnv.sourceRepoUrl()`                                                                                                                                                                                       |
| `src/client/Transport.ts`          |     1 | wallet fields threaded into the join message                                                                                                                                                                                       |

### Non-TypeScript upstream files we edit

These carry no `// [ARENA]` marker (shell, JSON, dotfiles), so they are listed
rather than counted. All are merge targets.

| File           | What we changed                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy.sh`    | the fixed env heredoc gained every `ARENA_*` / `SOLANA_*` / `AUTH_*` var — it is a literal list, so an unlisted var never reaches the container                                                     |
| `update.sh`    | read-only bind mounts for the arena authority keypair and the auth signing key; `SERVER_KEYPAIR_PATH` appended; `RESTART=always` forced when wagering is on; the second container for `api.$DOMAIN` |
| `package.json` | `start:auth`, `start:auth-dev`, `dev:auth`                                                                                                                                                          |
| `example.env`  | the arena and auth blocks                                                                                                                                                                           |
| `.gitignore`   | `.keys/`, `*signing-key*.json`, `*keypair*.json`                                                                                                                                                    |

### Deletions

**The cosmetics storefront is deleted** — `src/client/Store.ts`,
`src/client/components/CustomCurrencyCard.ts`, `components/TribesPanel.ts` and
`components/TribeStatsView.ts`, plus the `<store-modal>` mount in `index.html`,
both nav entries, the store notification dot, the `#affiliate=` deep link and
the three Stripe `#purchase-completed` branches. This deployment sells nothing:
`/cosmetics.json` serves an empty catalogue and every purchase endpoint 404s,
and `Store.ts` linked to `merch.openfront.io` — upstream's shop, from a fork.
**An upstream merge re-adding any of these four files is a reject, not a
restore.** Cosmetic _rendering_ is untouched and still works; only the place
that sold them is gone. `tests/client/NavBarEntries.test.ts` pins the nav.

**The Clans nav entry is hidden, the code is not deleted** — the `16d94b9`
treatment given to Ranked. `ClanModal.ts`, `ClanApi.ts`,
`src/core/ClanApiSchemas.ts`, `components/clan/*` and all ~10 clan test files
are byte-unchanged and still reachable at `#modal=clan`, so restoring the
feature is putting the button back plus one `main.clans` string. The clan tag
pipeline (`UsernameInput`, `formatPlayerDisplayName`, `PlayerRow`,
`TeamAssignment`, `disableClanTags`) is untouched and working.

`proprietary/`'s assets are removed (All Rights Reserved — see `branding.md`).
The directory, its `LICENSE` and the build plumbing stay, so an upstream merge
that touches proprietary assets will show as re-adds to reject. Placeholders sit
at the same paths under `resources/`, deliberately keeping upstream's file names
so no client code diverges.

---

## Integration Shape Recommendation

**Option A — monorepo fork (chosen)**

Reason: OpenFront is not published as an npm package; patching individual
server/client files is unavoidable. Vite + TypeScript build tooling is standard
and fully supports adding packages alongside the existing `src/` tree.
Our code lives in `src/server/arena/` and `src/client/arena/` — easy to rebase
upstream changes since those directories don't exist in upstream.

Option B (separate repo importing upstream as package) is not viable without
publishing OpenFront to npm or using git submodules, which adds complexity with
no benefit at this stage.
