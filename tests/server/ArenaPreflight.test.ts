// [ARENA] H1.3: everything that can be wrong with the wager configuration
// should be found at boot, not when a host presses the button.
//
// The old check asked only whether two env vars were non-empty. The failures it
// let through got progressively worse:
//
//   * a bogus program id or an unfunded authority -> create_match fails, so the
//     host gets a 500 on a lobby they have already set up;
//   * ARENA_RAKE_BPS > 0 with no TREASURY_TOKEN_ACCOUNT -> nothing fails until
//     settlement, by which point the stakes are escrowed and settler.ts refuses
//     to guess where the rake goes. The pot sits there.
//
// Disabling wagering at boot is safe by construction: it is the same state as a
// server that was never configured for it.

import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const AUTHORITY = Keypair.generate();
const PROGRAM_ID = "11111111111111111111111111111112";
const TREASURY = "11111111111111111111111111111113";

const getAccountInfo = vi.hoisted(() => vi.fn());
const getBalance = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/rpcClient", () => ({
  connection: { getAccountInfo, getBalance },
}));

const serverKeypair = vi.hoisted(() => vi.fn());
const serverKeypairPath = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/serverKeypair", () => ({
  serverKeypair,
  serverKeypairPath,
}));

/** Fresh module state per case — the outcome is module-level by design. */
async function run() {
  vi.resetModules();
  const m = await import("../../src/server/arena/preflight");
  const outcome = await m.runWagerPreflight();
  return { outcome, ...m };
}

/** An executable account, i.e. a deployed program. */
const deployedProgram = { executable: true, data: Buffer.alloc(0) };

describe("[ARENA] wager preflight", () => {
  beforeEach(() => {
    vi.stubEnv("ARENA_PROGRAM_ID", PROGRAM_ID);
    vi.stubEnv("ARENA_RAKE_BPS", "0");
    vi.stubEnv("ARENA_MAX_ENTRY_FEE", "");
    vi.stubEnv("TREASURY_TOKEN_ACCOUNT", "");
    serverKeypair.mockReturnValue(AUTHORITY);
    serverKeypairPath.mockReturnValue("/run/secrets/arena-authority.json");
    getAccountInfo.mockResolvedValue(deployedProgram);
    getBalance.mockResolvedValue(1_000_000_000); // 1 SOL
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    getAccountInfo.mockReset();
    getBalance.mockReset();
  });

  it("passes a fully configured server", async () => {
    const { outcome, wageringOperational, wagerDisabledReason } = await run();
    expect(outcome.state).toBe("ok");
    expect(wageringOperational()).toBe(true);
    expect(wagerDisabledReason()).toBeNull();
  });

  it("reads not-operational before it has run", async () => {
    // Fail closed. A lobby served in the gap must look free-to-play, not
    // half-verified.
    vi.resetModules();
    const m = await import("../../src/server/arena/preflight");
    expect(m.wageringOperational()).toBe(false);
  });

  describe("off rather than broken", () => {
    it("is simply off when ARENA_PROGRAM_ID is unset", async () => {
      vi.stubEnv("ARENA_PROGRAM_ID", "");
      const { outcome, wageringOperational, wagerDisabledReason } = await run();

      expect(outcome.state).toBe("off");
      expect(wageringOperational()).toBe(false);
      // Not an error: free-to-play is the documented default, so it must not
      // read as a misconfiguration.
      expect(wagerDisabledReason()).toBeNull();
      expect(console.error).not.toHaveBeenCalled();
      expect(getAccountInfo).not.toHaveBeenCalled();
    });

    it("but a malformed ARENA_PROGRAM_ID is broken, not off", async () => {
      // A typo must not silently degrade to "wagering was never wanted".
      vi.stubEnv("ARENA_PROGRAM_ID", "not-base58!!");
      const { outcome, wagerDisabledReason } = await run();

      expect(outcome.state).toBe("broken");
      expect(wagerDisabledReason()).toMatch(/not a valid base58/);
    });
  });

  describe("configuration that would fail later", () => {
    it("rejects a program id with no keypair to act as authority", async () => {
      serverKeypairPath.mockReturnValue(undefined);
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/SERVER_KEYPAIR_PATH/);
    });

    it("rejects a keypair file that does not load", async () => {
      serverKeypair.mockImplementation(() => {
        throw new Error("must contain a 64-byte JSON array");
      });
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/64-byte/);
    });

    it("rejects a rake with nowhere to send it", async () => {
      // The one that would otherwise strand a pot: settlement refuses a rake it
      // cannot deliver, and by then the stakes are already in the vault.
      vi.stubEnv("ARENA_RAKE_BPS", "500");
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/TREASURY_TOKEN_ACCOUNT is unset/);
    });

    it("accepts a rake once a treasury is configured", async () => {
      vi.stubEnv("ARENA_RAKE_BPS", "500");
      vi.stubEnv("TREASURY_TOKEN_ACCOUNT", TREASURY);
      const { outcome } = await run();
      expect(outcome.state).toBe("ok");
    });

    it("rejects a malformed treasury address", async () => {
      vi.stubEnv("ARENA_RAKE_BPS", "500");
      vi.stubEnv("TREASURY_TOKEN_ACCOUNT", "nope!!");
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(
        /TREASURY_TOKEN_ACCOUNT is not a valid/,
      );
    });

    it("rejects an out-of-range rake", async () => {
      // arenaRakeBps() throws only when called, which used to be mid-lobby.
      vi.stubEnv("ARENA_RAKE_BPS", "5000");
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/ARENA_RAKE_BPS/);
    });

    it("rejects a malformed stake cap", async () => {
      vi.stubEnv("ARENA_MAX_ENTRY_FEE", "lots");
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/ARENA_MAX_ENTRY_FEE/);
    });
  });

  describe("what the cluster says", () => {
    it("rejects a program id that is not deployed here", async () => {
      // The realistic case: a valid id, but from a different cluster.
      getAccountInfo.mockResolvedValue(null);
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/not deployed here/);
    });

    it("rejects an account that exists but is not a program", async () => {
      getAccountInfo.mockResolvedValue({
        executable: false,
        data: Buffer.alloc(0),
      });
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/not executable/);
    });

    it("rejects an authority that cannot pay for a match", async () => {
      // Rent is never reclaimed, so this only ever gets worse in operation.
      getBalance.mockResolvedValue(1_000);
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/below the/);
    });

    it("accepts a balance exactly at the floor", async () => {
      const { MIN_AUTHORITY_LAMPORTS } =
        await import("../../src/server/arena/preflight");
      getBalance.mockResolvedValue(MIN_AUTHORITY_LAMPORTS);
      const { outcome } = await run();
      expect(outcome.state).toBe("ok");
    });

    it("rejects when the RPC cannot be reached", async () => {
      // Fail closed, like the dev-bypass gate: an RPC we cannot reach at boot
      // is one we cannot settle through either.
      getAccountInfo.mockRejectedValue(new Error("ECONNREFUSED"));
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/could not reach the RPC/);
    });

    it("checks the authority's balance, not some other account", async () => {
      await run();
      expect(getBalance).toHaveBeenCalledWith(
        expect.any(PublicKey) as unknown as PublicKey,
      );
      const asked = getBalance.mock.calls[0][0] as PublicKey;
      expect(asked.toBase58()).toBe(AUTHORITY.publicKey.toBase58());
    });
  });
});
