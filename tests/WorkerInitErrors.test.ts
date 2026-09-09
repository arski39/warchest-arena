// [ARENA] What the game worker says when it fails to start.
//
// This exists because of a real production failure that could not be
// diagnosed. Joining a live match died with "Worker initialization timeout"
// and nothing else -- on two different machines, for the same game -- and that
// string turned out to be the only thing the code could ever say. The worker
// assigned `createGameRunner(...)` without a `.catch()`, and the client
// listened for `message` but never `error`, so a rejected map fetch, a bad
// GameConfig, a thrown terrain parser and an out-of-memory kill were all
// reported identically: by 60 seconds of silence.
//
// So these tests are not about the happy path. They pin that a failure names
// itself, and that it does so *promptly* -- the assertions deliberately never
// advance a timer, because a fix that still waits out the timeout would be no
// fix at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameStartInfo } from "../src/core/Schemas";

/** Whatever the worker should do when the main thread posts `init`. */
type InitBehaviour = (
  self: FakeWorker,
  message: { id: string },
) => void | Promise<void>;

let behaviour: InitBehaviour = () => {};

/**
 * A worker that is a plain event target. The real one is a Blob-inlined Vite
 * import, which cannot be constructed under vitest -- and mocking at that
 * specifier is also what keeps this test off the 3 MB map assets.
 */
class FakeWorker {
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const forType = this.listeners.get(type) ?? [];
    forType.push(fn);
    this.listeners.set(type, forType);
  }

  postMessage(message: { type: string; id: string }): void {
    if (message.type === "init") void behaviour(this, message);
  }

  terminate(): void {}

  /** Deliver a message as the real worker would, through the message channel. */
  emit(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

vi.mock("../src/core/worker/Worker.worker.ts?worker&inline", () => ({
  default: FakeWorker,
}));

// getCdnBase reads BOOTSTRAP_CONFIG/globals that do not exist in jsdom.
vi.mock("../src/core/AssetUrls", () => ({ getCdnBase: () => "" }));

import { WorkerClient } from "../src/core/worker/WorkerClient";

function client(): WorkerClient {
  return new WorkerClient({} as GameStartInfo, "test-client");
}

describe("[ARENA] game worker initialization failures", () => {
  beforeEach(() => {
    behaviour = () => {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the worker reports it initialized", async () => {
    behaviour = (worker, message) => {
      worker.emit("message", { data: { type: "initialized", id: message.id } });
    };
    await expect(client().initialize()).resolves.toBeUndefined();
  });

  it("rejects with the reason the worker gave, not a timeout", async () => {
    behaviour = (worker, message) => {
      worker.emit("message", {
        data: {
          type: "init_error",
          id: message.id,
          message: "Failed to load map.bin: Not Found",
          stack: "at loadBinaryFromUrl",
        },
      });
    };

    // Fake timers deliberately never advanced: the rejection must arrive on
    // its own. Before the fix this test would hang here rather than fail
    // fast, which is exactly what the bug did to a player.
    vi.useFakeTimers();
    const error = await client()
      .initialize()
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Failed to load map.bin");
    // The stack is the half that says *where*, and it is useless unless it is
    // actually carried into the message a human sees.
    expect((error as Error).message).toContain("at loadBinaryFromUrl");
    expect((error as Error).message).not.toContain("did not respond");
  });

  it("rejects when the worker dies outright and posts nothing", async () => {
    // A script that will not parse, an uncaught throw, an OOM kill: no message
    // is ever sent, so only the `error` event can report this. It is a
    // separate path from init_error, and both are needed -- a rejected promise
    // inside a worker does NOT fire `error`.
    behaviour = (worker) => {
      worker.emit("error", { message: "out of memory" });
    };

    vi.useFakeTimers();
    const error = await client()
      .initialize()
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("out of memory");
  });

  it("still times out when the worker genuinely goes quiet", async () => {
    // The timeout keeps its job -- it just no longer stands in for every other
    // failure. Its wording has to say so, or the next person reads a hang as a
    // crash again.
    vi.useFakeTimers();
    const promise = client()
      .initialize()
      .catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await promise;

    expect((error as Error).message).toContain("did not respond");
    expect((error as Error).message).toContain("no error was reported");
  });
});
