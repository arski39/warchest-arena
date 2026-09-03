import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeMatchAccount,
  MatchStatus,
  type MatchAccountView,
} from "../../core/arena/arenaProgram";
import type { WagerConfig } from "./matchRegistry";

// [ARENA] The endpoint is read on FIRST USE, not at import time, and that is
// load-bearing rather than stylistic.
//
// Server.ts calls dotenv.config() after its own imports. ESM evaluates the
// entire module graph before any statement in the entry file runs, so a
// module-level `new Connection(process.env.SOLANA_RPC_URL ?? ...)` here saw an
// unset variable in the MASTER process and silently fell back to devnet.
// Workers escaped it only because cluster.fork() hands them a process.env that
// dotenv has already populated.
//
// The symptom was quiet and misleading: the master's boot preflight reported
// the program "not deployed on this cluster" while both workers verified the
// same program 1.5s later. Preflight fails closed, so the master simply never
// started the H2 sweeper -- the one piece of recovery that is meant to survive
// a crash. It only bites env-file setups; a container passing real env vars
// has them before node starts.
//
// Deliberately NOT fixed by moving dotenv above the other imports in
// Server.ts: prettier reorders imports in this repo, so an ordering-dependent
// fix would be one `npm run format` away from silently coming back.
let cached: Connection | null = null;

export function getConnection(): Connection {
  cached ??= new Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  return cached;
}

/**
 * [ARENA] Reads and decodes the escrow's MatchAccount. Returns null when the
 * account does not exist yet; throws MatchAccountDecodeError if it exists but
 * is not a well-formed match owned by the program it was created under.
 */
export async function fetchMatchAccount(
  wager: WagerConfig,
): Promise<MatchAccountView | null> {
  const info = await getConnection().getAccountInfo(
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

export interface MembershipCheck {
  /** The wallet is recorded in `players[]` — proof the entry fee landed. */
  isMember: boolean;
  /**
   * The escrow as last read, when a well-formed one was visible. Returned even
   * when `isMember` is false: it is chain truth either way, and the caller
   * caches it to answer "is this lobby fully staked?" without a second RPC
   * from the synchronous start-gate path.
   */
  match: MatchAccountView | null;
}

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
): Promise<MembershipCheck> {
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(walletAddress);
  } catch {
    return { isMember: false, match: null };
  }

  let lastSeen: MatchAccountView | null = null;
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
      return { isMember: false, match: null };
    }
    if (match === null) continue; // not visible on this node yet

    // A settled or cancelled match has already paid out or refunded; letting
    // someone in on the strength of a stake that has been returned to them
    // would put an unfunded player in a wagered game.
    if (
      match.status !== MatchStatus.Open &&
      match.status !== MatchStatus.InProgress
    ) {
      return { isMember: false, match };
    }
    // The escrow the registry points at must be the one the lobby advertised.
    // A mismatch means server state and chain state have diverged; refusing is
    // the only safe reading, since the stake may sit in a different pot. The
    // view is not returned: it describes a different escrow than this lobby's,
    // so caching it would let the start-gate reason about the wrong pot.
    if (
      match.entryFee !== wager.entryFee ||
      match.mint.toBase58() !== wager.mint ||
      match.vault.toBase58() !== wager.vault
    ) {
      console.error(
        `[arena/rpcClient] match ${wager.matchPDA} does not match the registry entry`,
      );
      return { isMember: false, match: null };
    }

    // players[] is populated only up to player_count, and only by the program
    // after token::transfer succeeded — so presence here is proof of payment.
    if (match.players.some((p) => p.equals(wallet))) {
      return { isMember: true, match };
    }
    // Absent is not final: a node briefly behind shows the account without this
    // player's join yet, which is the exact case the retry loop exists for.
    // Keep the view so a caller still learns the fill state we did observe.
    lastSeen = match;
  }
  return { isMember: false, match: lastSeen };
}
