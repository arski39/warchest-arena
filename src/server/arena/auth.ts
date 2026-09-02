import type { TokenPayload } from "../../core/ApiSchemas";
import { authMessage, devAuthNonce } from "../../core/arena/authMessage";
import { verifyEd25519Signature } from "../../core/arena/walletSignature";
import { devBypassEnabled, logBypassUse } from "./devBypass";

/**
 * Returns true when the wallet identified by walletAddress (base58) signed
 * the canonical auth message containing nonce, and the signature (base64) is valid.
 *
 * The verification itself moved to core/arena/walletSignature.ts when the auth
 * service's wallet login became a second caller — this is now only the choice
 * of which message is being proved.
 */
export function verifyWalletSig(
  nonce: string,
  walletAddress: string,
  sigBase64: string | undefined,
): boolean {
  return verifyEd25519Signature(authMessage(nonce), walletAddress, sigBase64);
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
