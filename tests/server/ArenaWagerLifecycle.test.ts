// [ARENA] The wagered-lobby lifecycle rules that keep a pot from being paid to
// the wrong player, or stranded for 24 h, by ordinary events: a reload, a
// network blip, a staker arriving late, a host opening the lobby twice.
//
// Each case here is a rule a real lobby breaks without:
//   * a staker who drops after the countdown armed is waited for, not left out
//     of the roster (their stake would be paid to the other player);
//   * two sessions on one wallet are one seat, not two;
//   * the host's socket closing does not end a wagered lobby -- staking into a
//     lobby the host is already in replaces their socket, so the old rule
//     destroyed every manually staked lobby at its host's own stake;
//   * a cancel or host-gone close only happens on a fresh escrow read, since a
//     stale "Open" abandons a pot that has since filled;
//   * nothing before start can settle a match, and one client cannot plant the
//     "agreed" state hash the settlement replay checks against;
//   * the host cannot kick a staker, pause, or enable host cheats.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MatchStatus } from "../../src/core/arena/arenaProgram";
import { GameType } from "../../src/core/game/Game";
import { matchRegistry } from "../../src/server/arena/matchRegistry";
import { walletRegistry } from "../../src/server/arena/walletRegistry";
import { GamePhase, GameServer } from "../../src/server/GameServer";

const fetchMatchAccount = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/rpcClient", () => ({ fetchMatchAccount }));
vi.mock("../../src/server/arena/settler", () => ({
  settle: vi.fn(async () => {}),
}));

const GAME_ID = "lifecyc1";
const HOST_PID = "p0";
const START = 1_700_000_000_000;

function logger(): any {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function wageredLobby(): GameServer {
  const game = new GameServer(
    GAME_ID,
    logger(),
    Date.now(),
    { gameType: GameType.Private, gameMap: "plains", gameMapSize: 100 } as any,
    HOST_PID,
  );
  matchRegistry.register(GAME_ID, {
    matchPDA: "pda",
    vault: "vault",
    mint: "mint",
    entryFee: 1_000_000n,
    maxPlayers: 2,
    rakeBps: 0,
    nonce: 1n,
    programId: "prog",
    decimals: 6,
    symbol: "WARC",
  });
  return game;
}

function observe(status: MatchStatus, staked: number, at = Date.now()) {
  matchRegistry.recordChainState(GAME_ID, {
    status,
    playerCount: staked,
    maxPlayers: 2,
    observedAt: at,
  });
}

interface Seat {
  pid: string;
  wallet?: string;
  spectator?: boolean;
}

/** Connected clients, each bound to its wallet as the join gate binds them. */
function connect(game: GameServer, ...seats: Seat[]) {
  for (const s of seats) {
    if (s.wallet !== undefined) walletRegistry.bind(GAME_ID, s.pid, s.wallet);
  }
  (game as any).activeClients = seats.map((s) => ({
    clientID: `c-${s.pid}`,
    persistentID: s.pid,
    lastPing: Date.now(),
    spectator: s.spectator ?? false,
    ws: { readyState: 1, send: vi.fn(), close: vi.fn() },
    hashes: new Map<number, number>(),
    reportedWinner: null,
    ip: `10.0.0.${seats.indexOf(s)}`,
  }));
}

const HOST = {
  clientID: "c-p0",
  isLobbyCreator: true,
  isAdmin: false,
  isAdminBot: false,
};

describe("[ARENA] wagered lobby lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    fetchMatchAccount.mockReset();
    matchRegistry.unregister(GAME_ID);
  });

  afterEach(() => {
    matchRegistry.unregister(GAME_ID);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("a staker missing when the match would start", () => {
    it("two sessions on one wallet are one seat", () => {
      const game = wageredLobby();
      observe(MatchStatus.InProgress, 2);
      connect(game, { pid: "p0", wallet: "W1" }, { pid: "alt", wallet: "W1" });
      expect(game.wagerSeatsMissing()).toBe(true);

      game.maybeAutoStartFilledWager();
      expect((game as any).startsAt).toBeUndefined();
    });

    it("holds, and disarms, when the countdown runs out with a staker gone", () => {
      // Both were here when it armed; one reloaded during the countdown.
      const game = wageredLobby();
      observe(MatchStatus.InProgress, 2);
      connect(game, { pid: "p0", wallet: "W1" }, { pid: "p1", wallet: "W2" });
      game.maybeAutoStartFilledWager();
      expect((game as any).startsAt).toBeDefined();

      connect(game, { pid: "p0", wallet: "W1" });
      expect(game.holdForMissingStakers()).toBe(true);
      expect((game as any).startsAt).toBeUndefined();

      // Back: the countdown re-arms and nothing holds it.
      connect(game, { pid: "p0", wallet: "W1" }, { pid: "p1", wallet: "W2" });
      game.maybeAutoStartFilledWager();
      expect((game as any).startsAt).toBeDefined();
      expect(game.holdForMissingStakers()).toBe(false);
    });

    it("start() waits for a staker who dropped after prestart, then gives up", () => {
      const game = wageredLobby();
      observe(MatchStatus.InProgress, 2);
      connect(game, { pid: "p0", wallet: "W1" });
      (game as any)._hasPrestarted = true;

      game.start();
      expect((game as any)._hasStarted).toBe(false);
      expect((game as any)._hasEnded).toBe(false);

      vi.advanceTimersByTime(20_000);
      expect((game as any)._hasStarted).toBe(false);
      expect((game as any)._hasEnded).toBe(true);
    });
  });

  describe("the host's socket closing", () => {
    it("does not end a wagered lobby", () => {
      // Exactly what staking into your own open lobby does: Main stops the
      // old connection before the staked one opens.
      const game = wageredLobby();
      connect(game, { pid: HOST_PID });
      const host = (game as any).activeClients[0];

      (game as any).handleClientDisconnect(host);

      expect((game as any)._hasEnded).toBe(false);
    });

    it("still ends a free lobby", () => {
      const game = new GameServer(
        "freegam1",
        logger(),
        Date.now(),
        { gameType: GameType.Private } as any,
        HOST_PID,
      );
      (game as any).activeClients = [
        {
          clientID: "c-p0",
          persistentID: HOST_PID,
          lastPing: Date.now(),
          ws: { readyState: 1, send: vi.fn(), close: vi.fn() },
        },
      ];

      (game as any).handleClientDisconnect((game as any).activeClients[0]);

      expect((game as any)._hasEnded).toBe(true);
    });

    it("closes a wagered lobby whose host stays away, on a fresh Open read", async () => {
      const game = wageredLobby();
      observe(MatchStatus.Open, 1);
      connect(game, { pid: HOST_PID }, { pid: "p1", wallet: "W2" });
      (game as any).handleClientDisconnect((game as any).activeClients[0]);
      (game as any).activeClients = (game as any).activeClients.slice(1);

      vi.setSystemTime(START + 61_000);
      fetchMatchAccount.mockResolvedValue({
        status: MatchStatus.Open,
        playerCount: 1,
        maxPlayers: 2,
      });
      // The cached read predates the deadline, so the first tick only asks.
      expect(game.phase()).not.toBe(GamePhase.Finished);
      expect(fetchMatchAccount).toHaveBeenCalledTimes(1);
      await vi.runAllTimersAsync();

      expect(game.phase()).toBe(GamePhase.Finished);
    });

    it("keeps a filled lobby open for its host", async () => {
      const game = wageredLobby();
      observe(MatchStatus.Open, 1);
      connect(game, { pid: HOST_PID }, { pid: "p1", wallet: "W2" });
      (game as any).handleClientDisconnect((game as any).activeClients[0]);
      (game as any).activeClients = (game as any).activeClients.slice(1);

      vi.setSystemTime(START + 61_000);
      fetchMatchAccount.mockResolvedValue({
        status: MatchStatus.InProgress,
        playerCount: 2,
        maxPlayers: 2,
      });
      game.phase();
      await vi.runAllTimersAsync();

      expect(game.phase()).not.toBe(GamePhase.Finished);
      expect((game as any)._hasEnded).toBe(false);
    });
  });

  describe("cancelling an unfilled lobby at its deadline", () => {
    it("does not act on a read older than the deadline", () => {
      const game = wageredLobby();
      observe(MatchStatus.Open, 1, START - 60_000);
      (game as any).startsAt = START;
      fetchMatchAccount.mockReturnValue(new Promise(() => {}));

      // Held: neither started nor cancelled, and a read is on its way.
      expect(game.cancelUnfilledWageredMatch()).toBe(true);
      expect((game as any)._hasEnded).toBe(false);
      expect(fetchMatchAccount).toHaveBeenCalledTimes(1);
    });

    it("does not cancel an escrow that filled since the cache was written", async () => {
      const game = wageredLobby();
      observe(MatchStatus.Open, 1, START - 60_000);
      (game as any).startsAt = START;
      fetchMatchAccount.mockResolvedValue({
        status: MatchStatus.InProgress,
        playerCount: 2,
        maxPlayers: 2,
      });

      game.cancelUnfilledWageredMatch();
      await vi.runAllTimersAsync();

      expect(game.cancelUnfilledWageredMatch()).toBe(false);
      expect((game as any)._hasEnded).toBe(false);
    });

    it("cancels on a fresh read that is still Open", async () => {
      const game = wageredLobby();
      observe(MatchStatus.Open, 1, START - 60_000);
      (game as any).startsAt = START;
      fetchMatchAccount.mockResolvedValue({
        status: MatchStatus.Open,
        playerCount: 1,
        maxPlayers: 2,
      });

      game.cancelUnfilledWageredMatch();
      await vi.runAllTimersAsync();

      expect(game.cancelUnfilledWageredMatch()).toBe(true);
      expect((game as any)._hasEnded).toBe(true);
    });

    it("never lets a lagging read move the cache backwards", () => {
      observe(MatchStatus.InProgress, 2);
      observe(MatchStatus.Open, 1);
      expect(matchRegistry.chainState(GAME_ID)?.status).toBe(
        MatchStatus.InProgress,
      );
    });
  });

  describe("settlement inputs", () => {
    it("ignores a winner vote before the match has started", () => {
      // A lone host is a majority of one. This used to set this.winner, after
      // which end() skipped the real game's settlement as "already archived".
      const game = wageredLobby();
      connect(game, { pid: HOST_PID, wallet: "W1" });
      const archive = vi
        .spyOn(game as any, "archiveGame")
        .mockImplementation(() => {});

      (game as any).handleWinner((game as any).activeClients[0], {
        type: "winner",
        winner: ["player", "c-p0"],
        allPlayersStats: {},
      });

      expect((game as any).winner).toBeNull();
      expect(archive).not.toHaveBeenCalled();
    });

    it("does not record a hash only one player reported", () => {
      const game = wageredLobby();
      connect(game, { pid: "p0", wallet: "W1" }, { pid: "p1", wallet: "W2" });
      (game as any).turns = Array.from({ length: 20 }, (_, i) => ({
        turnNumber: i,
        intents: [],
      }));
      const [a, b] = (game as any).activeClients;
      a.hashes.set(10, 1234); // the other client has not reported turn 10 yet

      (game as any).handleSynchronization();

      expect((game as any).turns[10].hash).toBeUndefined();

      b.hashes.set(10, 1234);
      (game as any).handleSynchronization();
      expect((game as any).turns[10].hash).toBe(1234);
    });
  });

  describe("host powers a wagered match does not grant", () => {
    it("refuses a kick", () => {
      const game = wageredLobby();
      connect(
        game,
        { pid: HOST_PID, wallet: "W1" },
        { pid: "p1", wallet: "W2" },
      );
      const outcome = game.handleIntent(
        { type: "kick_player", targetClientID: "c-p1" } as any,
        HOST,
      );
      expect(outcome.status).toBe(403);
    });

    it("refuses a pause", () => {
      const game = wageredLobby();
      (game as any)._hasStarted = true;
      const outcome = game.handleIntent(
        { type: "toggle_pause", paused: true } as any,
        HOST,
      );
      expect(outcome.status).toBe(403);
      expect((game as any).isPaused).toBeFalsy();
    });

    it("refuses host cheats", () => {
      const game = wageredLobby();
      const outcome = game.handleIntent(
        {
          type: "update_game_config",
          config: { hostCheats: { infiniteGold: true } },
        } as any,
        HOST,
      );
      expect(outcome.status).toBe(409);
    });
  });
});
