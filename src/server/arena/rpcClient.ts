import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeMatchAccount,
  MatchAccountDecodeError,
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
// briefly behind would make us reject a player who genuinely paid.
//
// The budget is deliberately generous, because the cost is asymmetric: a slow
// join is an inconvenience, and a wrongly-kicked join takes a player's stake
// and locks them out of the match they paid for.
//
// Sized against a real observation, not a guess. The first devnet run of
// scripts/devnet/ was rate-limited repeatedly by api.devnet.solana.com --
// "429 Too Many Requests. Retrying after 4000ms" -- and web3.js's own retry
// only covers some call paths. Five attempts with exponential backoff spans
// roughly 4.5s of transient unavailability; the old 3x400ms spanned 1.2s.
const MEMBERSHIP_RETRIES = 5;
const MEMBERSHIP_BASE_DELAY_MS = 300;

/**
 * Exponential backoff with jitter: ~300, 600, 1200, 2400 ms, each +/-20%.
 *
 * The jitter is not decoration. Every player in a filling lobby joins within a
 * few seconds of each other, so a fixed schedule makes them retry in lockstep
 * and hammer an already-rate-limited endpoint at exactly the same instants.
 */
function membershipDelayMs(attempt: number): number {
  const base = MEMBERSHIP_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Why a check came back negative. Distinguishes "did not pay" from "could not tell". */
export type MembershipFailure =
  /** The escrow does not list this wallet. The player did not stake. */
  | "not-a-member"
  /** The account exists but is not a well-formed match. Permanent. */
  | "decode-failed"
  /** The escrow does not describe this lobby. Server and chain diverged. */
  | "registry-mismatch"
  /** Already settled or cancelled — the stake has been paid out or returned. */
  | "terminal-status"
  /** The wallet address was not valid base58. */
  | "bad-wallet"
  /** Every attempt failed to reach the RPC. We do not know either way. */
  | "rpc-unavailable";

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
  /**
   * Set whenever `isMember` is false.
   *
   * `rpc-unavailable` is the one that matters operationally: it means we never
   * got an answer, not that the player failed to pay. The join is still refused
   * — admitting an unverified wallet into a wagered match is the one thing this
   * function must never do — but an operator seeing a run of these is looking
   * at an RPC problem, not at fraud.
   */
  failure?: MembershipFailure;
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
    return { isMember: false, match: null, failure: "bad-wallet" };
  }

  let lastSeen: MatchAccountView | null = null;
  let reachedRpc = false;
  let lastRpcError = "";
  for (let attempt = 0; attempt < MEMBERSHIP_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, membershipDelayMs(attempt)));
    }

    let match: MatchAccountView | null;
    try {
      match = await fetchMatchAccount(wager);
      reachedRpc = true;
    } catch (e) {
      // Two very different failures arrive here, and treating them alike is
      // what used to kick paying players.
      //
      // A MatchAccountDecodeError is permanent -- a malformed or wrongly-owned
      // account will not fix itself, and retrying only delays the rejection.
      //
      // Anything else is the transport: a 429, a 5xx, a timeout, a dropped
      // connection. Those are exactly what a rate-limited public RPC produces,
      // they are transient by definition, and the previous code returned
      // "not a member" on the first one without ever entering the retry loop
      // the comment above says exists for this.
      if (e instanceof MatchAccountDecodeError) {
        console.error(
          `[arena/rpcClient] match ${wager.matchPDA} did not decode: ${e.message}`,
        );
        return { isMember: false, match: null, failure: "decode-failed" };
      }
      lastRpcError = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (match === null) continue; // not visible on this node yet

    // A settled or cancelled match has already paid out or refunded; letting
    // someone in on the strength of a stake that has been returned to them
    // would put an unfunded player in a wagered game.
    if (
      match.status !== MatchStatus.Open &&
      match.status !== MatchStatus.InProgress
    ) {
      return { isMember: false, match, failure: "terminal-status" };
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
      return { isMember: false, match: null, failure: "registry-mismatch" };
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

  // Never reached the RPC on any attempt: we do not know whether this player
  // staked. Refuse anyway -- admitting an unverified wallet into a wagered
  // match is the one thing this function must never do -- but say which it was,
  // so a run of these reads as an RPC outage rather than as fraud.
  if (!reachedRpc) {
    console.error(
      `[arena/rpcClient] could not reach the RPC to verify membership in ` +
        `${wager.matchPDA} after ${MEMBERSHIP_RETRIES} attempts: ${lastRpcError}`,
    );
    return { isMember: false, match: null, failure: "rpc-unavailable" };
  }
  return { isMember: false, match: lastSeen, failure: "not-a-member" };
}
