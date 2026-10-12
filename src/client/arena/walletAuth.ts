import { decodeJwt } from "jose";
import { authMessage, devAuthNonce } from "../../core/arena/authMessage";
import {
  walletUserIdFromDigest,
  walletUserIdPreimage,
} from "../../core/arena/walletIdentity";
import { base64urlToUuid } from "../../core/Base64";
import { ClientEnv } from "../ClientEnv";
import {
  connectWallet,
  getConnectedWallet,
  toBase64,
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
 * Signs the canonical auth message for this session with the connected Solana
 * wallet, prompting to connect first if needed.
 *
 * The nonce is the token's `jti`. Dev sessions are anonymous and have no JWT,
 * so there is no `jti` to bind to; the server accepts the game id instead when
 * its dev bypass is in force, and this mirrors that choice.
 *
 * It mirrors the server's **resolved** answer (`ClientEnv.arenaDevBypass()`),
 * not `env() === Dev`: the server additionally requires `ARENA_DEV_BYPASS` and
 * a cluster it can prove is not mainnet, so guessing from the client's own
 * environment would prompt the wallet for a signature that then gets rejected.
 * Without the bypass a missing `jti` is fatal, and failing here rather than
 * after the prompt means the player is not asked to sign something that cannot
 * be accepted.
 */
export async function signAuthMessage(
  token: string,
  gameId: string,
): Promise<WalletAuthResult> {
  const jti = extractJti(token);
  let nonce: string;
  if (jti !== null) {
    nonce = jti;
  } else if (ClientEnv.arenaDevBypass()) {
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

/** A wallet proven to belong to this session: by a signature, or by its login. */
export interface WalletProof {
  walletAddress: string;
  /** Absent when the session is a wallet login for `walletAddress`. */
  walletSig?: string;
}

/**
 * [ARENA] Whether `token` is a wallet login for `walletAddress` -- the client
 * mirror of the server's sessionIsWalletLogin(), over the same derivation in
 * core/arena/walletIdentity.ts.
 *
 * Only decides whether to *ask*; the server decides whether to accept. Wrong
 * in the "no" direction costs one extra prompt. It cannot be wrong in the
 * "yes" direction without the server disagreeing too, because both compare the
 * same `sub` against the same derived id.
 */
export async function isWalletLoginFor(
  token: string,
  walletAddress: string,
): Promise<boolean> {
  let userId: string;
  try {
    const payload = decodeJwt(token);
    if (payload.provider !== "wallet" || typeof payload.sub !== "string") {
      return false;
    }
    userId = base64urlToUuid(payload.sub);
  } catch {
    // Not a JWT (dev's bare persistentID), or a `sub` that does not decode.
    return false;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(walletUserIdPreimage(walletAddress)),
  );
  return userId === walletUserIdFromDigest(new Uint8Array(digest));
}

/**
 * Proves the connected wallet belongs to this session, prompting only when the
 * session cannot already vouch for it.
 *
 * A player signed in with the wallet they are staking from has proved control
 * of it once, at login, so the stake transaction is the only prompt. A guest,
 * or a player who signed in with one wallet and stakes from another, still
 * signs the per-match message.
 */
export async function proveWallet(
  token: string,
  gameId: string,
): Promise<WalletProof> {
  const wallet = getConnectedWallet() ?? (await connectWallet());
  if (await isWalletLoginFor(token, wallet.publicKey)) {
    return { walletAddress: wallet.publicKey };
  }
  return signAuthMessage(token, gameId);
}
