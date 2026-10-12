import { createHash } from "crypto";
import type { TokenPayload } from "../../core/ApiSchemas";
import { authMessage, devAuthNonce } from "../../core/arena/authMessage";
import {
  walletUserIdFromDigest,
  walletUserIdPreimage,
} from "../../core/arena/walletIdentity";
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
 * [ARENA] True when the session is a wallet login for `walletAddress`, which
 * proves control of that wallet as well as a per-match signature would -- so a
 * wallet-signed-in player stakes with one wallet prompt instead of two.
 *
 * The proof is the login itself: the auth service mints `provider: "wallet"`
 * only after verifying a signature over walletLoginMessage(), and derives the
 * `sub` from the address that signed. The token's own signature has already
 * been checked by verifyClientToken, so recomputing the id from the claimed
 * address and comparing is the whole check. Both halves are required: the
 * provider claim alone says nothing about *which* wallet, and the `sub` alone
 * is not what the issuer attests it verified a signature for.
 *
 * What it gives up against the per-match signature is freshness: that proved
 * control within one 15-minute access token, this proves it at login. Whoever
 * holds the session already *is* that player everywhere else in the game, and
 * a payout goes to the wallet, never to the session.
 */
export function sessionIsWalletLogin(
  claims: TokenPayload | null,
  walletAddress: string,
): boolean {
  if (claims?.provider !== "wallet") return false;
  const digest = createHash("sha256")
    .update(walletUserIdPreimage(walletAddress))
    .digest();
  return claims.sub === walletUserIdFromDigest(digest);
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
