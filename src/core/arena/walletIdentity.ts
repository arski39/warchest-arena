// [ARENA] new file — the player id a wallet session is given, shared by the
// three places that have to agree on it.
//
// The auth service derives a wallet session's `sub` from the address
// (auth/identity.ts). The game server's join gate and the browser's stake
// prompt both now ask the reverse question -- "is this session a wallet login
// for *this* address?" -- by recomputing the same id and comparing it with the
// token's `sub`. One copy of the derivation, so the three cannot drift: a byte
// of difference would surface only as wallet sessions silently falling back to
// the per-match signature prompt.
//
// Imports nothing, like stakeTiers.ts, so the browser bundle can take it. The
// hashing is left to the caller for the same reason settleMessagePreimage()
// does: sha256 has no synchronous cross-realm implementation, so the server
// uses node's createHash and the browser uses crypto.subtle.

/** Domain separator. Changing it renames every wallet identity there is. */
const WALLET_USER_NS = "openfront-arena:wallet-user:v1:";

/** What is hashed (as UTF-8) to derive the player id for `walletAddress`. */
export function walletUserIdPreimage(walletAddress: string): string {
  return WALLET_USER_NS + walletAddress;
}

/**
 * The player id, from the sha256 of walletUserIdPreimage().
 *
 * Forces version 8 (RFC 9562 "custom") and the RFC variant: PersistentIdSchema
 * is `z.uuid()`, and a raw hash slice is not guaranteed to satisfy it -- the two
 * nibbles cost nothing and make every derived id a well-formed UUID by
 * construction.
 */
export function walletUserIdFromDigest(digest: Uint8Array): string {
  const b = Uint8Array.from(digest.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
