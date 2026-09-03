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
// [ARENA] The deployment's staking token. Stakes are denominated in tiers now,
// so preflight has to resolve a mint and read its decimals before it can say
// what a "5" costs.
const STAKE_MINT = "11111111111111111111111111111114";
const TOKEN_PROGRAM = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_2022_PROGRAM = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/** A legacy SPL mint: 82 bytes, decimals at 44, is_initialized at 45. */
function mintAccount(
  decimals: number,
  { initialized = true, freezeAuthority = false } = {},
) {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = initialized ? 1 : 0;
  if (freezeAuthority) data.writeUInt32LE(1, 46);
  return { owner: TOKEN_PROGRAM, data, executable: false };
}

/** A legacy SPL token account: 165 bytes, mint at 0..32. */
function tokenAccount(mint: string) {
  const data = Buffer.alloc(165);
  data.set(new PublicKey(mint).toBytes(), 0);
  return { owner: TOKEN_PROGRAM, data, executable: false };
}

const getAccountInfo = vi.hoisted(() => vi.fn());
const getBalance = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/rpcClient", () => ({
  getConnection: () => ({ getAccountInfo, getBalance }),
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

// [ARENA] preflight now fetches more than one address, so the mock has to
// answer per-address rather than returning the same account to everyone.
// Overriding one entry is how a case says "this specific account is wrong".
let accounts: Record<string, unknown>;
function accountFor(key: PublicKey | string) {
  const k = typeof key === "string" ? key : key.toBase58();
  return accounts[k] ?? null;
}

describe("[ARENA] wager preflight", () => {
  beforeEach(() => {
    vi.stubEnv("ARENA_PROGRAM_ID", PROGRAM_ID);
    vi.stubEnv("ARENA_RAKE_BPS", "0");
    vi.stubEnv("ARENA_MAX_ENTRY_FEE", "");
    vi.stubEnv("TREASURY_TOKEN_ACCOUNT", "");
    serverKeypair.mockReturnValue(AUTHORITY);
    serverKeypairPath.mockReturnValue("/run/secrets/arena-authority.json");
    vi.stubEnv("ARENA_STAKE_MINT", STAKE_MINT);
    vi.stubEnv("ARENA_STAKE_SYMBOL", "ARENA");
    accounts = {
      [PROGRAM_ID]: deployedProgram,
      [STAKE_MINT]: mintAccount(6),
      [TREASURY]: tokenAccount(STAKE_MINT),
    };
    getAccountInfo.mockImplementation(async (key: PublicKey) =>
      accountFor(key),
    );
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

  // [ARENA] The staking token. A tier ("5") is meaningless without a known mint
  // and its decimals, so resolving one is now part of being operational.
  describe("the staking mint", () => {
    async function stake() {
      const { outcome } = await run();
      const { stakeMint } = await import("../../src/server/arena/stakeMint");
      return { outcome, stake: stakeMint() };
    }

    it("refuses when ARENA_STAKE_MINT is unset", async () => {
      // Fail closed rather than falling back to "off": the operator asked for
      // wagering by setting ARENA_PROGRAM_ID, so silence here would be a
      // free-to-play server that looks configured.
      vi.stubEnv("ARENA_STAKE_MINT", "");
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/ARENA_STAKE_MINT is not/);
    });

    it("refuses an unparseable mint address", async () => {
      vi.stubEnv("ARENA_STAKE_MINT", "not-base58!");
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/not a valid base58/);
    });

    it("refuses when the mint does not exist on this cluster", async () => {
      accounts[STAKE_MINT] = null;
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/no account at ARENA_STAKE_MINT/);
    });

    it("refuses a Token-2022 mint", async () => {
      // THE mutation-checked one. The program pins Program<Token>, so a
      // Token-2022 mint can never be escrowed. Without the owner check this
      // decodes fine and the refusal moves to a failed create_match on a lobby
      // the host has already set up.
      accounts[STAKE_MINT] = {
        ...mintAccount(6),
        owner: TOKEN_2022_PROGRAM,
      };
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/not the SPL Token program/);
    });

    it("refuses an uninitialized mint", async () => {
      // Decodes as decimals = 0, which would silently turn every tier into
      // 1/5/25 base units — a stake of 0.000001 that looks entirely normal.
      accounts[STAKE_MINT] = mintAccount(6, { initialized: false });
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/not initialized/);
    });

    it("refuses an account of the wrong length", async () => {
      accounts[STAKE_MINT] = {
        owner: TOKEN_PROGRAM,
        data: Buffer.alloc(40),
        executable: false,
      };
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/expected 82 bytes/);
    });

    it("refuses more decimals than the largest tier can survive", async () => {
      // 25 * 10^18 overflows a u64, which would throw inside
      // buildCreateMatchIx and surface as a 502 on a live lobby. The supported
      // ceiling is deliberately stricter than the arithmetic one.
      accounts[STAKE_MINT] = mintAccount(18);
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/maximum supported is 9/);
    });

    it("exposes the decimals and every tier when uncapped", async () => {
      const { outcome, stake: resolved } = await stake();
      expect(outcome.state).toBe("ok");
      expect(resolved?.decimals).toBe(6);
      expect(resolved?.tiers).toEqual([1, 5, 25]);
      expect(resolved?.entryFees.get(25)).toBe(25_000_000n);
    });

    it("offers only the tiers ARENA_MAX_ENTRY_FEE allows", async () => {
      // One cap knob, not two: the existing ceiling filters the tier list
      // rather than getting a parallel ARENA_MAX_STAKE_TIER beside it.
      vi.stubEnv("ARENA_MAX_ENTRY_FEE", "5000000"); // 5 tokens at 6 decimals
      const { outcome, stake: resolved } = await stake();
      expect(outcome.state).toBe("ok");
      expect(resolved?.tiers).toEqual([1, 5]);
    });

    it("refuses when the cap suppresses every tier", async () => {
      vi.stubEnv("ARENA_MAX_ENTRY_FEE", "1");
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/below every stake tier/);
    });

    it("refuses a symbol that would not be safe to display", async () => {
      vi.stubEnv("ARENA_STAKE_SYMBOL", "a".repeat(64));
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/ARENA_STAKE_SYMBOL/);
    });

    it("reads null before preflight has run", async () => {
      vi.resetModules();
      const { stakeMint } = await import("../../src/server/arena/stakeMint");
      expect(stakeMint()).toBeNull();
    });
  });

  // [ARENA] example.env has always said the treasury must hold the staking
  // mint. Nothing enforced it until the server knew the mint at boot, and a
  // mismatch locks the pot: settle_match's rake CPI fails, so the whole
  // settlement fails and the stakes sit in the vault until the 24h timeout.
  describe("the treasury account", () => {
    beforeEach(() => {
      vi.stubEnv("ARENA_RAKE_BPS", "500");
      vi.stubEnv("TREASURY_TOKEN_ACCOUNT", TREASURY);
    });

    it("passes when it holds the staking mint", async () => {
      const { outcome } = await run();
      expect(outcome.state).toBe("ok");
    });

    it("refuses when it holds a different mint", async () => {
      accounts[TREASURY] = tokenAccount(PROGRAM_ID);
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/but stakes are in/);
    });

    it("refuses when it is not a token account at all", async () => {
      accounts[TREASURY] = {
        owner: TOKEN_PROGRAM,
        data: Buffer.alloc(9),
        executable: false,
      };
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(/not an SPL token account/);
    });

    it("refuses when it does not exist", async () => {
      accounts[TREASURY] = null;
      const { wagerDisabledReason } = await run();
      expect(wagerDisabledReason()).toMatch(
        /no account at TREASURY_TOKEN_ACCOUNT/,
      );
    });

    it("is not checked at all when the rake is zero", async () => {
      // At 0 bps settler.ts passes the winner's own account, so there is
      // nothing to validate and no reason to demand a treasury.
      vi.stubEnv("ARENA_RAKE_BPS", "0");
      vi.stubEnv("TREASURY_TOKEN_ACCOUNT", "");
      accounts[TREASURY] = null;
      const { outcome } = await run();
      expect(outcome.state).toBe("ok");
    });
  });
});
