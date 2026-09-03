// [ARENA] Phase 4 — runs the replay verifier on its own thread, with a
// deadline, and never throws.
//
// Every failure here resolves to `ok: false` with a reason rather than
// rejecting, because the caller's response to "could not verify" is the same
// whatever the cause: do not settle. The stakes then fall to the escrow's 24h
// timeout-cancel, which refunds every player. Refusing to pay is always
// recoverable; paying the wrong wallet is not.
import path from "path";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import type { ReplayInput, ReplayVerdict } from "./replayVerifier";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the map data the simulation needs. */
export function defaultMapsDir(): string {
  return path.resolve(HERE, "../../../resources/maps");
}

/**
 * Wall-clock ceiling on one verification.
 *
 * The longest game the server allows is MAX_GAME_DURATION_MS (3 h), which is
 * ~108,000 ticks and roughly six and a half minutes of simulation. 15 minutes
 * leaves better than 2x headroom on a busy or slower box while still being far
 * inside the escrow's 24h timeout, so a wedged replay cannot hold a pot hostage
 * — it gives up, declines to settle, and the timeout refunds everyone.
 */
export const REPLAY_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * execArgv for the worker, guaranteeing it can load a `.ts` entry point.
 *
 * A worker only inherits a TypeScript loader if the parent process was started
 * by one. That holds in production — supervisord runs `npm run start:server`,
 * which is `tsx src/server/Server.ts` — but not under vitest, whose runner
 * transforms modules itself and leaves execArgv bare, so the worker dies with
 * "Cannot find module .../replayVerifier".
 *
 * Requesting the loader explicitly makes the same code path work in both. tsx
 * is a runtime dependency, not a dev one, and the image builds with
 * `npm ci --omit=dev`, so it is present where this runs.
 */
function workerExecArgv(): string[] {
  const alreadyLoaded = process.execArgv.some((a) => a.includes("tsx"));
  return alreadyLoaded
    ? process.execArgv
    : [...process.execArgv, "--import", "tsx"];
}

/**
 * Spawns one worker, resolves with whatever it posts, and never rejects.
 *
 * Shared by verification and by the boot probe so there is exactly one place
 * that knows how to get a `.ts` worker running with a deadline. `failed` turns
 * a reason into the caller's own result shape, which is what lets the two
 * callers keep different verdict types without duplicating the plumbing.
 */
function runWorker<T>(
  entry: URL,
  input: unknown,
  timeoutMs: number,
  failed: (reason: string) => T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    };

    const worker = new Worker(entry, {
      workerData: input,
      // See workerExecArgv: without a TypeScript loader the thread cannot
      // import this module's own .ts siblings.
      execArgv: workerExecArgv(),
    });

    const timer = setTimeout(() => {
      finish(
        failed(`replay did not finish within ${Math.round(timeoutMs / 1000)}s`),
      );
    }, timeoutMs);

    worker.on("message", (msg: T) => finish(msg));
    worker.on("error", (e: Error) =>
      finish(failed(`replay worker error: ${e.message}`)),
    );
    worker.on("exit", (code) => {
      // Only meaningful if it beat the message; a clean exit after posting a
      // result is the normal path and `settled` swallows it.
      finish(failed(`replay worker exited early with code ${code}`));
    });
  });
}

export function runReplayVerification(
  input: ReplayInput,
  timeoutMs: number = REPLAY_TIMEOUT_MS,
): Promise<ReplayVerdict> {
  return runWorker<ReplayVerdict>(
    new URL("./replayWorker.ts", import.meta.url),
    input,
    timeoutMs,
    (reason) => ({ ok: false, reason }),
  );
}

/** What `observeReplay` saw, with hashes as pairs so the clone is explicit. */
export type ObservedReplay =
  | { ok: true; hashes: [number, number][] }
  | { ok: false; reason: string };

/**
 * Runs the turn log and reports the hashes this build computes, judging
 * nothing.
 *
 * NOT part of settlement — `runReplayVerification` is. It exists so the boot
 * probe (publicLobbies.ts) can manufacture a recording to then verify against,
 * standing in for the live game whose clients agreed those hashes. It has to be
 * its own thread for the same reason the second half does: one simulation per
 * process, because the terrain map is memoized and the simulation mutates it.
 */
export function observeReplay(
  input: ReplayInput,
  timeoutMs: number = REPLAY_TIMEOUT_MS,
): Promise<ObservedReplay> {
  return runWorker<ObservedReplay>(
    new URL("./replayProbeWorker.ts", import.meta.url),
    input,
    timeoutMs,
    (reason) => ({ ok: false, reason }),
  );
}
