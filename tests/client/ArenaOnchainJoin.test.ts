// @vitest-environment node
//
// Node, not the repo's default jsdom. `deriveAta` calls
// `PublicKey.findProgramAddressSync`, which exhausts all 255 bumps under jsdom
// and throws "Unable to find a viable program address nonce" -- so under the
// default environment this file cannot reach the code it tests. Same class of
// reason as AuthService.test.ts. Nothing here touches the DOM.
// [ARENA] The stake gate's two honest answers, which it used to collapse into
// one wrong one.
//
// `ARENA_PUBLIC_RPC_URL` is the *keyless* endpoint handed to every browser --
// `api.devnet.solana.com` on this deployment -- and the root CLAUDE.md records
// it as rate-limiting hard enough to 429 a single test run. Two places in the
// stake flow talk to it, and both used to read a 429 as a statement of fact:
//
//   * the balance pre-check caught everything and said "No token account for
//     this match's mint", telling a player who holds the token to go and get
//     one; and
//   * a failed confirmation was reported as a failed stake, when the
//     transaction may well have landed -- after which the player's retry
//     surfaced the program's own `AlreadyJoined` as a *second* failure, on a
//     stake that had already been paid.
//
// The server draws exactly this line and is mutation-tested on it
// (`MembershipCheck.failure === "rpc-unavailable"`, ArenaMembershipRetry.test.
// ts). These are the client half, on the same throttled endpoint.
//
// Membership is read from `players[]` rather than from the signature, for the
// same reason the server does: the program writes a wallet there only after
// `token::transfer` has moved the fee into the vault, so presence *is* payment.

import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_ACCOUNT_DISCRIMINATOR,
  MATCH_ACCOUNT_LAYOUT,
  MATCH_ACCOUNT_SIZE,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
} from "../../src/core/arena/arenaProgram";

// A real on-curve wallet address. It has to be: deriveAta() runs
// findProgramAddressSync over it, which an invented off-curve string fails.
const PLAYER = "5miqxq62Qs3Ruc7FpyEYQuz8QWEa3Dmh9p18z7y9VdZM";
const MINT = "CtVDnzfPa4TDGLv886X3FJkbzZz5LXt9RpLHWNMtsJLe";
const PROGRAM_ID = "4CGRLB5WJ4LK4nqwhzN5uhU78cakuHzG5wfrUZrQ2G64";
const MATCH_PDA = "11111111111111111111111111111112";
const VAULT = "11111111111111111111111111111113";
const SIGNATURE = "5".repeat(64);

/** A 165-byte SPL token account holding `amount` of `MINT` for `PLAYER`. */
function tokenAccount(amount: bigint) {
  const data = new Uint8Array(TOKEN_ACCOUNT_SIZE);
  data.set(new PublicKey(MINT).toBytes(), 0);
  data.set(new PublicKey(PLAYER).toBytes(), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data, owner: TOKEN_PROGRAM_ID };
}

/** An 806-byte MatchAccount whose `players[0]` is `player`, or nobody. */
function matchAccount(player: string | null) {
  const data = new Uint8Array(MATCH_ACCOUNT_SIZE);
  data.set(MATCH_ACCOUNT_DISCRIMINATOR, 0);
  data[MATCH_ACCOUNT_LAYOUT.maxPlayers] = 2;
  data[MATCH_ACCOUNT_LAYOUT.playerCount] = player === null ? 0 : 1;
  data[MATCH_ACCOUNT_LAYOUT.status] = 0; // Open
  if (player !== null) {
    data.set(new PublicKey(player).toBytes(), MATCH_ACCOUNT_LAYOUT.players);
  }
  return { data, owner: new PublicKey(PROGRAM_ID) };
}

/**
 * The RPC surface joinMatchOnChain touches.
 *
 * The two getAccountInfo reads are told apart by address rather than by call
 * order, because the second one only happens on some paths -- and answering
 * them differently is the whole point of the second one. The player's ATA is
 * "not the match PDA" rather than a derived constant: deriveAta() calls
 * findProgramAddressSync, which cannot complete under jsdom.
 */
type Handlers = {
  ata: unknown | (() => unknown);
  match: unknown | (() => unknown);
  confirm: () => unknown;
};
let handlers: Handlers;

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  class FakeConnection {
    async getAccountInfo(key: { toBase58(): string }) {
      const entry =
        key.toBase58() === MATCH_PDA ? handlers.match : handlers.ata;
      if (entry === undefined) return null;
      return typeof entry === "function" ? (entry as () => unknown)() : entry;
    }
    async getLatestBlockhash() {
      // Valid base58, so anything that decodes it gets a real 32-byte value.
      return { blockhash: "1".repeat(32), lastValidBlockHeight: 1 };
    }
    async sendRawTransaction() {
      return SIGNATURE;
    }
    async confirmTransaction() {
      return handlers.confirm();
    }
  }
  return { ...actual, Connection: FakeConnection };
});

vi.mock("../../src/client/arena/WalletProvider", () => ({
  getConnectedWallet: () => ({
    publicKey: PLAYER,
    signMessage: async (m: Uint8Array) => m,
    // A real wallet hands back a SIGNED transaction, so the returned object is
    // the one that must serialize. Echoing the unsigned input instead would
    // throw "Signature verification failed" inside serialize().
    signTransaction: async () => ({ serialize: () => new Uint8Array([1]) }),
  }),
}));

async function join() {
  const { joinMatchOnChain } =
    await import("../../src/client/arena/onchainJoin");
  return joinMatchOnChain({
    programId: PROGRAM_ID,
    rpcUrl: "http://127.0.0.1:8899",
    matchPDA: MATCH_PDA,
    vault: VAULT,
    mint: MINT,
    entryFee: 5_000_000n,
  });
}

describe("joinMatchOnChain", () => {
  beforeEach(() => {
    handlers = {
      ata: undefined,
      match: undefined,
      confirm: () => ({ value: { err: null } }),
    };
  });

  it("reports an unreachable RPC as unreachable, not as an empty wallet", async () => {
    handlers.ata = () => {
      throw new Error("429 Too Many Requests");
    };

    // The distinction IS the assertion. Before this, a throttled endpoint told
    // a player holding the token that they did not have one.
    await expect(join()).rejects.toMatchObject({
      name: "StakeRpcUnavailableError",
    });
  });

  it("still reports a genuinely missing token account as missing", async () => {
    // handlers.ata stays undefined, so getAccountInfo resolves null rather than
    // throwing -- exactly what a real RPC does for an account that is not there.
    await expect(join()).rejects.toMatchObject({
      name: "InsufficientStakeError",
    });
  });

  it("refuses when the wallet holds less than the entry fee", async () => {
    handlers.ata = tokenAccount(4_999_999n);

    await expect(join()).rejects.toMatchObject({
      name: "InsufficientStakeError",
    });
  });

  it("returns the signature on a clean confirmation", async () => {
    handlers.ata = tokenAccount(5_000_000n);

    await expect(join()).resolves.toBe(SIGNATURE);
  });

  it("treats a failed confirmation as success when the escrow says the stake landed", async () => {
    handlers.ata = tokenAccount(5_000_000n);
    handlers.match = matchAccount(PLAYER);
    handlers.confirm = () => {
      throw new Error("Transaction was not confirmed in 30.00 seconds");
    };

    // The confirmation timing out says nothing about whether the transfer
    // landed; players[] does, because the program writes it only after the
    // transfer. Reporting failure here is what charged a player and then told
    // them they had not paid.
    await expect(join()).resolves.toBe(SIGNATURE);
  });

  it("says the stake is unconfirmed when the escrow cannot be read either", async () => {
    handlers.ata = tokenAccount(5_000_000n);
    handlers.match = () => {
      throw new Error("429 Too Many Requests");
    };
    handlers.confirm = () => {
      throw new Error("Transaction was not confirmed in 30.00 seconds");
    };

    await expect(join()).rejects.toMatchObject({
      name: "StakeUnconfirmedError",
    });
  });

  it("reports a real on-chain failure once the escrow confirms no stake landed", async () => {
    handlers.ata = tokenAccount(5_000_000n);
    handlers.match = matchAccount(null);
    handlers.confirm = () => ({ value: { err: { InstructionError: [0, 1] } } });

    await expect(join()).rejects.toThrow(/join_match failed on-chain/);
  });
});

describe("describeJoinProgramError", () => {
  // The exact string a live Phantom preflight produced on warchest-arena.com,
  // trimmed. The whole point is that this is what a player was shown.
  const REAL_LOG =
    "Simulation failed. Message: Transaction simulation failed: Error " +
    "processing Instruction 2: custom program error: 0x1771. Logs: " +
    '["Program 4CGRLB5WJ4LK4nqwhzN5uhU78cakuHzG5wfrUZrQ2G64 invoke [1]",' +
    '"Program log: Instruction: JoinMatch","Program log: AnchorError caused ' +
    "by account: match_account. Error Code: NotOpen. Error Number: 6001. " +
    'Error Message: Match is not open for joining."].';

  it("names the refusal behind a live preflight failure", async () => {
    const { describeJoinProgramError } =
      await import("../../src/client/arena/onchainJoin");
    expect(describeJoinProgramError(REAL_LOG)).toBe("not_open");
  });

  it("maps every join_match refusal to its own code", async () => {
    const { describeJoinProgramError } =
      await import("../../src/client/arena/onchainJoin");
    const at = (hex: string) =>
      describeJoinProgramError(`custom program error: ${hex}`);
    // 6000..6003, the four join_match can produce. The codes are positional
    // from 6000 in errors.rs declaration order, which is append-only.
    expect(at("0x1770")).toBe("match_full");
    expect(at("0x1771")).toBe("not_open");
    expect(at("0x1772")).toBe("fee_too_low");
    expect(at("0x1773")).toBe("already_joined");
  });

  it("leaves anything it does not recognise to the raw message", async () => {
    const { describeJoinProgramError } =
      await import("../../src/client/arena/onchainJoin");
    expect(describeJoinProgramError("custom program error: 0x1780")).toBeNull();
    expect(describeJoinProgramError("User rejected the request")).toBeNull();
  });
});

describe("readEscrowState", () => {
  beforeEach(() => {
    handlers = {
      ata: undefined,
      match: undefined,
      confirm: () => ({ value: { err: null } }),
    };
  });

  const params = {
    programId: PROGRAM_ID,
    rpcUrl: "http://127.0.0.1:8899",
    matchPDA: MATCH_PDA,
  };

  it("reports a wallet that already paid", async () => {
    handlers.match = matchAccount(PLAYER);
    const { readEscrowState } =
      await import("../../src/client/arena/onchainJoin");
    await expect(readEscrowState(params, PLAYER)).resolves.toMatchObject({
      alreadyStaked: true,
    });
  });

  it("reports a full match as no longer Open", async () => {
    const full = matchAccount(null);
    full.data[MATCH_ACCOUNT_LAYOUT.status] = 1; // InProgress
    handlers.match = full;
    const { readEscrowState } =
      await import("../../src/client/arena/onchainJoin");
    const { MatchStatus } = await import("../../src/core/arena/arenaProgram");
    await expect(readEscrowState(params, PLAYER)).resolves.toMatchObject({
      alreadyStaked: false,
      status: MatchStatus.InProgress,
    });
  });

  it("answers null rather than 'closed' when the RPC is unreachable", async () => {
    handlers.match = () => {
      throw new Error("429 Too Many Requests");
    };
    const { readEscrowState } =
      await import("../../src/client/arena/onchainJoin");
    // Null must not be read as a closed match: this is the shared keyless
    // endpoint, so unreachable is routine and refusing to offer the stake
    // would strand a player who can perfectly well pay.
    await expect(readEscrowState(params, PLAYER)).resolves.toBeNull();
  });
});
