// [ARENA] Proves at boot that this deployment can actually verify a match.
//
// Phase 4 made the server derive a wagered match's winner by replaying it, and
// that is the only reason public wagered lobbies are defensible at all. So the
// flag that opens them must not be taken on trust: an image built without the
// map data, or without the TypeScript loader the worker thread needs, would
// leave every wagered match unverifiable — and unverifiable means "refuse to
// settle", so a public queue would fill lobbies that can only ever refund.
//
// The probe therefore does the real thing rather than checking for its parts:
// it plays a short game, takes the hashes that run produced as the recording,
// and asks the PRODUCTION verifier to re-derive it. A pass means a verification
// just succeeded in this process, on this box, with these files.
//
// It costs two worker threads and a couple of seconds, once, and only when the
// operator asked for public wagered lobbies. Two threads because of the
// one-simulation-per-process rule (see replayVerifier.ts) — recording and
// verifying cannot share a module registry.
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../core/game/Game";
import type { GameConfig, PlayerRecord, Turn } from "../../core/Schemas";
import {
  defaultMapsDir,
  observeReplay,
  runReplayVerification,
} from "./replayRunner";
import type { ReplayInput } from "./replayVerifier";

/**
 * Onion is the smallest shipped map (512x512, ~350 KB of binaries), so the
 * probe loads as little as it can while still exercising the real map
 * pipeline — NodeMapLoader reading real files out of resources/maps, which is
 * exactly the thing a bad image gets wrong.
 */
const PROBE_MAP = GameMapType.Onion;

/**
 * Enough ticks to cross several hash boundaries: GameImpl emits a state hash
 * every 10th tick, and a probe that compared zero hashes would prove nothing —
 * verifyReplay refuses that case outright, which is the behaviour being relied
 * on here rather than worked around.
 */
const PROBE_TURNS = 40;

/**
 * Per-half deadline. Generous because a cold boot on a small box competes with
 * everything else starting up, and the cost of being wrong is asymmetric: a
 * spuriously slow probe silently disables a feature, which is recoverable by
 * restarting, whereas hanging boot is not.
 */
const PROBE_TIMEOUT_MS = 60_000;

export type ProbeResult =
  | { ok: true; elapsedMs: number; hashesCompared: number }
  | { ok: false; reason: string };

function probeConfig(): GameConfig {
  return {
    gameMap: PROBE_MAP,
    gameMapSize: GameMapSize.Normal,
    gameType: GameType.Private,
    difficulty: Difficulty.Easy,
    gameMode: GameMode.FFA,
    bots: 0,
    nations: "default",
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    donateGold: false,
    donateTroops: false,
    randomSpawn: false,
    disabledUnits: [],
  };
}

/**
 * Two players who never act. The probe is testing whether the machinery runs
 * and reproduces itself, not whether anyone can play — intents would only add
 * ways for the probe to fail that have nothing to do with the deployment.
 */
function probePlayers(): PlayerRecord[] {
  return [
    {
      clientID: "client_probe_a",
      username: "probe_a",
      persistentID: "probe-a",
      teamIndex: null,
      friends: [],
      isLobbyCreator: true,
    },
    {
      clientID: "client_probe_b",
      username: "probe_b",
      persistentID: "probe-b",
      teamIndex: null,
      friends: [],
      isLobbyCreator: false,
    },
  ] as unknown as PlayerRecord[];
}

function probeTurns(): Turn[] {
  return Array.from({ length: PROBE_TURNS }, (_, i) => ({
    turnNumber: i,
    gameID: "arenaprobe",
    intents: [],
  }));
}

function probeInput(turns: Turn[], mapsDir: string): ReplayInput {
  return {
    gameID: "arenaprobe",
    lobbyCreatedAt: 1_700_000_000_000,
    config: probeConfig(),
    players: probePlayers(),
    turns,
    mapsDir,
  };
}

/**
 * Records a short game and then verifies it through the production path.
 *
 * Never throws: every failure is a reason string, because the caller's answer
 * to all of them is the same — leave public wagered lobbies off.
 */
export async function probeReplayVerification(
  mapsDir: string = defaultMapsDir(),
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const started = Date.now();

  // Pass 1 — play it, and keep the hashes as "what the players saw".
  const observed = await observeReplay(
    probeInput(probeTurns(), mapsDir),
    timeoutMs,
  );
  if (!observed.ok) {
    return {
      ok: false,
      reason: `could not run a probe match: ${observed.reason}`,
    };
  }
  if (observed.hashes.length === 0) {
    return {
      ok: false,
      reason:
        "the probe match produced no state hashes, so nothing could be " +
        "verified against it",
    };
  }

  // Pass 2 — the real verifier, on a fresh thread, against that recording.
  const recorded = new Map(observed.hashes);
  const turns = probeTurns().map((t) => {
    const hash = recorded.get(t.turnNumber);
    return hash === undefined ? t : { ...t, hash };
  });
  const verdict = await runReplayVerification(
    probeInput(turns, mapsDir),
    timeoutMs,
  );
  if (!verdict.ok) {
    return {
      ok: false,
      reason: `verification of the probe match failed: ${verdict.reason}`,
    };
  }

  return {
    ok: true,
    elapsedMs: Date.now() - started,
    hashesCompared: verdict.hashesCompared,
  };
}
