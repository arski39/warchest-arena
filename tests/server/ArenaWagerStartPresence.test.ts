// [ARENA] A wagered lobby does not start until everyone who paid is present.
//
// The escrow flips to InProgress the instant the last join_match confirms,
// which is seconds BEFORE that player's browser has opened its websocket — it
// still has to connect, send join, and wait out verifyOnchainMembership's
// retry ladder (~300/600/1200/2400 ms of backoff alone). Arming the countdown
// on the chain state alone gave them WAGER_FULL_START_DELAY_MS (5 s) to finish
// all of that.
//
// Losing that race started the match without them: a 1v0 the connected player
// wins by walkover, paying out a pot the absent player staked and never got to
// play for. Their own client, still showing "connecting", then told them they
// had not entered the game in time and left the lobby for them. Observed live
// on escrow 92M66WDU, 2026-09-11.
//
// Not starting is the safe direction, and it is what the rest of the lifecycle
// already assumes: a wagered lobby that never starts refunds, while one that
// starts wrong pays the wrong wallet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MatchStatus } from "../../src/core/arena/arenaProgram";
import { GameType } from "../../src/core/game/Game";
import { matchRegistry } from "../../src/server/arena/matchRegistry";
import { GameServer } from "../../src/server/GameServer";

const GAME_ID = "wagerfil";

function logger(): any {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function wageredLobby(): GameServer {
  const game = new GameServer(GAME_ID, logger(), Date.now(), {
    gameType: GameType.Private,
    gameMap: "plains",
    gameMapSize: 100,
  } as any);
  matchRegistry.register(GAME_ID, {
    matchPDA: "pda",
    vault: "vault",
    mint: "mint",
    entryFee: "1000000",
    maxPlayers: 2,
    rakeBps: 250,
    programId: "prog",
    decimals: 6,
    symbol: "WARC",
  } as any);
  // What the join gate last read from chain: both seats paid.
  matchRegistry.recordChainState(GAME_ID, {
    status: MatchStatus.InProgress,
    playerCount: 2,
    maxPlayers: 2,
    observedAt: Date.now(),
  });
  return game;
}

/** Read straight off the instance: gameInfo() needs a fully wired game. */
function startsAt(game: GameServer): number | undefined {
  return (game as any).startsAt;
}

/** Connected clients, as phase() and the start gate expect to find them. */
function connect(game: GameServer, ...clients: { spectator?: boolean }[]) {
  (game as any).activeClients = clients.map((c, i) => ({
    clientID: `c${i}`,
    persistentID: `p${i}`,
    lastPing: Date.now(),
    spectator: c.spectator ?? false,
    ws: { readyState: 1 },
  }));
}

describe("[ARENA] a filled wager waits for its players", () => {
  beforeEach(() => {
    matchRegistry.unregister(GAME_ID);
  });

  afterEach(() => {
    matchRegistry.unregister(GAME_ID);
    vi.restoreAllMocks();
  });

  it("does not arm the countdown while a staker is still connecting", () => {
    // The exact live failure: both stakes are on chain, but the second
    // player's socket has not landed yet.
    const game = wageredLobby();
    connect(game, {});

    game.maybeAutoStartFilledWager();

    expect(startsAt(game)).toBeUndefined();
  });

  it("arms it once both stakers are connected", () => {
    const game = wageredLobby();
    connect(game, {}, {});

    game.maybeAutoStartFilledWager();

    expect(startsAt(game)).toBeDefined();
  });

  it("does not let a spectator stand in for an absent staker", () => {
    // Spectators hold no seat and stake nothing, so counting them would put
    // the match back on the path this test exists to close.
    const game = wageredLobby();
    connect(game, {}, { spectator: true });

    game.maybeAutoStartFilledWager();

    expect(startsAt(game)).toBeUndefined();
  });

  it("leaves a free lobby alone", () => {
    // No escrow, no seats to wait for: unwagered lobbies keep their behaviour.
    const game = new GameServer("freegame", logger(), Date.now(), {
      gameType: GameType.Private,
      gameMap: "plains",
      gameMapSize: 100,
    } as any);
    connect(game, {});

    game.maybeAutoStartFilledWager();

    // Never armed by this path at all — a free lobby starts on its host.
    expect(startsAt(game)).toBeUndefined();
  });
});
