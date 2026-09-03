// @vitest-environment node
//
// [ARENA] Phase 4 — the server derives a wagered match's winner by replaying
// its own turn log instead of trusting a client majority vote.
//
// This exercises the real core: it simulates a short game, treats the hashes
// that run produced as "what the players saw", and then asks the verifier to
// re-derive the same game. That round trip is the actual claim being made —
// that src/core is deterministic enough for the server to reproduce a match
// from inputs it already holds — and no fixture could show it, because a
// fixture would only prove the verifier agrees with a file.
//
// EVERY simulation runs in a fresh module registry, via vi.resetModules() and a
// dynamic import. That is not tidiness: `loadTerrainMap` memoizes the GameMap
// and the simulation writes territory ownership into it, so a second run in the
// same registry starts on the first run's conquered board. The verifier refuses
// outright rather than answering wrongly, and the helper below is what gives
// each run the clean process it needs. Production gets this for free — one
// worker thread per verification.
//
// node, not the repo's jsdom default: the verifier reads map binaries off the
// filesystem and only ever runs server-side.

import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it, vi } from "vitest";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import type { GameConfig, PlayerRecord, Turn } from "../../src/core/Schemas";
import type { ReplayInput } from "../../src/server/arena/replayVerifier";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// NodeMapLoader resolves a directory from the GameMapType key, so the fixture
// directory has to be named for a real map — `world`, not the synthetic
// `plains` fixture, which is not a GameMapType at all.
const MAPS_DIR = path.join(HERE, "../testdata/maps");

// Long enough to clear the spawn phase and produce several hashed turns (the
// server hashes every 10th), short enough to keep the suite quick. The core
// runs ~275 ticks/sec headless.
const TURN_COUNT = 120;

const CONFIG = {
  gameMap: GameMapType.World,
  gameMapSize: GameMapSize.Normal,
  gameType: GameType.Private,
  difficulty: Difficulty.Easy,
  gameMode: GameMode.FFA,
  bots: 0,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  disabledUnits: [],
  donateGold: false,
  donateTroops: false,
  randomSpawn: false,
  nations: "default",
} as unknown as GameConfig;

const PLAYERS = [
  {
    clientID: "client_aaaaaaaa",
    username: "alice",
    persistentID: "p-alice",
    teamIndex: null,
    friends: [],
    isLobbyCreator: true,
  },
  {
    clientID: "client_bbbbbbbb",
    username: "bob",
    persistentID: "p-bob",
    teamIndex: null,
    friends: [],
    isLobbyCreator: false,
  },
] as unknown as PlayerRecord[];

function emptyTurns(count: number): Turn[] {
  return Array.from({ length: count }, (_, i) => ({
    turnNumber: i,
    gameID: "replaytest",
    intents: [],
  }));
}

function input(turns: Turn[]): ReplayInput {
  return {
    gameID: "replaytest",
    lobbyCreatedAt: 1_700_000_000_000,
    config: CONFIG,
    players: PLAYERS,
    turns,
    mapsDir: MAPS_DIR,
  };
}

/** A verifier whose process has never simulated anything. */
async function freshVerifier() {
  vi.resetModules();
  return await import("../../src/server/arena/replayVerifier");
}

/**
 * Plays the game once and writes the hashes it produced back onto the turns,
 * standing in for the live game whose clients agreed those hashes.
 */
async function recordedGame(): Promise<Turn[]> {
  const { simulateTurns } = await freshVerifier();
  const turns = emptyTurns(TURN_COUNT);
  const observed = await simulateTurns(input(turns));
  expect(observed.failure).toBeUndefined();
  expect(observed.hashes.size).toBeGreaterThan(0);
  return turns.map((t) => {
    const hash = observed.hashes.get(t.turnNumber);
    return hash === undefined ? t : { ...t, hash };
  });
}

describe("[ARENA] server-side replay verification", () => {
  it("reproduces a game it simulated from the same inputs", async () => {
    // The determinism claim the whole phase rests on: an independent run over
    // the same turn log lands on identical state at every hashed tick.
    const record = await recordedGame();
    const { verifyReplay } = await freshVerifier();
    const verdict = await verifyReplay(input(record));
    // Assert on the reason, not the boolean: a bare `false` tells whoever hits
    // this nothing about why the replay refused.
    expect(verdict.ok ? null : verdict.reason).toBeNull();
    if (!verdict.ok) return;
    expect(verdict.hashesCompared).toBeGreaterThan(0);
    expect(verdict.ticks).toBe(TURN_COUNT);
  }, 60_000);

  it("refuses when the state it computes diverges from the record", async () => {
    // A build that no longer reproduces the match must not settle it: the game
    // it replayed is not the game anyone played. This is what stops a code
    // change silently repaying old matches differently.
    const turns = await recordedGame();
    const hashedTurns = turns.filter((t) => t.hash !== undefined);
    const target = hashedTurns[hashedTurns.length - 1];
    const tampered = turns.map((t) =>
      t.turnNumber === target.turnNumber ? { ...t, hash: 123456789 } : t,
    );

    const { verifyReplay } = await freshVerifier();
    const verdict = await verifyReplay(input(tampered));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/diverged from the recorded game/);
    expect(verdict.reason).toContain(String(target.turnNumber));
  }, 60_000);

  it("refuses a turn log carrying no agreed hashes", async () => {
    // Without a single hash there is nothing to check the replay against, so
    // "it ran fine" says nothing. Refusing routes the pot to the refund path.
    const { verifyReplay } = await freshVerifier();
    const verdict = await verifyReplay(input(emptyTurns(TURN_COUNT)));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/no agreed state hashes/);
  }, 60_000);

  it("runs end to end on a real worker thread", async () => {
    // Everything above calls the verifier directly. This is the only test that
    // exercises the path production actually uses: a worker thread carrying
    // tsx's loader through execArgv, workerData structured-cloned across the
    // boundary, and a verdict posted back. It is also what proves the
    // one-simulation-per-process guard is satisfied for free in production —
    // the thread is fresh, so its terrain cache is empty.
    const record = await recordedGame();
    const { runReplayVerification } =
      await import("../../src/server/arena/replayRunner");
    const verdict = await runReplayVerification(input(record), 120_000);
    expect(verdict.ok ? null : verdict.reason).toBeNull();
    if (!verdict.ok) return;
    expect(verdict.ticks).toBe(TURN_COUNT);
    expect(verdict.hashesCompared).toBeGreaterThan(0);
  }, 180_000);

  it("refuses a second simulation in the same process", async () => {
    // The sharpest edge in this whole phase. loadTerrainMap memoizes the
    // GameMap and the simulation mutates it, so two games in one process means
    // the second starts on the first one's board — hashes diverge from tick 10
    // and the "winner" is of a game nobody played. Refusing turns a silent
    // wrong payout into a loud refusal to pay.
    const { simulateTurns, verifyReplay } = await freshVerifier();
    const first = await simulateTurns(input(emptyTurns(40)));
    expect(first.failure).toBeUndefined();

    const second = await verifyReplay(input(emptyTurns(40)));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toMatch(/already run in this process/);
  }, 60_000);
});
