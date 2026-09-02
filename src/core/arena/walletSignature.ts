// [ARENA] new file — the one ed25519 verification the arena does.
//
// Extracted from server/arena/auth.ts when the auth service gained a second
// caller. Two messages are signed by a player's wallet in this project -- the
// per-match one (authMessage) and the login one (walletLoginMessage) -- and
// they must be verified identically, right down to the realm-safe copies
// below. A second hand-rolled copy of this is the kind of thing that stays
// correct for exactly as long as nobody edits either.
//
// Lives in core/arena rather than server/ so src/auth can use it without
// importing the game server, which would drag in ServerEnv and its env
// contract. Same reason arenaProgram.ts lives here.
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import nacl from "tweetnacl";

/**
 * True when `walletAddress` (base58) produced `sigBase64` over `message`.
 *
 * Uint8Array.from on each argument: tweetnacl type-checks with instanceof,
 * which is false for an array from another JS realm -- and the catch below
 * would turn that into a plain "invalid signature" rather than the bug it is.
 * Node's TextEncoder is same-realm, but jsdom's is not, so without this the
 * function cannot be tested against the client half at all.
 */
export function verifyEd25519Signature(
  message: string,
  walletAddress: string,
  sigBase64: string | undefined,
): boolean {
  if (!sigBase64) return false;
  try {
    const messageBytes = Uint8Array.from(new TextEncoder().encode(message));
    const pubkeyBytes = Uint8Array.from(new PublicKey(walletAddress).toBytes());
    const sigBytes = Uint8Array.from(Buffer.from(sigBase64, "base64"));
    return nacl.sign.detached.verify(messageBytes, sigBytes, pubkeyBytes);
  } catch {
    // Reached for a malformed address or base64 payload -- both are ordinary
    // bad input from an untrusted client, not an error worth propagating.
    return false;
  }
}
