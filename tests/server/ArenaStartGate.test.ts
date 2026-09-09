// [ARENA] Phase 1: a wagered lobby must not start with unstaked seats, and a
// wagered lobby that never starts must still release its stakes.
//
// Both are money bugs rather than UX ones. Starting underfilled produces a
// match that is played and then guaranteed to refund, because join_match only
// flips the escrow to InProgress once the last seat is staked and settle_match
// accepts nothing else. Never starting at all was worse: end() returns before
// archiveGame(), which is the only caller of the settler, so the stakes simply
// stayed in the vault.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatchStatus } from "../../src/core/arena/arenaProgram";
import { GameType } from "../../src/core/game/Game";
import {
  GameServer,
  WAGER_FULL_START_DELAY_MS,
} from "../../src/server/GameServer";
import {
  matchRegistry,
  wagerReadyToStart,
  type WagerConfig,
} from "../../src/server/arena/matchRegistry";

// Typed against settle()'s real signature so the call assertions below are
// checked rather than inferred as a zero-arg tuple.
const settleMock = vi.hoisted(() =>
  vi.fn(
    async (
      _gameId: string,
      _winner: unknown,
      _allClients: ReadonlyMap<string, unknown>,
    ): Promise<void> => {},
  ),
);
vi.mock("../../src/server/arena/settler", () => ({ settle: settleMock }));

const GAME_ID = "wagered1";
const FREE_ID = "freegame";

function wager(overrides: Partial<WagerConfig> = {}): WagerConfig {
  return {
    matchPDA: "11111111111111111111111111111111",
    vault: "11111111111111111111111111111112",
    mint: "11111111111111111111111111111113",
    entryFee: 1_000_000n,
    maxPlayers: 2,
    rakeBps: 0,
    nonce: 7n,
    programId: "11111111111111111111111111111114",
    decimals: 6,
    symbol: "ARENA",
    ...overrides,
  };
}

/** Mirrors what the join gate caches after reading the escrow. */
function observe(gameId: string, status: MatchStatus, staked: number) {
  matchRegistry.recordChainState(gameId, {
    status,
    playerCount: staked,
    maxPlayers: 2,
    observedAt: Date.now(),
  });
}

describe("[ARENA] wagered start gate", () => {
  let mockLogger: any;

  beforeEach(() => {
    settleMock.mockClear();
    mockLogger = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(() => {
    matchRegistry.unregister(GAME_ID);
    matchRegistry.unregister(FREE_ID);
    vi.restoreAllMocks();
  });

  function makeGame(id: string) {
    return new GameServer(id, mockLogger, Date.now(), {
      gameType: GameType.Private,
    } as any);
  }

  const HOST = {
    clientID: "host",
    isLobbyCreator: true,
    isAdmin: false,
    isAdminBot: false,
  };
  const toggleStart = (game: GameServer) =>
    game.handleIntent({ type: "toggle_game_start_timer" } as any, HOST);

  describe("wagerReadyToStart", () => {
    it("is true for a lobby that is not wagered", () => {
      expect(wagerReadyToStart(FREE_ID)).toBe(true);
    });

    it("is false for a wagered lobby never observed on chain", () => {
      matchRegistry.register(GAME_ID, wager());
      // No stake can have landed without the join gate reading the escrow, so
      // absence of an observation means absence of stakes.
      expect(wagerReadyToStart(GAME_ID)).toBe(false);
    });

    it("is false while the escrow is still Open, even with seats staked", () => {
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.Open, 1);
      expect(wagerReadyToStart(GAME_ID)).toBe(false);
    });

    it("flips true only once the escrow reports InProgress", () => {
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.Open, 1);
      expect(wagerReadyToStart(GAME_ID)).toBe(false);
      observe(GAME_ID, MatchStatus.InProgress, 2);
      expect(wagerReadyToStart(GAME_ID)).toBe(true);
    });

    it("forgets the observation when the match is unregistered", () => {
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.InProgress, 2);
      matchRegistry.unregister(GAME_ID);
      // Re-registering the same id must not inherit the old fill state.
      matchRegistry.register(GAME_ID, wager());
      expect(wagerReadyToStart(GAME_ID)).toBe(false);
    });
  });

  describe("toggle_game_start_timer", () => {
    it("leaves a free lobby untouched", () => {
      const game = makeGame(FREE_ID);
      expect(toggleStart(game).status).toBe(200);
      expect((game as any).startsAt).toBeDefined();
    });

    it("rejects an underfilled wagered lobby and does not arm the timer", () => {
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.Open, 1);
      const game = makeGame(GAME_ID);

      const result = toggleStart(game);

      expect(result.status).toBe(409);
      expect(result.error).toBe("wager_lobby_not_full");
      expect((game as any).startsAt).toBeUndefined();
    });

    it("allows a fully staked wagered lobby to start", () => {
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.InProgress, 2);
      const game = makeGame(GAME_ID);

      expect(toggleStart(game).status).toBe(200);
      expect((game as any).startsAt).toBeDefined();
    });

    it("still lets the host disarm a timer that is already running", () => {
      // Arm while full, then have a staker vanish from the cached view. The
      // host must not be trapped with a timer they cannot cancel.
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.InProgress, 2);
      const game = makeGame(GAME_ID);
      toggleStart(game);
      observe(GAME_ID, MatchStatus.Open, 1);

      expect(toggleStart(game).status).toBe(200);
      expect((game as any).startsAt).toBeUndefined();
    });
  });

  describe("cancelUnfilledWageredMatch", () => {
    it("does not fire for a free lobby", () => {
      expect(makeGame(FREE_ID).cancelUnfilledWageredMatch()).toBe(false);
    });

    it("does not fire once the escrow is InProgress", () => {
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.InProgress, 2);
      expect(makeGame(GAME_ID).cancelUnfilledWageredMatch()).toBe(false);
    });

    it("ends an underfilled wagered game so the tick prunes and refunds it", () => {
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.Open, 1);
      const game = makeGame(GAME_ID);

      expect(game.cancelUnfilledWageredMatch()).toBe(true);
      // _hasEnded routes it to end(), whose not-started branch issues the one
      // and only refund. Cancelling must not refund inline as well.
      expect((game as any)._hasEnded).toBe(true);
      expect(settleMock).not.toHaveBeenCalled();
    });
  });

  describe("refund on the not-started path", () => {
    it("releases the stakes of a wagered lobby that never started", () => {
      matchRegistry.register(GAME_ID, wager());
      const game = makeGame(GAME_ID);

      game.end();

      expect(settleMock).toHaveBeenCalledTimes(1);
      // No winner: settle() reads the escrow, finds it Open, and refunds.
      expect(settleMock.mock.calls[0][1]).toBeNull();
      expect(settleMock.mock.calls[0][0]).toBe(GAME_ID);
    });

    it("does not call the settler for a free lobby", () => {
      makeGame(FREE_ID).end();
      expect(settleMock).not.toHaveBeenCalled();
    });

    it("refunds a cancelled underfilled lobby exactly once", () => {
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.Open, 1);
      const game = makeGame(GAME_ID);

      game.cancelUnfilledWageredMatch();
      game.end();

      expect(settleMock).toHaveBeenCalledTimes(1);
    });
  });

  // [ARENA] A duel between strangers has nobody to press "start". Once both
  // stakes are in there is nothing left to decide, and leaving the second
  // player at the host's mercy -- or at maybeAutoStartListed's five minutes --
  // is the wrong shape for matchmaking.
  describe("a filled wagered lobby starts itself", () => {
    it("arms a short countdown once the escrow reports InProgress", () => {
      const game = makeGame(GAME_ID);
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.InProgress, 2);

      game.maybeAutoStartFilledWager();

      expect(game.gameInfo().startsAt).toBeGreaterThan(Date.now());
      expect(game.gameInfo().startsAt).toBeLessThanOrEqual(
        Date.now() + WAGER_FULL_START_DELAY_MS,
      );
    });

    it("does not arm while a seat is still unstaked", () => {
      // The whole point of the start-gate: an underfilled wagered lobby can
      // only ever refund, so starting it is worse than not starting it.
      const game = makeGame(GAME_ID);
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.Open, 1);

      game.maybeAutoStartFilledWager();

      expect(game.gameInfo().startsAt).toBeUndefined();
    });

    it("leaves free lobbies alone", () => {
      // wagerReadyToStart() answers true for anything unwagered, so gating on
      // it alone would auto-start every private lobby on the server.
      const game = makeGame(FREE_ID);

      game.maybeAutoStartFilledWager();

      expect(game.gameInfo().startsAt).toBeUndefined();
    });

    it("does not move a countdown the host already armed", () => {
      const game = makeGame(GAME_ID);
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.InProgress, 2);
      game.setStartsAt(Date.now() + 60_000);
      const armed = game.gameInfo().startsAt;

      game.maybeAutoStartFilledWager();

      expect(game.gameInfo().startsAt).toBe(armed);
    });

    it("holds the match back until the countdown expires", () => {
      // A full lobby reports Active immediately, because
      // hasReachedMaxPlayerCount short-circuits the Lobby phase. Without this
      // the countdown would be consumed in the tick that armed it and both
      // players would be dropped straight into the game.
      const game = makeGame(GAME_ID);
      matchRegistry.register(GAME_ID, wager());
      observe(GAME_ID, MatchStatus.InProgress, 2);

      game.maybeAutoStartFilledWager();
      expect(game.startCountdownPending()).toBe(true);

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + WAGER_FULL_START_DELAY_MS + 1);
      expect(game.startCountdownPending()).toBe(false);
      vi.useRealTimers();
    });
  });
});
