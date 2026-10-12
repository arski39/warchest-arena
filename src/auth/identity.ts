// [ARENA] new file — how a session gets its identity, without a database.
//
// The auth service keeps no state. A guest's identity lives in their refresh
// cookie; a wallet's is *derived* from the address, so the same wallet is the
// same player on every device and after every restart, with nothing stored.
import { createHash, randomUUID } from "crypto";
import { base64url } from "jose";
import {
  walletUserIdFromDigest,
  walletUserIdPreimage,
} from "../core/arena/walletIdentity";

/** Domain separator. Changing it renames every public id it derives. */
const PUBLIC_ID_NS = "openfront-arena:public-id:v1:";

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
 *
 * The derivation lives in core/arena/walletIdentity.ts because the game server
 * and the browser recompute it to recognise a wallet session for an address.
 */
export function walletUserId(walletAddress: string): string {
  const digest = createHash("sha256")
    .update(walletUserIdPreimage(walletAddress))
    .digest();
  return walletUserIdFromDigest(digest);
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
