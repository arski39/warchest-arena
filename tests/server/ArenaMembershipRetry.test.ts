// @vitest-environment node
//
// [ARENA] verifyOnchainMembership's retry behaviour, and specifically the bug
// that made it kick paying players.
//
// This function is the gate on a wagered join: a false negative closes the
// player's socket with "entry fee not confirmed on-chain" AFTER their stake is
// already in the vault. The cost is asymmetric, so the retry policy is
// load-bearing rather than a nicety.
//
// The bug: `fetchMatchAccount` throwing was handled in one catch that assumed
// the cause was a malformed account, and returned "not a member" immediately.
// But a rate-limited or briefly-unreachable RPC throws there too -- so a single
// 429 kicked a paying player without the retry loop ever running once. The
// first real devnet run of scripts/devnet/ was rate-limited repeatedly by
// api.devnet.solana.com, which is what prompted this.
//
// node, not the repo's jsdom default: this loads @solana/web3.js for real.
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_ACCOUNT_DISCRIMINATOR,
  MATCH_ACCOUNT_LAYOUT,
  MATCH_ACCOUNT_SIZE,
  MatchStatus,
} from "../../src/core/arena/arenaProgram";

const MODULE = "../../src/server/arena/rpcClient";
const PROGRAM_ID = "4CGRLB5WJ4LK4nqwhzN5uhU78cakuHzG5wfrUZrQ2G64";

/**
 * A MatchAccount as the program would lay it out, so the production decoder
 * accepts it.
 *
 * Written through MATCH_ACCOUNT_LAYOUT rather than by counting bytes here, for
 * the reason the layout constant exists at all: two hand-maintained copies of
 * an offset table is exactly the drift `tests/arenaProgram.ts` diffs against the
 * IDL to prevent. (Counting by hand got `status` wrong on the first attempt —
 * it sits at 116, before `players`, not after `stakes`.)
 */
function encodeMatch(args: {
  authority: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  players: PublicKey[];
  entryFee: bigint;
  maxPlayers: number;
  status: MatchStatus;
}): Buffer {
  const L = MATCH_ACCOUNT_LAYOUT;
  const buf = Buffer.alloc(MATCH_ACCOUNT_SIZE);
  Buffer.from(MATCH_ACCOUNT_DISCRIMINATOR).copy(buf, L.discriminator);
  Buffer.from(args.authority.toBytes()).copy(buf, L.authority);
  Buffer.from(args.mint.toBytes()).copy(buf, L.mint);
  Buffer.from(args.vault.toBytes()).copy(buf, L.vault);
  buf.writeBigUInt64LE(args.entryFee, L.entryFee);
  buf.writeUInt16LE(0, L.rakeBps);
  buf.writeUInt8(args.maxPlayers, L.maxPlayers);
  buf.writeUInt8(args.players.length, L.playerCount);
  buf.writeUInt8(args.status, L.status);
  args.players.forEach((p, i) => {
    Buffer.from(p.toBytes()).copy(buf, L.players + i * 32);
  });
  return buf;
}

/**
 * Imports rpcClient with getAccountInfo scripted per attempt.
 *
 * Each entry is either a thrown value or the account data to return, so a test
 * can say "429, 429, then the account" and assert the loop rode it out.
 */
async function withScriptedRpc(script: (Error | Buffer | null)[]): Promise<{
  verifyOnchainMembership: typeof import("../../src/server/arena/rpcClient").verifyOnchainMembership;
  calls: () => number;
}> {
  let i = 0;
  const getAccountInfo = vi.fn(async () => {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    if (step === null) return null;
    return { data: step, owner: new PublicKey(PROGRAM_ID), executable: false };
  });

  vi.resetModules();
  vi.doMock("@solana/web3.js", async () => {
    const actual =
      await vi.importActual<typeof import("@solana/web3.js")>(
        "@solana/web3.js",
      );
    return {
      ...actual,
      Connection: class {
        getAccountInfo = getAccountInfo;
      },
    };
  });
  const mod = await import(MODULE);
  return {
    verifyOnchainMembership: mod.verifyOnchainMembership,
    calls: () => getAccountInfo.mock.calls.length,
  };
}

/**
 * Runs a check with the backoff on fake timers.
 *
 * The full budget is ~4.5s of real sleeping, which sat right on vitest's 5s
 * default and made these tests flake on the jitter alone. Faking the clock is
 * also the honest thing: what is under test is the retry *policy*, not whether
 * setTimeout works.
 */
async function runWithFakeClock<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = start();
    // Generously past the whole budget; advanceTimersByTimeAsync yields to the
    // microtask queue between timers, so the awaited fetches resolve too.
    await vi.advanceTimersByTimeAsync(60_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

const authority = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;
const player = Keypair.generate().publicKey;
const ENTRY_FEE = 1_000_000n;

const WAGER = {
  matchPDA: Keypair.generate().publicKey.toBase58(),
  vault: vault.toBase58(),
  mint: mint.toBase58(),
  programId: PROGRAM_ID,
  entryFee: ENTRY_FEE,
  decimals: 6,
  symbol: "WARC",
  rakeBps: 0,
  maxPlayers: 2,
  rpcUrl: "http://127.0.0.1:8899",
} as unknown as import("../../src/server/arena/matchRegistry").WagerConfig;

function joined(): Buffer {
  return encodeMatch({
    authority,
    mint,
    vault,
    players: [player],
    entryFee: ENTRY_FEE,
    maxPlayers: 2,
    status: MatchStatus.Open,
  });
}

describe("[ARENA] verifyOnchainMembership under a flaky RPC", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@solana/web3.js");
  });

  it("rides out a rate-limited RPC instead of kicking the player", async () => {
    // THE REGRESSION. Before the fix this returned isMember: false on the very
    // first 429, without a second attempt -- taking the stake and locking the
    // player out of the match they had already paid for.
    const rateLimited = new Error("429 Too Many Requests");
    const { verifyOnchainMembership, calls } = await withScriptedRpc([
      rateLimited,
      rateLimited,
      joined(),
    ]);

    const check = await runWithFakeClock(() =>
      verifyOnchainMembership(WAGER, player.toBase58()),
    );

    expect(check.isMember).toBe(true);
    expect(check.failure).toBeUndefined();
    expect(calls()).toBe(3);
  });

  it("gives up after the full budget and says the RPC was unreachable", async () => {
    // Still refuses -- admitting an unverified wallet into a wagered match is
    // never acceptable -- but the reason distinguishes an outage from fraud,
    // and Worker.ts uses it to avoid telling a paying player their fee was not
    // confirmed.
    const { verifyOnchainMembership, calls } = await withScriptedRpc([
      new Error("503 Service Unavailable"),
    ]);

    const check = await runWithFakeClock(() =>
      verifyOnchainMembership(WAGER, player.toBase58()),
    );

    expect(check.isMember).toBe(false);
    expect(check.failure).toBe("rpc-unavailable");
    expect(calls()).toBe(5);
  });

  it("does not retry a malformed account — that will not fix itself", async () => {
    // The distinction the old single catch collapsed. A wrongly-owned or
    // undersized account is permanent, so retrying only delays the rejection.
    const { verifyOnchainMembership, calls } = await withScriptedRpc([
      Buffer.alloc(10), // too short for the discriminator + layout
    ]);

    const check = await verifyOnchainMembership(WAGER, player.toBase58());

    expect(check.isMember).toBe(false);
    expect(check.failure).toBe("decode-failed");
    expect(calls()).toBe(1);
  });

  it("reports not-a-member, not rpc-unavailable, when the chain simply answered", async () => {
    // The escrow is readable and well-formed; this wallet is not in players[].
    // Reaching the RPC is what separates the two, so this must not be reported
    // as an outage.
    const other = Keypair.generate().publicKey;
    const { verifyOnchainMembership } = await withScriptedRpc([
      encodeMatch({
        authority,
        mint,
        vault,
        players: [other],
        entryFee: ENTRY_FEE,
        maxPlayers: 2,
        status: MatchStatus.Open,
      }),
    ]);

    // Exhausts the loop too: a readable account that simply does not list this
    // wallet retries the full budget, because a node briefly behind looks
    // exactly like this on the first read.
    const check = await runWithFakeClock(() =>
      verifyOnchainMembership(WAGER, player.toBase58()),
    );

    expect(check.isMember).toBe(false);
    expect(check.failure).toBe("not-a-member");
    // The view is still returned: the caller caches the fill state from it for
    // the synchronous start-gate, which cannot afford its own RPC.
    expect(check.match).not.toBeNull();
  });

  it("refuses an invalid wallet without touching the RPC", async () => {
    const { verifyOnchainMembership, calls } = await withScriptedRpc([
      joined(),
    ]);

    const check = await verifyOnchainMembership(WAGER, "not-base58!!");

    expect(check.isMember).toBe(false);
    expect(check.failure).toBe("bad-wallet");
    expect(calls()).toBe(0);
  });
});
