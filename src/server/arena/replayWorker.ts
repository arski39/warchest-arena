// [ARENA] Phase 4 — worker-thread entry for the replay verifier.
//
// A replay is CPU-bound and long: the headless core runs at roughly 275
// ticks/sec on this hardware, and at a 100 ms turn interval a 30-minute match
// is ~18,000 ticks (about a minute of solid CPU), with the 3-hour cap around
// six and a half. Running that on the worker's event loop would stall every
// other live game it is serving, so it runs on its own thread.
//
// A `.ts` entry point is fine here: the server itself runs under tsx in
// production (supervisord runs `npm run start:server`, which is
// `tsx src/server/Server.ts`), and the loader reaches worker threads when the
// Worker inherits `process.execArgv` — which replayRunner.ts passes.
//
// Nothing in this file touches the chain. It computes a verdict and posts it;
// deciding what to do with a refusal is the caller's job.
import { parentPort, workerData } from "worker_threads";
import { verifyReplay, type ReplayInput } from "./replayVerifier";

async function main() {
  const input = workerData as ReplayInput;
  try {
    const verdict = await verifyReplay(input);
    parentPort?.postMessage(verdict);
  } catch (e) {
    // Never let the thread die with an unhandled rejection: the parent would
    // see an opaque exit code instead of a reason it can log.
    parentPort?.postMessage({
      ok: false,
      reason: `replay threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    });
  }
}

void main();
