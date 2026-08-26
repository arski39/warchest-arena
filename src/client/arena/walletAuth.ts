import { authMessage, devAuthNonce } from "../../core/arena/authMessage";
import { GameEnv } from "../../core/configuration/Config";
import { ClientEnv } from "../ClientEnv";
import {
  connectWallet,
  getConnectedWallet,
  type WalletAdapter,
} from "./WalletProvider";

export interface WalletAuthResult {
  walletAddress: string;
  /** base64 ed25519 signature over authMessage(nonce). */
  walletSig: string;
}

/**
 * The `jti` claim of a JWT, or null if the token is not a JWT or carries no
 * `jti`. Null is an ordinary outcome, not an error: in dev `getPlayToken()`
 * returns a bare persistentID rather than a token.
 *
 * The signature is not checked here — the server does that. We only need the
 * payload for the nonce.
 */
function extractJti(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1]!)) as Record<string, unknown>;
    return typeof payload.jti === "string" ? payload.jti : null;
  } catch {
    return null;
  }
}

/**
 * base64 of raw bytes, without pulling in a Buffer polyfill. `Buffer` is a Node
 * global and is simply undefined in the browser, so the obvious
 * `Buffer.from(sig).toString("base64")` type-checks (via @types/node) and then
 * throws at runtime. btoa needs a binary string, hence the per-byte map.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Signs the canonical auth message for this session with the connected Solana
 * wallet, prompting to connect first if needed.
 *
 * The nonce is the token's `jti`. Dev sessions are anonymous and have no JWT,
 * so there is no `jti` to bind to; the server accepts the game id instead when
 * it is in dev, and this mirrors that choice. Outside dev a missing `jti` is
 * fatal, and failing here rather than after the wallet prompt means the player
 * is not asked to sign something that cannot be accepted.
 */
export async function signAuthMessage(
  token: string,
  gameId: string,
): Promise<WalletAuthResult> {
  const jti = extractJti(token);
  let nonce: string;
  if (jti !== null) {
    nonce = jti;
  } else if (ClientEnv.env() === GameEnv.Dev) {
    nonce = devAuthNonce(gameId);
  } else {
    throw new Error("Cannot verify this session: sign in to play for stakes.");
  }

  let wallet: WalletAdapter;
  const existing = getConnectedWallet();
  if (existing) {
    wallet = existing;
  } else {
    wallet = await connectWallet();
  }

  const message = new TextEncoder().encode(authMessage(nonce));
  const sigBytes = await wallet.signMessage(message);
  return {
    walletAddress: wallet.publicKey,
    walletSig: toBase64(sigBytes),
  };
}
