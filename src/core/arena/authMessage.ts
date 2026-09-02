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

/** Prefix of the wallet *login* message. Deliberately different from
 * AUTH_PREFIX above: the two signatures prove different things and must not be
 * interchangeable. The per-match signature proves "this wallet is with this
 * session, for this match"; the login signature proves "this wallet is me" and
 * mints a session. Sharing a prefix would make a captured match signature a
 * candidate login and vice versa -- the nonces differ, but domain separation
 * is one line and does not depend on that staying true. */
const LOGIN_PREFIX = "OpenFront Arena\nLogin: ";

/**
 * The message a wallet signs to log in, for a server-issued challenge nonce.
 *
 * Lives here for the same reason authMessage() does: the browser builds it and
 * the auth service verifies it, and a byte of drift between them surfaces only
 * as an unexplained invalid-signature rejection.
 */
export function walletLoginMessage(nonce: string): string {
  return LOGIN_PREFIX + nonce;
}
