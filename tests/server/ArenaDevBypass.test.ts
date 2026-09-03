// [ARENA] Phase 2: the dev bypasses must be opt-in, and must refuse to
// activate against a cluster whose tokens are real.
//
// Two bypasses used to fire on GameEnv.Dev alone — the jti-nonce fallback and
// the on-chain stake check. Together they let a player hold a wagered seat
// without paying, which fills the escrow to InProgress with a partial pot that
// then settles and pays out. With ARENA_PROGRAM_ID pointed at anything real,
// that is dev mode moving real tokens.
//
// The genesis hash rather than the URL because the URL proves nothing: a
// provider endpoint need not contain "devnet", a proxy can hide it, and a
// typo'd variable pointing at mainnet reads as ordinary text.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TESTNET = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
// What a freshly-started `solana-test-validator` reports: a new hash each run.
const LOCAL = "9tnQqPjEhJPRXBpm3fPMKZpNMDVHqMPKPHDPFVvxjEZm";

const getGenesisHash = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock("../../src/server/arena/rpcClient", () => ({
  getConnection: () => ({ getGenesisHash }),
}));

/** Fresh module state per case — the resolved flag is module-level by design. */
async function loadDevBypass() {
  vi.resetModules();
  return import("../../src/server/arena/devBypass");
}

describe("[ARENA] dev bypass", () => {
  beforeEach(() => {
    getGenesisHash.mockReset();
    // GAME_ENV is dev under vitest; these cases turn on ARENA_DEV_BYPASS only.
    vi.stubEnv("ARENA_DEV_BYPASS", "true");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("opt-in", () => {
    it("is off when ARENA_DEV_BYPASS is unset, without asking the chain", async () => {
      vi.stubEnv("ARENA_DEV_BYPASS", "");
      const m = await loadDevBypass();

      expect(await m.resolveDevBypass()).toBe(false);
      expect(m.devBypassEnabled()).toBe(false);
      // Being in dev is not a request. Never spend an RPC call deciding that.
      expect(getGenesisHash).not.toHaveBeenCalled();
    });

    it('treats any value other than "true" as off', async () => {
      vi.stubEnv("ARENA_DEV_BYPASS", "1");
      const m = await loadDevBypass();
      expect(m.devBypassRequested()).toBe(false);
      expect(await m.resolveDevBypass()).toBe(false);
    });

    it("reads false before resolve is ever called", async () => {
      // Fail closed: an unresolved flag must not read as permission.
      const m = await loadDevBypass();
      expect(m.devBypassEnabled()).toBe(false);
    });
  });

  describe("cluster gate", () => {
    it("refuses on mainnet-beta", async () => {
      getGenesisHash.mockResolvedValue(MAINNET);
      const m = await loadDevBypass();

      expect(await m.resolveDevBypass()).toBe(false);
      expect(m.devBypassEnabled()).toBe(false);
      // Loud, and an error rather than a warning: this is a misconfiguration
      // that would otherwise pay out real tokens to someone who never staked.
      expect(console.error).toHaveBeenCalled();
    });

    it.each([
      ["devnet", DEVNET],
      ["testnet", TESTNET],
      ["a local test validator", LOCAL],
    ])("allows %s", async (_label, genesis) => {
      getGenesisHash.mockResolvedValue(genesis);
      const m = await loadDevBypass();

      expect(await m.resolveDevBypass()).toBe(true);
      expect(m.devBypassEnabled()).toBe(true);
    });

    it("refuses when the cluster cannot be identified", async () => {
      // Fail closed. An unreachable RPC cannot rule out mainnet, and a quietly
      // disabled bypass in dev beats a wrongly enabled one anywhere else.
      getGenesisHash.mockRejectedValue(new Error("ECONNREFUSED"));
      const m = await loadDevBypass();

      expect(await m.resolveDevBypass()).toBe(false);
      expect(m.devBypassEnabled()).toBe(false);
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("the nonce fallback follows the resolved value", () => {
    // walletAuthNonce is the consumer that decides whether an anonymous session
    // may sign the game id instead of a jti.
    async function loadAuth() {
      vi.resetModules();
      return import("../../src/server/arena/auth");
    }

    it("refuses an anonymous session while the bypass is off", async () => {
      vi.stubEnv("ARENA_DEV_BYPASS", "");
      const m = await loadDevBypass();
      await m.resolveDevBypass();
      const { walletAuthNonce } = await loadAuth();

      expect(walletAuthNonce(null, "game1")).toBeUndefined();
    });

    it("accepts an anonymous session once the bypass resolves on", async () => {
      getGenesisHash.mockResolvedValue(DEVNET);
      // Same module graph for both, or auth.ts would import a second copy of
      // devBypass whose state was never resolved.
      vi.resetModules();
      const m = await import("../../src/server/arena/devBypass");
      await m.resolveDevBypass();
      const { walletAuthNonce } = await import("../../src/server/arena/auth");

      expect(walletAuthNonce(null, "game1")).toBe("dev-game:game1");
    });

    it("always prefers a real jti, bypass or not", async () => {
      getGenesisHash.mockResolvedValue(DEVNET);
      vi.resetModules();
      const m = await import("../../src/server/arena/devBypass");
      await m.resolveDevBypass();
      const { walletAuthNonce } = await import("../../src/server/arena/auth");

      expect(walletAuthNonce({ jti: "real" } as never, "game1")).toBe("real");
    });
  });
});

describe("[ARENA] stake cap", () => {
  // The accepted-risk section says not to raise stake limits while the winner
  // is decided by client vote. Until this landed there was no limit to raise:
  // the endpoint took any non-zero u64 and the program bounds rake_bps and
  // max_players but not entry_fee.
  async function loadCap() {
    vi.resetModules();
    return import("../../src/server/arena/matchCreator");
  }

  afterEach(() => vi.unstubAllEnvs());

  it("allows anything when no cap is configured", async () => {
    vi.stubEnv("ARENA_MAX_ENTRY_FEE", "");
    const { arenaMaxEntryFee, entryFeeWithinCap } = await loadCap();

    expect(arenaMaxEntryFee()).toBeNull();
    expect(entryFeeWithinCap(2n ** 63n)).toBe(true);
  });

  it("permits exactly the cap and rejects one unit above", async () => {
    vi.stubEnv("ARENA_MAX_ENTRY_FEE", "1000");
    const { entryFeeWithinCap } = await loadCap();

    expect(entryFeeWithinCap(999n)).toBe(true);
    expect(entryFeeWithinCap(1000n)).toBe(true);
    expect(entryFeeWithinCap(1001n)).toBe(false);
  });

  it("handles caps above Number.MAX_SAFE_INTEGER", async () => {
    // Token base units are u64. Parsing through Number would round these two
    // to the same value and silently let the larger stake through.
    vi.stubEnv("ARENA_MAX_ENTRY_FEE", "9007199254740993");
    const { entryFeeWithinCap } = await loadCap();

    expect(entryFeeWithinCap(9007199254740993n)).toBe(true);
    expect(entryFeeWithinCap(9007199254740994n)).toBe(false);
  });

  it.each([["-1"], ["0"], ["abc"], ["1.5"], ["1e9"]])(
    "refuses the nonsensical cap %s rather than ignoring it",
    async (raw) => {
      vi.stubEnv("ARENA_MAX_ENTRY_FEE", raw);
      const { arenaMaxEntryFee } = await loadCap();
      // Throwing beats defaulting to "no cap": a typo'd ceiling that silently
      // means unlimited is the exact failure this task exists to prevent.
      expect(() => arenaMaxEntryFee()).toThrow();
    },
  );
});
