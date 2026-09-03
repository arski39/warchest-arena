// [ARENA] H2: the recovery sweeper.
//
// matchRegistry is a module-level Map inside each *worker* process. A worker
// crash (Master reforks it), a redeploy, or an OOM drops every live wager, and
// with it the only pointer the server held to tokens that are still sitting in
// a vault on chain. Hosting makes that routine rather than exceptional, which
// is why this exists at all.
//
// The chain is the durable store. MatchAccount already records authority,
// vault, players[], stakes[], status and created_at — everything a refund
// needs — so getProgramAccounts filtered on the authority enumerates every
// escrow this server ever created, with no server-side persistence whatsoever.
// That is precisely why the sweeper survives the thing that destroyed the
// registry: it never reads the registry.

import { PublicKey, type GetProgramAccountsFilter } from "@solana/web3.js";
import {
  decodeMatchAccount,
  MATCH_ACCOUNT_DISCRIMINATOR,
  MATCH_ACCOUNT_LAYOUT,
  MATCH_ACCOUNT_SIZE,
  MATCH_TIMEOUT_SECS,
  MatchStatus,
  type MatchAccountView,
} from "../../core/arena/arenaProgram";
import { MAX_GAME_DURATION_MS } from "../../core/Schemas";
import { arenaProgramId } from "./matchCreator";
import { wageringOperational } from "./preflight";
import { getConnection } from "./rpcClient";
import { serverKeypair } from "./serverKeypair";
import { cancelAndRefund, closeMatchAccount } from "./settler";

/**
 * How old an `Open` escrow must be before the sweeper treats it as abandoned.
 *
 * **The dangerous window of the two.** The program accepts a cancel on an
 * `Open` match at any age, so nothing on chain stops the sweeper refunding a
 * lobby that is still filling — this constant is the only thing that does.
 *
 * Derived from MAX_GAME_DURATION_MS rather than picked: past that, phase()
 * reports Finished, GameManager.tick() calls end(), and end()'s not-started
 * branch refunds the lobby itself. So an escrow still Open beyond it is one no
 * live GameServer can still be managing, in this process or any other sharing
 * the authority key. The extra hour keeps the sweeper from racing that ordinary
 * refund and turning a normal shutdown into a duplicate transaction.
 *
 * Note a private lobby with no armed start timer really does sit Open for the
 * full three hours — `lessThanLifetime` in phase() is unconditionally true
 * without a `startsAt`. A shorter window would refund players mid-lobby.
 */
export const OPEN_SWEEP_AFTER_MS = MAX_GAME_DURATION_MS + 60 * 60 * 1000;

/** How often the master re-scans. An orphan waits at most this long extra. */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Ceiling on close_match transactions per sweep.
 *
 * The first sweep after close_match ships faces every terminal match this key
 * ever created, and firing hundreds of transactions at once would be a poor
 * way to meet an RPC provider. Each close returns more rent than its fee, so
 * the backlog is worth clearing — just not all in one breath.
 */
export const MAX_CLOSES_PER_SWEEP = 20;

export interface SweepOutcome {
  /** Accounts the status-filtered queries returned. */
  scanned: number;
  /** Orphans successfully cancelled and refunded. */
  refunded: number;
  /** Terminal matches closed, returning their rent to the authority. */
  closed: number;
  /** Orphans that failed to decode or to cancel. Retried next sweep. */
  failed: number;
}

/**
 * Whether this escrow is past the point where anything else could still be
 * responsible for it.
 *
 * Exported because the windows are where the risk lives: too short and a live
 * lobby gets refunded out from under its players, too long and money sits
 * locked. Settled and Cancelled are terminal and never orphans.
 */
export function isOrphaned(match: MatchAccountView, nowMs: number): boolean {
  // created_at is the validator's clock, this is ours. Skew only matters for
  // the Open case — the program re-checks InProgress against its own clock, so
  // being early there costs a rejected transaction and nothing else — and the
  // Open window is hours wide, far beyond any plausible drift.
  const ageMs = nowMs - Number(match.createdAt) * 1000;
  switch (match.status) {
    case MatchStatus.Open:
      return ageMs >= OPEN_SWEEP_AFTER_MS;
    case MatchStatus.InProgress:
      // The same deadline the program enforces. Reading it from the IDL-pinned
      // constant rather than choosing one means the sweeper cannot start
      // submitting transactions the program is bound to reject.
      return ageMs >= MATCH_TIMEOUT_SECS * 1000;
    default:
      return false;
  }
}

/**
 * One pass: enumerate this authority's unfinished escrows and refund the ones
 * nothing can still be managing.
 *
 * `nowMs` is injectable so the age windows can be tested without faking time.
 */
export async function sweepOrphanedMatches(
  nowMs: number = Date.now(),
): Promise<SweepOutcome> {
  const outcome: SweepOutcome = {
    scanned: 0,
    refunded: 0,
    closed: 0,
    failed: 0,
  };

  const programId = arenaProgramId();
  if (programId === null) return outcome;
  const authority = serverKeypair().publicKey;

  // One query per status, not one query: getProgramAccounts AND-s its filters
  // and offers no OR. Worth the extra round trips — a terminal match stays on
  // chain until close_match removes it, and the reclaim pass below is what
  // stops that set growing without bound for the life of the authority key.
  const candidates = [
    ...(await matchesWithStatus(programId, authority, MatchStatus.Open)),
    ...(await matchesWithStatus(programId, authority, MatchStatus.InProgress)),
  ];

  for (const { pubkey, account } of candidates) {
    outcome.scanned++;

    let match: MatchAccountView;
    try {
      match = decodeMatchAccount(account.data, account.owner, programId);
    } catch (e) {
      outcome.failed++;
      console.error(
        `[arena/sweeper] ${pubkey.toBase58()} matched the filters but did not ` +
          `decode: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }

    if (!isOrphaned(match, nowMs)) continue;

    // Per match, not per sweep: one unrefundable pot must not stop the rest
    // being recovered. Whatever failed is still on chain next time round.
    try {
      const txSig = await cancelAndRefund(programId, pubkey, match);
      outcome.refunded++;
      console.warn(
        `[arena/sweeper] refunded orphaned ${MatchStatus[match.status]} match ` +
          `${pubkey.toBase58()} to ${match.players.length} stakers tx=${txSig}`,
      );
    } catch (e) {
      outcome.failed++;
      console.error(
        `[arena/sweeper] could not refund ${pubkey.toBase58()}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  await reclaimTerminalMatches(programId, authority, outcome);

  return outcome;
}

/**
 * Close matches that can no longer move money, returning their rent.
 *
 * A separate pass rather than part of the loop above, because the two are
 * answering different questions: that one asks whether an escrow has been
 * abandoned, this one only tidies up after escrows that are already finished.
 * Matches cancelled by this very sweep are picked up on the next one — the
 * queries ran before them — which costs nothing and keeps the pass simple.
 *
 * A close that fails is not retried within the sweep. The usual cause is a
 * vault somebody donated into, which cancel_match leaves non-empty and no
 * amount of retrying will change; it is logged once per sweep and skipped.
 */
async function reclaimTerminalMatches(
  programId: PublicKey,
  authority: PublicKey,
  outcome: SweepOutcome,
): Promise<void> {
  const terminal = [
    ...(await matchesWithStatus(programId, authority, MatchStatus.Settled)),
    ...(await matchesWithStatus(programId, authority, MatchStatus.Cancelled)),
  ];

  for (const { pubkey, account } of terminal.slice(0, MAX_CLOSES_PER_SWEEP)) {
    let match: MatchAccountView;
    try {
      match = decodeMatchAccount(account.data, account.owner, programId);
    } catch {
      // Already counted and logged by the orphan pass if it appeared there;
      // an undecodable terminal account is not actionable either way.
      continue;
    }
    try {
      const txSig = await closeMatchAccount(programId, pubkey, match);
      outcome.closed++;
      console.log(
        `[arena/sweeper] closed ${MatchStatus[match.status]} match ` +
          `${pubkey.toBase58()}, rent returned tx=${txSig}`,
      );
    } catch (e) {
      console.warn(
        `[arena/sweeper] could not close ${pubkey.toBase58()} ` +
          `(a donated-into vault is never empty and never will be): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

async function matchesWithStatus(
  programId: PublicKey,
  authority: PublicKey,
  status: MatchStatus,
) {
  const filters: GetProgramAccountsFilter[] = [
    { dataSize: MATCH_ACCOUNT_SIZE },
    {
      memcmp: {
        offset: MATCH_ACCOUNT_LAYOUT.discriminator,
        bytes: Buffer.from(MATCH_ACCOUNT_DISCRIMINATOR).toString("base64"),
        encoding: "base64",
      },
    },
    {
      memcmp: {
        offset: MATCH_ACCOUNT_LAYOUT.authority,
        bytes: authority.toBase58(),
      },
    },
    {
      memcmp: {
        offset: MATCH_ACCOUNT_LAYOUT.status,
        bytes: Buffer.from([status]).toString("base64"),
        encoding: "base64",
      },
    },
  ];
  return await getConnection().getProgramAccounts(programId, {
    commitment: "confirmed",
    filters,
  });
}

//
// Scheduling
//

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

/**
 * Starts sweeping, immediately and then on an interval.
 *
 * **Call this in the master process only.** N workers each sweeping means N
 * concurrent cancel_match transactions per orphan, of which one succeeds and
 * the rest waste a fee to be rejected with NotOpen. The master already forks
 * and supervises the workers, holds the same env and therefore the same
 * keypair, and does no other arena work — it is the natural single-flight
 * point. The sweeper needs only chain state and the keypair, never a worker's
 * registry, which is exactly what lets it run there.
 */
export function startSweeper(): void {
  if (timer !== null) return;
  if (!wageringOperational()) {
    // Not an error: a server with no escrows to recover has nothing to sweep,
    // and one whose config is broken already said so at preflight.
    return;
  }

  console.log(
    `[arena/sweeper] recovering orphaned escrows every ${SWEEP_INTERVAL_MS / 60_000} min ` +
      `(Open after ${OPEN_SWEEP_AFTER_MS / 3_600_000}h, InProgress after ${MATCH_TIMEOUT_SECS / 3600}h)`,
  );
  void runSweep();
  timer = setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);
}

/** Stops the interval. For tests and orderly shutdown. */
export function stopSweeper(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  inFlight = false;
}

async function runSweep(): Promise<void> {
  // A sweep slower than the interval means either a lot of refunds or a very
  // slow RPC. Overlapping runs would re-scan the same accounts and double-
  // submit cancels for orphans the first pass is already refunding.
  if (inFlight) {
    console.warn("[arena/sweeper] previous sweep still running; skipping tick");
    return;
  }
  inFlight = true;
  try {
    const { scanned, refunded, closed, failed } = await sweepOrphanedMatches();
    if (refunded > 0 || closed > 0 || failed > 0) {
      console.log(
        `[arena/sweeper] swept ${scanned} unfinished escrows: ${refunded} ` +
          `refunded, ${failed} failed; ${closed} finished matches closed`,
      );
    }
  } catch (e) {
    // An unreachable RPC is not a reason to stop sweeping forever; the next
    // tick tries again, and the orphans are still on chain waiting.
    console.error(
      `[arena/sweeper] sweep failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    inFlight = false;
  }
}
