// [ARENA] A private lobby nobody is connected to must not stay advertised.
//
// The bug this pins was found on the live menu: a lobby its host had left was
// still listed in the browser, and stayed there. Reproduced against a running
// server — create a lobby, list it, drop the host's socket in a way that does
// not fire the host-left rule, and the lobby sits in GamePhase.Lobby with zero
// players for the full three-hour maxGameDuration, holding its creator's
// one-listing quota the whole time.
//
// Two preconditions have to hold for the old reaper to work and neither is
// guaranteed: handleClientDisconnect needs a close event to arrive at all, and
// it only closes the lobby when the leaving client's persistentID equals the
// creator's. A tab that dies without delivering its close frame satisfies
// neither — the client is dropped by phase()'s own 60s ping timeout, which runs
// no such check — so nothing was left to notice the lobby was empty.
//
// The mutation check is the first case: remove the reap and it fails.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameType } from "../../src/core/game/Game";
import {
  EMPTY_LOBBY_TIMEOUT_MS,
  GamePhase,
  GameServer,
} from "../../src/server/GameServer";

const START = 1_700_000_000_000;

function logger(): any {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function lobby(gameType: GameType): GameServer {
  return new GameServer("ghost123", logger(), Date.now(), {
    gameType,
    gameMap: "plains",
    gameMapSize: 100,
  } as any);
}

/** A connected client, as phase()'s liveness scan expects to find one. */
function occupy(game: GameServer): void {
  (game as any).activeClients = [
    {
      clientID: "c1",
      persistentID: "p1",
      lastPing: Date.now(),
      ws: { readyState: 1 },
    },
  ];
}

describe("[ARENA] empty lobby reaping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("closes a private lobby nobody has been connected to", () => {
    const game = lobby(GameType.Private);

    // The grace window is the host's chance to connect: create_game returns
    // before the browser opens its socket, and the join waits on Turnstile.
    vi.setSystemTime(START + EMPTY_LOBBY_TIMEOUT_MS - 1_000);
    expect(game.phase()).toBe(GamePhase.Lobby);

    vi.setSystemTime(START + EMPTY_LOBBY_TIMEOUT_MS + 1_000);
    expect(game.phase()).toBe(GamePhase.Finished);
  });

  it("measures the window from the last time someone was here", () => {
    const game = lobby(GameType.Private);

    // Host present well into the original window: it must restart, otherwise a
    // host who sat in their lobby for a minute would have it closed underneath
    // them.
    vi.setSystemTime(START + EMPTY_LOBBY_TIMEOUT_MS - 5_000);
    occupy(game);
    expect(game.phase()).toBe(GamePhase.Lobby);

    // They leave. Still inside a fresh window measured from now.
    (game as any).activeClients = [];
    vi.setSystemTime(START + EMPTY_LOBBY_TIMEOUT_MS + 5_000);
    expect(game.phase()).toBe(GamePhase.Lobby);

    vi.setSystemTime(START + 2 * EMPTY_LOBBY_TIMEOUT_MS + 5_000);
    expect(game.phase()).toBe(GamePhase.Finished);
  });

  it("leaves a public lobby alone, which is supposed to sit empty", () => {
    // The master generates matchmaking lobbies ahead of the players who fill
    // them. Reaping those would delete the lobby list.
    const game = lobby(GameType.Public);
    vi.setSystemTime(START + 4 * EMPTY_LOBBY_TIMEOUT_MS);
    expect(game.phase()).toBe(GamePhase.Lobby);
  });

  it("does not touch a game that has started", () => {
    // A started game empties whenever everyone disconnects at once; ending it
    // on that basis would discard a match in progress.
    const game = lobby(GameType.Private);
    game.prestart();
    vi.setSystemTime(START + 4 * EMPTY_LOBBY_TIMEOUT_MS);
    expect(game.phase()).not.toBe(GamePhase.Finished);
  });
});
