// @vitest-environment node
//
// [ARENA] The arena's RPC endpoint must be read on first use, not at import
// time.
//
// Server.ts calls dotenv.config() *after* its imports. ESM evaluates the whole
// module graph before any statement in the entry file runs, so a module-level
// read of SOLANA_RPC_URL saw nothing in the master process and fell back to
// devnet -- while forked workers, handed an already-populated process.env by
// cluster.fork(), read the right value. The master's boot preflight then
// reported the program "not deployed on this cluster" and, failing closed,
// never started the H2 sweeper.
//
// Nothing else can catch this: it type-checks, it lints, and every other arena
// test mocks rpcClient away precisely so it does not open sockets. Hence a
// suite whose entire job is the *timing* of one env read.
//
// node, not the repo's jsdom default: this is the only arena test that loads
// @solana/web3.js for real, and it only ever runs server-side.

import { afterEach, describe, expect, it, vi } from "vitest";

const MODULE = "../../src/server/arena/rpcClient";
const LOCAL = "http://127.0.0.1:8899";

/**
 * Imports rpcClient with SOLANA_RPC_URL absent, then sets it -- reproducing
 * dotenv landing after the module graph has been evaluated.
 */
async function importThenSetEnv(value: string | undefined) {
  vi.resetModules();
  vi.stubEnv("SOLANA_RPC_URL", undefined);
  const mod = await import(MODULE);
  vi.stubEnv("SOLANA_RPC_URL", value);
  return mod;
}

describe("[ARENA] arena rpc connection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reads SOLANA_RPC_URL on first use, not at import time", async () => {
    const { getConnection } = await importThenSetEnv(LOCAL);
    // The whole regression in one assertion: against a module-level
    // `new Connection(...)` this is the devnet default.
    expect(getConnection().rpcEndpoint).toBe(LOCAL);
  });

  it("still falls back to devnet when the variable is never set", async () => {
    vi.resetModules();
    vi.stubEnv("SOLANA_RPC_URL", undefined);
    const { getConnection } = await import(MODULE);
    expect(getConnection().rpcEndpoint).toBe("https://api.devnet.solana.com");
  });

  it("memoizes, so callers share one Connection", async () => {
    const { getConnection } = await importThenSetEnv(LOCAL);
    expect(getConnection()).toBe(getConnection());
  });

  it("does not pick up a later change to SOLANA_RPC_URL", async () => {
    // Documents the cost of memoizing: first use wins for the life of the
    // process. That is what every consumer already assumed when this was a
    // module-level const, and the server never repoints its RPC at runtime.
    const { getConnection } = await importThenSetEnv(LOCAL);
    expect(getConnection().rpcEndpoint).toBe(LOCAL);
    vi.stubEnv("SOLANA_RPC_URL", "http://127.0.0.1:9999");
    expect(getConnection().rpcEndpoint).toBe(LOCAL);
  });
});
