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

### Wallet login is server-side only, for now

`/auth/wallet` has no browser half yet. The arena verifies wallet ownership per
match on its own (`server/arena/auth.ts`), so nobody needs wallet login to
stake, and a sign-in entry point would change a player's persistentID
mid-session. The message a wallet signs to log in uses a **different prefix**
from the per-match one (`core/arena/authMessage.ts`) so the two signatures can
never be interchanged; `tests/server/AuthService.test.ts` asserts that a
per-match signature is refused as a login.

### Local development

`npm run dev` is unchanged — it still uses the anonymous persistentID path.
`npm run dev:auth` runs the client, the game server and the auth service
together, which is how a real JWT session (and therefore a real `jti` for the
arena's wallet-signature nonce) gets exercised locally.
