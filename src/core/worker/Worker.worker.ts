import { assetUrl } from "../AssetUrls";
import { FetchGameMapLoader } from "../game/FetchGameMapLoader";
import { ErrorUpdate, GameUpdateViewData } from "../game/GameUpdates";
import { createGameRunner, GameRunner } from "../GameRunner";
import {
  AttackClusteredPositionsResultMessage,
  InitErrorMessage,
  InitializedMessage,
  MainThreadMessage,
  PlayerActionsResultMessage,
  PlayerBorderTilesResultMessage,
  PlayerBuildablesResultMessage,
  PlayerProfileResultMessage,
  TransportShipSpawnResultMessage,
  WorkerMessage,
} from "./WorkerMessages";

const ctx: Worker = self as any;
globalThis.__ASSET_MANIFEST__ = __ASSET_MANIFEST__;
let gameRunner: Promise<GameRunner> | null = null;

/**
 * [ARENA] Tell the main thread why init failed, and log it worker-side.
 *
 * Both halves matter: the message is what the player sees instead of a bare
 * timeout, and the console line is what survives when the tab is closed before
 * anyone reads the screen.
 *
 * Sends strings rather than the Error itself -- structured clone preserves
 * `message` and `stack` but drops subclass fields silently, so flattening here
 * is honest about what actually crosses the boundary.
 */
function reportInitError(id: string | undefined, error: unknown): void {
  console.error("Failed to initialize game runner:", error);
  sendMessage({
    type: "init_error",
    id,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  } as InitErrorMessage);
}
const mapLoader = new FetchGameMapLoader((path) => assetUrl(`maps/${path}`));
// Yield threshold; not a backlog cap. Used to avoid monopolizing the worker task
// and flooding the main thread with messages during catch-up.
const MAX_TICKS_BEFORE_YIELD = 4;

let drainScheduled = false;
let draining = false;
let drainRequested = false;

function scheduleDrain(): void {
  drainRequested = true;
  if (drainScheduled || draining) {
    return;
  }
  drainScheduled = true;
  setTimeout(() => {
    void drain().catch((e) => {
      console.error("Worker drain failed:", e);
    });
  }, 0);
}

async function drain(): Promise<void> {
  drainScheduled = false;
  if (draining) {
    return;
  }
  if (!gameRunner) {
    return;
  }

  draining = true;
  drainRequested = false;
  let shouldContinue: boolean;
  try {
    const gr = await gameRunner;
    if (!gr) {
      return;
    }

    const batch: GameUpdateViewData[] = [];
    const onTickUpdate = (gu: GameUpdateViewData | ErrorUpdate) => {
      if (!("updates" in gu)) {
        if ("errMsg" in gu) {
          sendMessage({ type: "game_error", error: gu } as WorkerMessage);
        }
        return;
      }
      batch.push(gu);
    };

    // Temporarily route tick callbacks into this drain's batch.
    tickUpdateSink = onTickUpdate;

    let ticksRun = 0;
    while (ticksRun < MAX_TICKS_BEFORE_YIELD && gr.pendingTurns() > 0) {
      const ok = gr.executeNextTick(gr.pendingTurns());
      if (!ok) {
        break;
      }
      ticksRun++;
    }

    tickUpdateSink = null;

    sendGameUpdateBatch(batch);

    shouldContinue = gr.pendingTurns() > 0;
  } finally {
    tickUpdateSink = null;
    draining = false;
  }

  if (shouldContinue || drainRequested) {
    scheduleDrain();
  }
}

let tickUpdateSink: ((gu: GameUpdateViewData | ErrorUpdate) => void) | null =
  null;

function gameUpdate(gu: GameUpdateViewData | ErrorUpdate) {
  tickUpdateSink?.(gu);
}

function sendGameUpdateBatch(gameUpdates: GameUpdateViewData[]): void {
  if (gameUpdates.length === 0) {
    return;
  }

  const transfers: Transferable[] = [];
  for (const gu of gameUpdates) {
    transfers.push(gu.packedTileUpdates.buffer);
    if (gu.packedMotionPlans) {
      transfers.push(gu.packedMotionPlans.buffer);
    }
    if (gu.packedPlayerUpdates) {
      transfers.push(gu.packedPlayerUpdates.buffer);
    }
    if (gu.packedAttackUpdates) {
      transfers.push(gu.packedAttackUpdates.buffer);
    }
    if (gu.packedNukeImpacts) {
      transfers.push(gu.packedNukeImpacts.buffer);
    }
  }

  ctx.postMessage(
    {
      type: "game_update_batch",
      gameUpdates,
    } as WorkerMessage,
    transfers,
  );
}

function sendMessage(message: WorkerMessage) {
  ctx.postMessage(message);
}

ctx.addEventListener("message", async (e: MessageEvent<MainThreadMessage>) => {
  const message = e.data;

  switch (message.type) {
    case "init":
      try {
        // Set before createGameRunner so map fetches via mapLoader pick up the
        // CDN base. Workers have no `window`, so AssetUrls falls back to this.
        globalThis.__CDN_BASE__ = message.cdnBase;
        // [ARENA] Set alongside it and for the same reason: with no CDN
        // configured this is the only thing that makes a map URL absolute, and
        // a blob worker cannot fetch a root-relative one.
        globalThis.__ASSET_ORIGIN__ = message.assetOrigin;
        gameRunner = createGameRunner(
          message.gameStartInfo,
          message.clientID,
          mapLoader,
          gameUpdate,
        ).then((gr) => {
          sendMessage({
            type: "initialized",
            id: message.id,
          } as InitializedMessage);
          return gr;
        });
        // [ARENA] Report an async failure instead of swallowing it.
        //
        // The try/catch around this only ever caught a SYNCHRONOUS throw --
        // everything that actually fails here happens inside the promise (the
        // map fetch, the terrain parse, config construction), and a rejection
        // with no handler left the main thread waiting out its full 60-second
        // timeout with no idea why. That is how a real production failure
        // reported itself as "Worker initialization timeout" and nothing else.
        //
        // The catch is attached to a throwaway chain rather than reassigning
        // gameRunner: the value awaited for turns must stay the original
        // promise, or a failed init would resolve to undefined here and every
        // later `gr.addTurn` would throw far away from the cause.
        void gameRunner.catch((error: unknown) => {
          reportInitError(message.id, error);
        });
      } catch (error) {
        // A synchronous throw is the same failure as far as the caller is
        // concerned, so it takes the same path rather than an unhandled
        // `throw` that the main thread cannot see either.
        reportInitError(message.id, error);
      }
      break;

    case "turn":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const gr = await gameRunner;
        gr.addTurn(message.turn);
        scheduleDrain();
      } catch (error) {
        console.error("Failed to process turn:", error);
        throw error;
      }
      break;

    case "player_actions":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const actions = (await gameRunner).playerActions(
          message.playerID,
          message.x,
          message.y,
          message.units,
        );
        sendMessage({
          type: "player_actions_result",
          id: message.id,
          result: actions,
        } as PlayerActionsResultMessage);
      } catch (error) {
        console.error("Failed to get actions:", error);
        throw error;
      }
      break;
    case "player_buildables":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const buildables = (await gameRunner).playerBuildables(
          message.playerID,
          message.x,
          message.y,
          message.units,
        );
        sendMessage({
          type: "player_buildables_result",
          id: message.id,
          result: buildables,
        } as PlayerBuildablesResultMessage);
      } catch (error) {
        console.error("Failed to get buildables:", error);
        throw error;
      }
      break;
    case "player_profile":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const profile = (await gameRunner).playerProfile(message.playerID);
        sendMessage({
          type: "player_profile_result",
          id: message.id,
          result: profile,
        } as PlayerProfileResultMessage);
      } catch (error) {
        console.error("Failed to get profile:", error);
        throw error;
      }
      break;
    case "player_border_tiles":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const borderTiles = (await gameRunner).playerBorderTiles(
          message.playerID,
        );
        sendMessage({
          type: "player_border_tiles_result",
          id: message.id,
          result: borderTiles,
        } as PlayerBorderTilesResultMessage);
      } catch (error) {
        console.error("Failed to get border tiles:", error);
        throw error;
      }
      break;
    case "attack_clustered_positions":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const attacks = (await gameRunner).attackClusteredPositions(
          message.playerID,
          message.attackID,
        );
        sendMessage({
          type: "attack_clustered_positions_result",
          id: message.id,
          attacks,
        } as AttackClusteredPositionsResultMessage);
      } catch (error) {
        console.error("Failed to get attack front line centers:", error);
        sendMessage({
          type: "attack_clustered_positions_result",
          id: message.id,
          attacks: [],
        } as AttackClusteredPositionsResultMessage);
      }
      break;
    case "transport_ship_spawn":
      if (!gameRunner) {
        throw new Error("Game runner not initialized");
      }

      try {
        const spawnTile = (await gameRunner).bestTransportShipSpawn(
          message.playerID,
          message.targetTile,
        );
        sendMessage({
          type: "transport_ship_spawn_result",
          id: message.id,
          result: spawnTile,
        } as TransportShipSpawnResultMessage);
      } catch (error) {
        console.error("Failed to spawn transport ship:", error);
      }
      break;
    default:
      console.warn("Unknown message :", message);
  }
});

// Error handling
ctx.addEventListener("error", (error) => {
  console.error("Worker error:", error);
});

ctx.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection in worker:", event);
});
