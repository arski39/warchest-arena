import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { TokenPayload } from "../../core/ApiSchemas";
import { authMessage, devAuthNonce } from "../../core/arena/authMessage";
import { GameEnv } from "../../core/configuration/Config";
import { ServerEnv } from "../ServerEnv";

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
 * Prefers the JWT's `jti`. Falls back to the game id **in dev only**, where
 * anonymous sessions have no JWT and therefore no `jti` — see devAuthNonce.
 * This mirrors the dev bypass already applied to the on-chain membership check
 * a few lines below the caller, and the one in jwt.ts that lets a raw
 * persistentID stand in for a token in the first place.
 */
export function walletAuthNonce(
  claims: TokenPayload | null,
  gameId: string,
): string | undefined {
  if (claims?.jti) return claims.jti;
  if (ServerEnv.env() === GameEnv.Dev) return devAuthNonce(gameId);
  return undefined;
}
