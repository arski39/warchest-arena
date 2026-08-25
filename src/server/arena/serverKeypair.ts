// [ARENA] new file — single source for the server's ed25519 keypair.
//
// The same key must be used in three places or settlement breaks:
//   * `create_match`'s `authority`   (matchCreator.ts)
//   * the ed25519 signature over the result digest (settler.ts)
//   * `settle_match`'s expected signer, which the program reads back out of
//     `match_account.authority`
//
// Loading it in one place is what keeps those three in step.

import { Keypair } from "@solana/web3.js";
import fs from "fs";

let cached: Keypair | null = null;

/** Path to a Solana CLI keypair file (a JSON array of 64 bytes). */
export function serverKeypairPath(): string | undefined {
  return process.env.SERVER_KEYPAIR_PATH;
}

/**
 * Throws if SERVER_KEYPAIR_PATH is unset or does not hold a 64-byte secret key.
 * Callers that must degrade gracefully should check `serverKeypairPath()` first.
 */
export function serverKeypair(): Keypair {
  if (cached !== null) return cached;

  const path = serverKeypairPath();
  if (!path) {
    throw new Error("SERVER_KEYPAIR_PATH env var not set");
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error(
      `SERVER_KEYPAIR_PATH must contain a 64-byte JSON array, got ${
        Array.isArray(parsed) ? `${parsed.length} bytes` : typeof parsed
      }`,
    );
  }
  cached = Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  return cached;
}
