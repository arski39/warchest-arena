import {
  connectWallet,
  getConnectedWallet,
  type WalletAdapter,
} from "./WalletProvider";

// Must match server: src/server/arena/auth.ts AUTH_PREFIX
const AUTH_PREFIX = "OpenFront Arena\nAuth: ";

export interface WalletAuthResult {
  walletAddress: string;
  walletSig: string; // base64 ed25519 signature over authMessage(jti)
}

/**
 * Extracts the `jti` claim from a JWT token string (without verifying the
 * signature — the server does that; we just need the payload for the nonce).
 */
function extractJti(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const payload = JSON.parse(atob(parts[1]!)) as Record<string, unknown>;
  if (typeof payload.jti !== "string") throw new Error("JWT missing jti claim");
  return payload.jti;
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
 * Signs the canonical auth message for the given JWT token using the
 * connected Solana wallet.  Prompts the user to connect if not already done.
 */
export async function signAuthMessage(
  token: string,
): Promise<WalletAuthResult> {
  let wallet: WalletAdapter;
  const existing = getConnectedWallet();
  if (existing) {
    wallet = existing;
  } else {
    wallet = await connectWallet();
  }

  const jti = extractJti(token);
  const message = new TextEncoder().encode(AUTH_PREFIX + jti);
  const sigBytes = await wallet.signMessage(message);
  return {
    walletAddress: wallet.publicKey,
    walletSig: toBase64(sigBytes),
  };
}
