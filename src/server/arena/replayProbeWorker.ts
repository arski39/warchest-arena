// [ARENA] Worker-thread entry for the boot probe's recording pass.
//
// The probe (publicLobbies.ts) proves this deployment can actually verify a
// match before public wagered lobbies are allowed. Verifying needs a recording
// to verify against, and in production that recording is the live game's own
// turn hashes — so the probe manufactures one here.
//
// This is a SEPARATE thread from the verification that follows it, and that is
// the whole reason this file exists rather than a `mode` flag on replayWorker.
// One simulation per process: `loadTerrainMap` memoizes the GameMap and the
// simulation writes territory into it, so recording and verifying in one thread
// would have the second run start on the first run's board. The verifier
// refuses that outright, which would make the probe fail for a reason that has
// nothing to do with the deployment.
//
// Nothing here decides anything. It observes and posts.
import { parentPort, workerData } from "worker_threads";
import type { ObservedReplay } from "./replayRunner";
import { simulateTurns, type ReplayInput } from "./replayVerifier";

async function main() {
  const input = workerData as ReplayInput;
  try {
    const observed = await simulateTurns(input);
    const result: ObservedReplay =
      observed.failure !== undefined
        ? { ok: false, reason: observed.failure }
        : { ok: true, hashes: [...observed.hashes] };
    parentPort?.postMessage(result);
  } catch (e) {
    // Never die with an unhandled rejection: the parent would see an opaque
    // exit code instead of a reason it can log.
    parentPort?.postMessage({
      ok: false,
      reason: `replay probe threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    } satisfies ObservedReplay);
  }
}

void main();
