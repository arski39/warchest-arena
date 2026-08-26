// [ARENA] new file — the exact message a player's wallet signs to prove the
// wallet belongs to this session.
//
// Both halves of the handshake live here because they have to agree byte for
// byte: `client/arena/walletAuth.ts` signs it, `server/arena/auth.ts` verifies
// it. They previously each declared their own copy of the prefix with a "must
// match server" comment, which is the kind of thing that drifts silently and
// then fails as an unexplained invalid-signature rejection.

/** Prefix of the canonical auth message. */
const AUTH_PREFIX = "OpenFront Arena\nAuth: ";

/** The message the wallet signs, for a given nonce. */
export function authMessage(nonce: string): string {
  return AUTH_PREFIX + nonce;
}

/**
 * The nonce is normally the JWT's `jti`, which ties the signature to one login
 * session so it cannot be replayed by another.
 *
 * Local dev has no JWT at all: `getPlayToken()` falls back to the raw
 * persistentID and `verifyClientToken` returns `claims: null` for it (see
 * jwt.ts, which already special-cases exactly this in dev). With no `jti` there
 * is no nonce, so the wagered join path could not be exercised locally without
 * the closed-source auth API.
 *
 * The dev substitute is the game id. It is not secret and it is not PII —
 * unlike the persistentID, which the wallet would otherwise display in its
 * signing prompt — and it still binds the signature to one specific match.
 * What it does not bind is the session, which is the whole point of the
 * bypass and the reason it is refused outside dev.
 *
 * Both sides must choose this the same way: prefer `jti`, fall back to this
 * only when there is none *and* the environment is dev.
 */
export function devAuthNonce(gameId: string): string {
  return `dev-game:${gameId}`;
}
