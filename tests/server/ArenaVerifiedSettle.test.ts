// [ARENA] Phase 4 — what the server does with a replay verdict.
//
// The verification itself is covered by ArenaReplayVerifier.test.ts against the
// real core. This suite is about the decision made afterwards, which is where
// the money is:
//
//   verified            -> settle on the REPLAYED winner
//   verified, disagrees -> settle on the replayed winner anyway, log loudly
//   not verified        -> do not settle at all
//
// The last one is the whole point of the phase. "Could not verify" must never
// fall back to the client vote: falling back would reinstate exactly the trust
// being removed, and would do it precisely when something is already wrong.
// A refusal leaves the pot escrowed for the program's 24h timeout-cancel, which
// refunds every staker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientSendWinnerMessage } from "../../src/core/Schemas";
import type {
  ReplayInput,
  ReplayVerdict,
} from "../../src/server/arena/replayVerifier";

const runReplayVerification = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/replayRunner", () => ({
  runReplayVerification,
  defaultMapsDir: () => "/maps",
}));

const settle = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/settler", () => ({ settle }));

const isWagered = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/matchRegistry", () => ({
  matchRegistry: { isWagered },
}));

const GAME_ID = "game1";
const REPLAYED_WINNER = ["player", "client_alice"] as const;
const VOTED_WINNER = ["player", "client_bob"] as const;

function votedMessage(
  winner: readonly [string, string],
): ClientSendWinnerMessage {
  return {
    type: "winner",
    winner: winner as never,
    allPlayersStats: {},
  } as ClientSendWinnerMessage;
}

function verdictOk(
  winner: readonly [string, string] | undefined,
): ReplayVerdict {
  return {
    ok: true,
    winner: winner as never,
    allPlayersStats: {},
    ticks: 1000,
    hashesCompared: 100,
  };
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const replayInput = () => ({}) as ReplayInput;

async function run(votedWinner: ClientSendWinnerMessage | null) {
  const { settleVerified } =
    await import("../../src/server/arena/verifiedSettle");
  await settleVerified(GAME_ID, votedWinner, new Map(), replayInput, log);
}

describe("[ARENA] settling on a verified winner", () => {
  beforeEach(() => {
    isWagered.mockReturnValue(true);
    settle.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing at all for a free-to-play lobby", async () => {
    // Callers should not have to ask whether a game was wagered, and a
    // free game must not pay to assemble a turn log or spin up a thread.
    isWagered.mockReturnValue(false);
    const input = vi.fn(replayInput);
    const { settleVerified } =
      await import("../../src/server/arena/verifiedSettle");
    await settleVerified(GAME_ID, null, new Map(), input, log);

    expect(runReplayVerification).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  });

  it("settles on the replayed winner", async () => {
    runReplayVerification.mockResolvedValue(verdictOk(REPLAYED_WINNER));
    await run(votedMessage(REPLAYED_WINNER));

    expect(settle).toHaveBeenCalledTimes(1);
    const passed = settle.mock.calls[0][1] as ClientSendWinnerMessage;
    expect(passed.winner).toEqual(REPLAYED_WINNER);
  });

  it("pays the replayed winner when the vote disagrees, and says so", async () => {
    // This is what a collusion attempt looks like from the server's side. The
    // payout is already correct; the log is for the operator.
    runReplayVerification.mockResolvedValue(verdictOk(REPLAYED_WINNER));
    await run(votedMessage(VOTED_WINNER));

    expect(settle).toHaveBeenCalledTimes(1);
    const passed = settle.mock.calls[0][1] as ClientSendWinnerMessage;
    expect(passed.winner).toEqual(REPLAYED_WINNER);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("REPLAY DISAGREES") as unknown as string,
      expect.anything(),
    );
  });

  it("does not log a disagreement when the two agree", async () => {
    runReplayVerification.mockResolvedValue(verdictOk(REPLAYED_WINNER));
    await run(votedMessage(REPLAYED_WINNER));
    expect(log.error).not.toHaveBeenCalled();
  });

  it("REFUSES TO SETTLE when the replay could not verify", async () => {
    // The core guarantee. No settle call at all, so the stakes stay escrowed
    // and the 24h timeout-cancel refunds them.
    runReplayVerification.mockResolvedValue({
      ok: false,
      reason: "state diverged from the recorded game at turn 40",
    } satisfies ReplayVerdict);

    await run(votedMessage(VOTED_WINNER));

    expect(settle).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("refusing to settle") as unknown as string,
      expect.objectContaining({ reason: expect.stringContaining("diverged") }),
    );
  });

  it("never falls back to the client vote on a failed verification", async () => {
    // Stated separately from the test above because it is the property that
    // matters, not the mechanism: a failed replay with a perfectly good vote
    // available must still pay nobody.
    runReplayVerification.mockResolvedValue({
      ok: false,
      reason: "replay did not finish within 900s",
    } satisfies ReplayVerdict);

    await run(votedMessage(VOTED_WINNER));
    expect(settle).not.toHaveBeenCalled();
  });

  it("settles a null winner when the replay produced none", async () => {
    // A game that ended without a winner (everyone left, timed out). settle()
    // reads the escrow itself and refunds when the chain says Open, so this
    // still has to reach it rather than being dropped here.
    runReplayVerification.mockResolvedValue(verdictOk(undefined));
    await run(null);

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][1]).toBeNull();
  });
});
