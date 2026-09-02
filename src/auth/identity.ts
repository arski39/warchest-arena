// [ARENA] new file — how a session gets its identity, without a database.
//
// The auth service keeps no state. A guest's identity lives in their refresh
// cookie; a wallet's is *derived* from the address, so the same wallet is the
// same player on every device and after every restart, with nothing stored.
import { createHash, randomUUID } from "crypto";
import { base64url } from "jose";

/** Domain separators. Changing one renames every identity it derives. */
const WALLET_USER_NS = "openfront-arena:wallet-user:v1:";
const PUBLIC_ID_NS = "openfront-arena:public-id:v1:";

/**
 * Format 16 bytes as a UUID string, forcing version 8 (RFC 9562 "custom") and
 * the RFC variant. PersistentIdSchema is `z.uuid()`, and a raw hash slice is
 * not guaranteed to satisfy it -- the two nibbles cost nothing and make every
 * derived id a well-formed UUID by construction.
 */
function formatUuid(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Buffer.from(b).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** A fresh anonymous identity. Only ever created by /auth/refresh. */
export function guestUserId(): string {
  return randomUUID();
}

/**
 * The player id for a wallet. Deterministic, so a wallet logging in from a
 * second browser is the same player -- which is the whole point of wallet
 * login, and the only way to get it without a users table.
 *
 * One-way on purpose: this value becomes the persistentID, which Auth.ts marks
 * "DO NOT EXPOSE". Deriving it from the address rather than storing a mapping
 * means the reverse lookup does not exist to leak.
 */
export function walletUserId(walletAddress: string): string {
  const digest = createHash("sha256")
    .update(WALLET_USER_NS + walletAddress)
    .digest();
  return formatUuid(digest);
}

/**
 * The public identifier /users/@me reports. Distinct from the persistentID and
 * derived from it one-way, because publicId is shown to other players and the
 * persistentID must never be recoverable from it.
 */
export function publicIdFor(userId: string): string {
  const digest = createHash("sha256")
    .update(PUBLIC_ID_NS + userId)
    .digest();
  return base64url.encode(digest.subarray(0, 12));
}
