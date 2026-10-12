# Authentication & Authorization Flow

## Token Management

1. **Long-lived refresh token**: Stored as an HTTP-only cookie with a 30-day TTL
2. **Token exchange**: User sends refresh token to the API server, receives a short-lived JWT in return, and the refresh token is rotated
3. **JWT properties**:
   - 15-minute TTL (limits damage window if compromised)
   - Contains the persistentID
   - Stored in memory only (lost on page refresh)

## WebSocket Authorization

1. **WebSocket connection**: When user connects, server validates the JWT and creates a `clientID => persistentID` mapping, establishing that this client is authorized to act on behalf of this persistent identity

2. **Post-connection authorization**: Once WebSocket connection is established, no further token verification is needed. For actions like pause requests, simple ownership checks suffice.

## Key Insight

JWT verification happens once at WebSocket connection time. After that, the established mapping allows for lightweight authorization checks based on clientID rather than repeated token validation.

## Development Mode

When running the game in development, the API server is not active, so the game falls back to checking only persistentIDs for verification instead of JWTs. This is less secure, as stealing a persistentID means the attacker has indefinite control of the victim's account.

---

## [ARENA] This fork issues its own tokens

Everything above describes the contract. Upstream's implementation of it is a
closed-source Cloudflare Worker that is not in this repo, which meant this fork
could only ever run with `GAME_ENV=dev`: `verifyClientToken` refuses a bare
persistentID outside dev, `ServerEnv.jwkPublicKey()` throws with no JWKS to
fetch, and `Worker.ts` closes the socket when `/users/@me` fails.

`src/auth/` is the replacement. It runs as its own process in its own container
behind the same proxy at `api.$DOMAIN`, and honours the same contract: 15-minute
EdDSA access tokens, a 30-day httpOnly refresh cookie rotated on every exchange,
`iss` = `https://api.$DOMAIN` (or `http://localhost:8787`), `aud` = `$DOMAIN`,
and `sub` as a base64url-encoded UUID.

```
GET  /.well-known/jwks.json     the public key, in ServerEnv's JwksSchema shape
POST /auth/refresh              {jwt, expiresIn} + a rotated refresh cookie
GET  /users/@me                 bearer-authorised player record
GET  /auth/wallet/challenge     a signed, short-lived nonce
POST /auth/wallet               {walletAddress, challenge, signature} exchange
POST /auth/logout, /auth/revoke clear the cookie
GET  /cosmetics.json, /reserved_clan_tags   empty catalogues
POST /game/:id                  store a finished game's record (api key)
GET  /game/:id                  serve it back, as a replay
```

### It has no database, and that is a design choice

Upstream's API is backed by accounts, subscriptions, cosmetics and clans. This
fork has none of those, so every field `/users/@me` returns is either derived
from the session or an operator constant. That makes the service stateless:

- A **guest's** identity lives in the refresh cookie. `/auth/refresh` with no
  cookie mints a new guest rather than failing — it is the browser's only guest
  path (`Auth.ts` `doRefreshJwt` falls through to it), so a 401 there would
  leave a first-time visitor with no session at all. That is also why the route
  is rate limited: each cookieless call creates an identity.
- A **wallet's** identity is derived from the address, so the same wallet is the
  same player on every device with nothing stored — and, because the derivation
  is one-way, there is no reverse lookup from `publicId` to the persistentID to
  leak.
- The three token kinds are separated by **`aud`**, not by a hand-written check:
  access → `$DOMAIN`, refresh → `<issuer>/auth/refresh`, wallet challenge →
  `<issuer>/auth/wallet`. `jwtVerify` enforces the audience itself, so a refresh
  cookie replayed as a bearer token fails verification rather than depending on
  a guard someone might later drop.

**The limitation this buys, stated plainly:** with no store there is no
revocation list. `/auth/revoke` can only clear the cookie, so an access token
already issued stays valid for up to its 15-minute lifetime. Closing that gap
needs a denylist, which needs storage.

**One exception, and it is not session state:** the game-record store below
writes files. It holds no identity and nothing a token depends on, so the
statelessness above still holds for everything auth-shaped.

### The signing key

An Ed25519 private JWK, generated once:

```bash
npx tsx scripts/generateAuthKey.ts /opt/openfront/auth-signing-key.json
```

The service **refuses to boot** outside dev when `AUTH_SIGNING_KEY_PATH` is
unset, and never generates a key for a path that has none. A container minting a
fresh key on each start would invalidate every session on every deploy — and
because the game server caches the first JWKS response for the life of its
process, it would keep rejecting tokens until it too restarted. Rotation is
therefore a deliberate act that requires restarting the game server as well.

In dev an ephemeral key is generated instead and logged loudly; sessions end
with the process.

Deployed, the key arrives as a **read-only bind mount** (`AUTH_SIGNING_KEY` on
the host → `/run/secrets/auth-signing-key.json`), never as an env var — an env
var sits in `docker inspect`, in the deploy env file, in `ps`, and in any crash
dump that prints the environment. Before mainnet, move it off the box that holds
the arena authority key: one compromise should not be both.

### Wallet login is the sign-in

`client/arena/walletLogin.ts` is the browser half of `/auth/wallet`, and the
account modal's sign-in screen is the entry point. It replaced the inherited
Discord, Google and email buttons, all three of which navigated to endpoints
this service returns 404 for — it replaces only the JWT half of upstream's
closed API and has no OAuth backend to offer.

The message a wallet signs to log in uses a **different prefix** from the
per-match one (`core/arena/authMessage.ts`) so the two signatures can never be
interchanged. `tests/server/AuthService.test.ts` asserts that a per-match
signature is refused as a login; `tests/client/ArenaWalletLogin.test.ts` asserts
the client never produces one, verifying against this service's own verifier
rather than a copy of it. **Do not unify the prefixes.**

**Login is menu-only, and that is the whole answer to the objection that used to
block it.** Signing in swaps `sub`, hence the persistentID, hence any
`walletRegistry` binding and any in-flight `jti`-bound match signature. Rather
than reconciling that, `walletLogin()` refuses outright while
`document.body.classList` has `in-game` or the `.arena-wager-overlay` stake
prompt is open — at the menu there is nothing bound yet, so there is nothing to
reconcile. It reads the DOM rather than importing from `Main.ts`, which owns the
game lifecycle and would be a cycle.

Success reloads the page, like logout does: the identity has changed and every
cached view of it — `/users/@me`, the nav button, cosmetics — belongs to the
guest who no longer exists.

**Staking still does not require logging in.** The arena verifies wallet
ownership per match on its own (`server/arena/auth.ts`), so the guest path is
untouched and free play stays zero-click.

**But logging in removes a prompt from every wagered game.** The join gate
accepts a wallet login _for the staked address_ in place of the per-match
signature (`sessionIsWalletLogin`): it recomputes the address-derived id
(`core/arena/walletIdentity.ts`, shared with `identity.ts` and the browser) and
compares it with the token's `sub`, alongside `provider === "wallet"`. The stake
prompt makes the same comparison (`proveWallet`) and skips the message prompt,
so a signed-in player approves only the stake transaction. A guest, or a
player signed in as one wallet and staking from another, still signs. What this
gives up is freshness — control proved at login rather than within one access
token — and nothing else: whoever holds the session already _is_ that player,
and the payout goes to the wallet. Pinned and mutation-checked in
`tests/ArenaWalletLoginProof.test.ts`, including the derived id's exact value,
because changing `WALLET_USER_NS` would rename every wallet player.

`/users/@me` deliberately still reports `user: {}` — see `userMe.ts`. The wallet
is not surfaced there because every consumer of that block would then offer
account management this fork has no backend for.

### Local development

`npm run dev` is unchanged — it still uses the anonymous persistentID path.
`npm run dev:auth` runs the client, the game server and the auth service
together, which is how a real JWT session (and therefore a real `jti` for the
arena's wallet-signature nonce) gets exercised locally.

## `POST /join_verify` — the server half of Turnstile

Added by this fork. The widget always rendered and `src/server/JoinVerify.ts`
always POSTed here, but the endpoint lived in upstream's **closed** api worker,
so it 404'd and every join fell open. The token nothing checked was decoration.

**Contract** (upstream's, because the caller is an upstream file):

```
POST /join_verify        x-api-key: <API_KEY>
{ ip, token, username, clanTag }
-> { status: "approved", username, clanTag }
 | { status: "rejected", reason }
```

- **Registered only when `TURNSTILE_SECRET_KEY` is set.** Unset, the route does
  not exist and the old fail-open behaviour is unchanged. An endpoint that
  existed and approved everything would look like bot protection while being
  none, which is worse than a visible 404. The service logs which state it is in
  at boot.
- **A null token skips siteverify.** That is the contract, not a hole: a
  Turnstile token is single-use, so an already-admitted player reconnecting has
  none left to present. `planJoinVerify()` on the game server guarantees a
  _first_ join never arrives with a null token — forwarding one would be a full
  bypass. The `x-api-key` is what keeps this route reachable only by the game
  server.
- **Failures reject; they never approve.** A token is single-use, so a timeout
  is not retried — re-submitting can redeem an already-spent token and turn a
  hiccup into a hard rejection of a legitimate player. The fail-open decision
  belongs to `JoinVerify.ts`, which already treats a non-verdict as its own
  call.
- **The hostname is checked** against `DOMAIN` and its subdomains (plus
  localhost in dev). Defence in depth — the site key is already domain-scoped in
  the dashboard — but it catches a key shared with another property.
- **Names are not moderated.** Upstream's worker ran an LLM check and could
  return a rewritten username; this fork passes them through. The game server
  screens locally via `Censor.ts`. An `approved` here does not mean a name was
  vetted.

`tests/server/AuthTurnstile.test.ts` pins all of the above, and the hostname pin
and the reject path are mutation-checked.

## `/game/:id` — the game-record store

Upstream's API kept every finished game. Two callers were written against it:
`server/Archive.ts` POSTs the record when a game ends, and
`JoinLobbyModal.checkArchivedGame` GETs it when someone opens a finished game's
link, turning it into a replay. With no route here the POST died on the 8 kB
JSON limit (`error archiving game record: Request Entity Too Large`) and the GET
404'd, so no finished game could be replayed and **no record of a wagered match
was kept anywhere**. `src/auth/gameArchive.ts` is the missing half.

- **Opt-in via `GAME_ARCHIVE_DIR`.** Unset, neither route is registered and the
  behaviour is exactly the old one. The deploy sets it from `GAME_ARCHIVE`, a
  host directory mounted read-write, created and chowned to uid 1000 by
  `warchest.sh`. A directory the process cannot write fails the boot.
- **The write needs the api key, strictly** — a missing header is refused, not
  just a wrong one. **With `API_KEY` empty outside dev the POST is not
  registered at all**, because `apiKeyMissingOrWrong`'s "empty disables the
  check" would otherwise make it an anonymous, disk-filling write.
- **Write-once.** `link()` rather than `rename()`, so a second record for an id
  gets `409` and cannot replace the first. That, plus the key, is what stops
  anyone planting the replay behind a game id.
- **The record must be for the id it is filed under** (`info.gameID`), and the
  id must match the game-id regex before it becomes a filename.
- **Not validated against `GameRecordSchema`.** That schema's import graph
  reaches `resources/`. The game server `safeParse`s before sending, and
  `checkArchivedGame` parses what it reads.
- **Stored gzipped and served with `Content-Encoding: gzip`**, so a read never
  decompresses. `Cache-Control: immutable` is honest because of write-once.
- **Only this route has a large body limit** (50 MB). Every other route keeps
  the 8 kB ceiling, which a method+path check in front of the global parser
  preserves.

`tests/server/AuthGameArchive.test.ts`. The key check, the no-key refusal,
write-once and the id match are each mutation-checked.
