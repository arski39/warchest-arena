import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeMatchAccount,
  MatchStatus,
  type MatchAccountView,
} from "../../core/arena/arenaProgram";
import type { WagerConfig } from "./matchRegistry";

const connection = new Connection(
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  "confirmed",
);

/**
 * [ARENA] Reads and decodes the escrow's MatchAccount. Returns null when the
 * account does not exist yet; throws MatchAccountDecodeError if it exists but
 * is not a well-formed match owned by the program it was created under.
 */
export async function fetchMatchAccount(
  wager: WagerConfig,
): Promise<MatchAccountView | null> {
  const info = await connection.getAccountInfo(
    new PublicKey(wager.matchPDA),
    "confirmed",
  );
  if (info === null) return null;
  return decodeMatchAccount(
    info.data,
    info.owner,
    new PublicKey(wager.programId),
  );
}

// The joining client confirms its own join_match at "confirmed" before telling
// us about it, so one read is normally enough. But the browser may be talking
// to a different RPC than we are (ARENA_PUBLIC_RPC_URL), and a node that is
// briefly behind would make us reject a player who genuinely paid. A couple of
// short retries costs nothing on the happy path and turns a wrongly-kicked
// player into a slightly slower join.
const MEMBERSHIP_RETRIES = 3;
const MEMBERSHIP_RETRY_DELAY_MS = 400;

/**
 * [ARENA] Whether `walletAddress` is enrolled in the escrow — that is, whether
 * the program itself recorded the wallet in `players[]`, which it only does
 * after the entry fee has landed in the vault.
 *
 * This reads chain *state*, not a transaction. An earlier version only checked
 * that some confirmed transaction touched the match PDA, which any transaction
 * naming the account satisfies, including one that failed to stake or one sent
 * by somebody else entirely.
 */
export async function verifyOnchainMembership(
  wager: WagerConfig,
  walletAddress: string,
): Promise<boolean> {
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(walletAddress);
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < MEMBERSHIP_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, MEMBERSHIP_RETRY_DELAY_MS));
    }

    let match: MatchAccountView | null;
    try {
      match = await fetchMatchAccount(wager);
    } catch (e) {
      // A malformed or wrongly-owned account will not fix itself; retrying it
      // only delays the rejection.
      console.error(
        `[arena/rpcClient] match ${wager.matchPDA} did not decode: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return false;
    }
    if (match === null) continue; // not visible on this node yet

    // A settled or cancelled match has already paid out or refunded; letting
    // someone in on the strength of a stake that has been returned to them
    // would put an unfunded player in a wagered game.
    if (
      match.status !== MatchStatus.Open &&
      match.status !== MatchStatus.InProgress
    ) {
      return false;
    }
    // The escrow the registry points at must be the one the lobby advertised.
    // A mismatch means server state and chain state have diverged; refusing is
    // the only safe reading, since the stake may sit in a different pot.
    if (
      match.entryFee !== wager.entryFee ||
      match.mint.toBase58() !== wager.mint ||
      match.vault.toBase58() !== wager.vault
    ) {
      console.error(
        `[arena/rpcClient] match ${wager.matchPDA} does not match the registry entry`,
      );
      return false;
    }

    // players[] is populated only up to player_count, and only by the program
    // after token::transfer succeeded — so presence here is proof of payment.
    if (match.players.some((p) => p.equals(wallet))) return true;
  }
  return false;
}

export { connection };
