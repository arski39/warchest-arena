import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

/** Signed by the client wallet over "OpenFront Arena\nAuth: {jti}" using signMessage. */
const AUTH_PREFIX = "OpenFront Arena\nAuth: ";

/**
 * Returns true when the wallet identified by walletAddress (base58) signed
 * the canonical auth message containing jti, and the signature (base64) is valid.
 */
export function verifyWalletSig(
  jti: string,
  walletAddress: string,
  sigBase64: string | undefined,
): boolean {
  if (!sigBase64) return false;
  try {
    const message = new TextEncoder().encode(AUTH_PREFIX + jti);
    const pubkeyBytes = new PublicKey(walletAddress).toBytes();
    const sigBytes = new Uint8Array(Buffer.from(sigBase64, "base64"));
    return nacl.sign.detached.verify(message, sigBytes, pubkeyBytes);
  } catch {
    return false;
  }
}

/** Canonical message the client wallet must sign for authentication. */
export function authMessage(jti: string): string {
  return AUTH_PREFIX + jti;
}
