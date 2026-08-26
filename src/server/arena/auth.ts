import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { TokenPayload } from "../../core/ApiSchemas";
import { authMessage, devAuthNonce } from "../../core/arena/authMessage";
import { devBypassEnabled, logBypassUse } from "./devBypass";

/**
 * Returns true when the wallet identified by walletAddress (base58) signed
 * the canonical auth message containing nonce, and the signature (base64) is valid.
 */
export function verifyWalletSig(
  nonce: string,
  walletAddress: string,
  sigBase64: string | undefined,
): boolean {
  if (!sigBase64) return false;
  try {
    // Uint8Array.from on each argument: tweetnacl type-checks with instanceof,
    // which is false for an array from another JS realm — and the catch below
    // would turn that into a plain "invalid signature" rather than the bug it
    // is. Node's TextEncoder is same-realm, but jsdom's is not, so without this
    // the function cannot be tested against the client half at all.
    const message = Uint8Array.from(
      new TextEncoder().encode(authMessage(nonce)),
    );
    const pubkeyBytes = Uint8Array.from(new PublicKey(walletAddress).toBytes());
    const sigBytes = Uint8Array.from(Buffer.from(sigBase64, "base64"));
    return nacl.sign.detached.verify(message, sigBytes, pubkeyBytes);
  } catch {
    // Reached for a malformed address or base64 payload — both are ordinary
    // bad input from an untrusted client, not an error worth propagating.
    return false;
  }
}

/**
 * [ARENA] The nonce this session's wallet signature must cover, or undefined if
 * the session cannot produce one and the join must be refused.
 *
 * Prefers the JWT's `jti`, which binds the signature to one login session.
 * Falls back to the game id only when the dev bypass is in force — anonymous
 * dev sessions have no JWT and therefore no `jti` (see devAuthNonce), so
 * without the fallback the wagered path cannot be exercised locally at all.
 * What the fallback gives up is the session binding, which is exactly why it
 * is gated rather than free.
 *
 * Gated on devBypassEnabled(), not `GameEnv.Dev`: being in dev is no longer
 * sufficient, because a dev server pointed at a real cluster could otherwise
 * seat unpaid players in a match that settles for real tokens.
 */
export function walletAuthNonce(
  claims: TokenPayload | null,
  gameId: string,
): string | undefined {
  if (claims?.jti) return claims.jti;
  if (devBypassEnabled()) {
    logBypassUse("wallet-auth nonce", gameId);
    return devAuthNonce(gameId);
  }
  return undefined;
}
