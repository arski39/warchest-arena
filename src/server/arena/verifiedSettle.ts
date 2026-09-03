// [ARENA] Phase 4 — settle a wagered match on the winner the SERVER computed,
// not the one the clients voted for.
//
// This is the seam that closes the v1 accepted risk. Everything about how the
// winner is derived lives in replayVerifier.ts; this file is only about what to
// do with the verdict:
//
//   * verified            -> settle on the replayed winner.
//   * verified, but it
//     disagrees with the
//     vote               -> settle on the replayed winner anyway, and log the
//                           disagreement loudly. That is the signal collusion
//                           would produce, and it is worth an operator's
//                           attention even though the payout is already correct.
//   * could not verify   -> DO NOT SETTLE. Log why. The pot stays escrowed and
//                           the program's 24h timeout-cancel refunds every
//                           staker.
//
// The last case is the important one. Declining to pay is recoverable — the
// refund path already exists and is tested — whereas signing a payout to the
// wrong wallet is not. So every uncertainty resolves to "refund", never to
// "fall back to the client vote": falling back would reinstate exactly the
// trust this phase removes, and would do it precisely when something is already
// wrong.
import type { ClientSendWinnerMessage } from "../../core/Schemas";
import type { Client } from "../Client";
import { matchRegistry } from "./matchRegistry";
import { runReplayVerification } from "./replayRunner";
import type { ReplayInput } from "./replayVerifier";
import { settle } from "./settler";

export interface VerifiedSettleLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Decides a wagered match's payout from a server-side replay.
 *
 * Returns without touching the chain for a free-to-play game, so callers do not
 * have to ask whether a lobby was wagered before calling.
 */
export async function settleVerified(
  gameId: string,
  votedWinner: ClientSendWinnerMessage | null,
  allClients: ReadonlyMap<string, Client>,
  replayInput: () => ReplayInput,
  log: VerifiedSettleLogger,
): Promise<void> {
  if (!matchRegistry.isWagered(gameId)) return;

  const started = Date.now();
  // replayInput is a thunk so a free-to-play game never pays to assemble it —
  // the turn log is the largest thing this process holds.
  const verdict = await runReplayVerification(replayInput());
  const elapsedMs = Date.now() - started;

  if (!verdict.ok) {
    log.error("[arena] refusing to settle: replay could not verify the match", {
      gameID: gameId,
      reason: verdict.reason,
      elapsedMs,
    });
    // Deliberately no settle() call. The stakes stay in the vault and the
    // escrow's timeout-cancel refunds them.
    return;
  }

  const replayed = verdict.winner;
  const voted = votedWinner?.winner;
  if (JSON.stringify(replayed ?? null) !== JSON.stringify(voted ?? null)) {
    log.error(
      "[arena] REPLAY DISAGREES WITH THE CLIENT VOTE — paying the replayed " +
        "winner. This is what a collusion attempt looks like; it is also what " +
        "a simulation bug looks like. Investigate the record.",
      {
        gameID: gameId,
        replayed: JSON.stringify(replayed ?? null),
        voted: JSON.stringify(voted ?? null),
      },
    );
  }

  log.info("[arena] replay verified", {
    gameID: gameId,
    ticks: verdict.ticks,
    hashesCompared: verdict.hashesCompared,
    elapsedMs,
  });

  // Hand the settler the same shape a client vote would have produced, so
  // nothing downstream needs to know which path decided the winner.
  const winner: ClientSendWinnerMessage | null =
    replayed === undefined
      ? null
      : {
          type: "winner",
          winner: replayed,
          allPlayersStats: verdict.allPlayersStats,
        };

  await settle(gameId, winner, allClients);
}
