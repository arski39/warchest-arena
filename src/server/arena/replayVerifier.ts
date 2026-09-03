// [ARENA] Phase 4 — the server works out the winner for itself.
//
// ## What this replaces
//
// OpenFront's simulation runs on each CLIENT; the server only relays intents.
// At match end every client computes its own winner and reports it, and the
// server accepts whichever result a majority of unique-IP clients agree on
// (GameServer.handleWinner + VoteTally). For a free game that is fine. For a
// wagered one it means the server signs a payout for a result it never checked,
// and in a small or 1v1 lobby "a majority of clients" is trivially colluded —
// the accepted-risk section CLAUDE.md has carried since v1.
//
// ## Why replaying is authoritative, and the vote is not
//
// The server does not need the clients' answer, because it already holds every
// input the simulation takes:
//
//   * the turn log — the intents IT relayed, in the order IT chose;
//   * GameStartInfo — the config, players and teams IT assembled;
//   * the map, which is content, and the seed, which is derived from the game id.
//
// src/core is deterministic by construction (seeded PRNG, no floating-point).
// So re-running those inputs reproduces the match exactly, and the result
// depends on nothing any client says after the fact. A colluding majority can
// still *play* badly on purpose — that is ordinary throwing, not fraud — but it
// can no longer declare a winner that did not win.
//
// ## Why a hash mismatch refuses rather than wins
//
// Each turn carries a state hash the clients agreed on live (desync detection).
// Those hashes are not what decides the winner — they are client-supplied and a
// colluding majority could agree on anything. They are a *drift* check: if the
// server's own core no longer reproduces the hashes the players saw, then the
// game this code just replayed is not the game that was played, and paying out
// on it would be paying on a match nobody played. So a mismatch returns
// `ok: false` and settlement is skipped, which leaves the pot to the 24h
// timeout-cancel and refunds every staker. Fail closed: refund beats paying the
// wrong player.
//
// This module is pure — inputs in, verdict out, no RPC and no chain access — so
// it is testable directly. replayWorker.ts runs it off the event loop.

import { Config } from "../../core/configuration/Config";
import { Executor } from "../../core/execution/ExecutionManager";
import { PlayerInfo, PlayerType } from "../../core/game/Game";
import { createGame } from "../../core/game/GameImpl";
import {
  GameUpdateType,
  HashUpdate,
  WinUpdate,
} from "../../core/game/GameUpdates";
import { createNationsForGame } from "../../core/game/NationCreation";
import { loadTerrainMap } from "../../core/game/TerrainMapLoader";
import { GameRunner } from "../../core/GameRunner";
import { PseudoRandom } from "../../core/PseudoRandom";
import type {
  AllPlayersStats,
  GameConfig,
  GameStartInfo,
  PlayerRecord,
  Tribe,
  Turn,
  Winner,
} from "../../core/Schemas";
import { simpleHash, toWireGameStartInfo } from "../../core/Util";
import { NodeMapLoader } from "./NodeMapLoader";

/**
 * Everything the simulation needs, and nothing the clients control after the
 * fact. Assembled by GameServer from state it already holds.
 */
export interface ReplayInput {
  gameID: string;
  lobbyCreatedAt: number;
  config: GameConfig;
  players: PlayerRecord[];
  tribes?: Tribe[];
  /**
   * The FULL turn log, not the record's filtered form. `createPartialGameRecord`
   * drops turns with no intents and no hash, and the replay would then be short
   * by exactly those ticks; passing the raw log avoids needing to re-expand it.
   */
  turns: Turn[];
  /** Absolute path to resources/maps. */
  mapsDir: string;
}

export type ReplayVerdict =
  | {
      ok: true;
      /** Undefined when the simulation never produced a winner. */
      winner: Winner | undefined;
      allPlayersStats: AllPlayersStats;
      ticks: number;
      hashesCompared: number;
    }
  | { ok: false; reason: string };

/**
 * ONE SIMULATION PER PROCESS. This is not a style choice.
 *
 * `loadTerrainMap` memoizes by `map:size` in a module-level `loadedMaps`, and
 * hands every caller the SAME `gameMap` object. The simulation writes territory
 * ownership into that object, so a second game in the same process does not
 * start on an empty board — it starts on whatever the first game conquered, and
 * produces different state hashes from tick 10 onward.
 *
 * That is a silent wrong answer, and for a wagered match a silent wrong answer
 * is a payout to the wrong wallet. So the second call refuses instead.
 *
 * Production never trips this: replayRunner.ts spawns a fresh worker thread per
 * verification, and a new thread gets its own module registry and therefore its
 * own empty cache. The guard exists for the day somebody moves verification
 * inline "to avoid the thread", or batches two matches into one worker.
 */
let simulationRan = false;

/** Test seam: forget that a simulation has run. Never called by server code. */
export function resetReplayGuardForTests(): void {
  simulationRan = false;
}

/** Outcome of running the turn log, before any policy is applied to it. */
interface SimulationResult {
  hashes: Map<number, number>;
  win: WinUpdate | undefined;
  ticks: number;
  hashesCompared: number;
  /** Set when a tick threw, or when state diverged from `recorded`. */
  failure?: string;
}

/**
 * Runs the turn log through a fresh game.
 *
 * `recorded` is optional so the same loop serves both callers: verification
 * passes the hashes the players agreed on and stops at the first divergence,
 * while `simulateTurns` passes null to simply observe what this build computes.
 * One loop rather than two means the verified path and the observed path can
 * never drift apart.
 */
async function run(
  input: ReplayInput,
  recorded: Map<number, number> | null,
): Promise<SimulationResult> {
  if (simulationRan) {
    return {
      hashes: new Map(),
      win: undefined,
      ticks: 0,
      hashesCompared: 0,
      failure:
        "a simulation has already run in this process; the cached terrain map " +
        "carries the previous game's territory, so this replay would silently " +
        "produce a different game (see the note on simulationRan)",
    };
  }
  simulationRan = true;

  // Same wire blanking the client replay path applies (see toWireGameStartInfo).
  const gameStart: GameStartInfo = toWireGameStartInfo({
    gameID: input.gameID,
    lobbyCreatedAt: input.lobbyCreatedAt,
    config: input.config,
    players: input.players,
    tribes: input.tribes,
  });

  const config = new Config(input.config, null, false);
  const terrain = await loadTerrainMap(
    input.config.gameMap,
    input.config.gameMapSize,
    new NodeMapLoader(input.mapsDir),
    false,
  );

  // Every source of randomness is seeded from the game id, which the server
  // minted. Nothing here is drawn from wall-clock time or the environment.
  const random = new PseudoRandom(simpleHash(gameStart.gameID));
  const humans = gameStart.players.map(
    (p) =>
      new PlayerInfo(
        p.username,
        PlayerType.Human,
        p.clientID,
        random.nextID(),
        p.isLobbyCreator ?? false,
        p.clanTag,
        p.friends ?? [],
        p.teamIndex ?? null,
      ),
  );
  const nations = createNationsForGame(
    gameStart,
    terrain.nations,
    terrain.additionalNations,
    humans.length,
    random,
  );
  const game = createGame(
    humans,
    nations,
    terrain.gameMap,
    terrain.miniGameMap,
    config,
    terrain.teamGameSpawnAreas,
  );

  const hashes = new Map<number, number>();
  let win: WinUpdate | undefined;
  let fatalError: string | undefined;

  const runner = new GameRunner(
    game,
    new Executor(
      game,
      gameStart.gameID,
      undefined,
      gameStart.tribes?.map((t) => t.name),
    ),
    (gu) => {
      if ("errMsg" in gu) {
        fatalError = `${gu.errMsg}
${gu.stack ?? ""}`;
        return;
      }
      for (const hu of gu.updates[GameUpdateType.Hash] as HashUpdate[]) {
        hashes.set(hu.tick, hu.hash);
      }
      // The same update the clients derive their vote from — so the shape
      // handed to the settler is identical whichever path produced it.
      const wins = gu.updates[GameUpdateType.Win] as WinUpdate[];
      if (wins.length > 0) win = wins[wins.length - 1];
    },
  );
  runner.init();

  let ticks = 0;
  let hashesCompared = 0;
  for (const turn of input.turns) {
    runner.addTurn(turn);
    if (!runner.executeNextTick()) {
      return {
        hashes,
        win,
        ticks,
        hashesCompared,
        failure:
          `simulation failed at turn ${turn.turnNumber}: ` +
          (fatalError ?? "unknown error"),
      };
    }
    ticks++;

    if (recorded === null) continue;
    const computed = hashes.get(turn.turnNumber);
    const expected = recorded.get(turn.turnNumber);
    if (computed !== undefined && expected !== undefined) {
      hashesCompared++;
      if (computed !== expected) {
        // Stop at the first divergence. Everything after it is a different
        // game, so continuing would only burn CPU on an answer already known
        // to be untrustworthy.
        return {
          hashes,
          win,
          ticks,
          hashesCompared,
          failure:
            `state diverged from the recorded game at turn ${turn.turnNumber} ` +
            `(replayed ${computed}, players saw ${expected}) — this build does ` +
            "not reproduce the match that was played",
        };
      }
    }
  }

  return { hashes, win, ticks, hashesCompared };
}

/**
 * Runs the turn log and reports what this build computes, without judging it.
 *
 * Not used in settlement — `verifyReplay` is. It exists so the verifier can be
 * exercised against a game this same core produced, which is what makes the
 * round trip in ArenaReplayVerifier.test.ts a real test rather than a fixture
 * comparison.
 */
export async function simulateTurns(input: ReplayInput): Promise<{
  hashes: Map<number, number>;
  winner: Winner | undefined;
  ticks: number;
  failure?: string;
}> {
  const result = await run(input, null);
  return {
    hashes: result.hashes,
    winner: result.win?.winner,
    ticks: result.ticks,
    failure: result.failure,
  };
}

export async function verifyReplay(input: ReplayInput): Promise<ReplayVerdict> {
  const recorded = new Map<number, number>();
  for (const turn of input.turns) {
    if (turn.hash !== null && turn.hash !== undefined) {
      recorded.set(turn.turnNumber, turn.hash);
    }
  }

  const result = await run(input, recorded);
  if (result.failure !== undefined) {
    return { ok: false, reason: result.failure };
  }

  // No hash to check against means no way to tell whether this replay matches
  // what the players actually saw. A wagered lobby cannot start until the
  // escrow is full, so it always had at least two clients and therefore always
  // exchanged hashes (handleSynchronization only skips at <= 1 active client) —
  // zero comparisons means something is wrong with the record, not that the
  // game was small.
  if (result.hashesCompared === 0) {
    return {
      ok: false,
      reason:
        "the turn log carries no agreed state hashes, so the replay cannot be " +
        "checked against the game the players saw",
    };
  }

  return {
    ok: true,
    winner: result.win?.winner,
    allPlayersStats: result.win?.allPlayersStats ?? {},
    ticks: result.ticks,
    hashesCompared: result.hashesCompared,
  };
}
