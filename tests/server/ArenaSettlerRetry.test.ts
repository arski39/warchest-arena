// @vitest-environment node
// [ARENA] settle() is the one place a transient failure costs a real payout.
//
// It used to make a single attempt: one 429 or expired blockhash after minutes
// of replay CPU left a verified win to the 24 h timeout refund. It now retries,
// re-reading the escrow first each time, so a send that actually landed is not
// resubmitted. Also pinned here: the winner's wallet resolves per game (a later
// stake into another match must not redirect this one's payout), and a match
// played without one of its stakers is not paid out at all.
//
// node environment: deriveAta() runs findProgramAddressSync, which jsdom breaks.
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MatchStatus, NO_TREASURY } from "../../src/core/arena/arenaProgram";
import { matchRegistry } from "../../src/server/arena/matchRegistry";
import { settle, settleRetry } from "../../src/server/arena/settler";
import { walletRegistry } from "../../src/server/arena/walletRegistry";

const authority = Keypair.generate();
const fetchMatchAccount = vi.hoisted(() => vi.fn());
const connection = vi.hoisted(() => ({
  getLatestBlockhash: vi.fn(),
  sendRawTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
  getAccountInfo: vi.fn(),
}));
vi.mock("../../src/server/arena/rpcClient", () => ({
  fetchMatchAccount,
  getConnection: () => connection,
}));
vi.mock("../../src/server/arena/serverKeypair", () => ({
  serverKeypair: () => authority,
}));

const GAME = "settle01";
const OTHER_GAME = "settle02";
const programId = Keypair.generate().publicKey;
const matchPda = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const W1 = Keypair.generate().publicKey;
const W2 = Keypair.generate().publicKey;
const W3 = Keypair.generate().publicKey;

function register() {
  matchRegistry.register(GAME, {
    matchPDA: matchPda.toBase58(),
    vault: vault.toBase58(),
    mint: mint.toBase58(),
    entryFee: 1_000_000n,
    maxPlayers: 2,
    rakeBps: 0,
    nonce: 1n,
    programId: programId.toBase58(),
    decimals: 6,
    symbol: "WARC",
  });
}

function match(status: MatchStatus, players = [W1, W2]) {
  return {
    status,
    players,
    playerCount: players.length,
    maxPlayers: 2,
    mint,
    vault,
    rakeBps: 0,
    treasury: NO_TREASURY,
  };
}

const allClients = new Map<string, any>([
  ["c1", { persistentID: "pid1" }],
  ["c2", { persistentID: "pid2" }],
]);

const winner = {
  type: "winner" as const,
  winner: ["player", "c1"] as any,
  allPlayersStats: { c1: { finalTiles: 10 }, c2: { finalTiles: 2 } } as any,
};

describe("[ARENA] settle()", () => {
  beforeEach(() => {
    settleRetry.baseDelayMs = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMatchAccount.mockReset();
    for (const fn of Object.values(connection)) fn.mockReset();
    connection.getLatestBlockhash.mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    });
    // The winner's token account exists, so no ATA transaction is sent.
    connection.getAccountInfo.mockResolvedValue({});
    connection.confirmTransaction.mockResolvedValue({ value: { err: null } });
    register();
    walletRegistry.bind(GAME, "pid1", W1.toBase58());
    walletRegistry.bind(GAME, "pid2", W2.toBase58());
  });

  afterEach(() => {
    matchRegistry.unregister(GAME);
    matchRegistry.unregister(OTHER_GAME);
    vi.restoreAllMocks();
  });

  it("retries a failed payout", async () => {
    fetchMatchAccount.mockResolvedValue(match(MatchStatus.InProgress));
    connection.sendRawTransaction
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce("sig");

    await settle(GAME, winner, allClients, ["pid1", "pid2"]);

    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
    // Each attempt signs on a blockhash fetched for it.
    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(2);
    expect(matchRegistry.isWagered(GAME)).toBe(false);
  });

  it("does not resubmit once the chain shows the match settled", async () => {
    // The first send landed but its confirmation timed out.
    fetchMatchAccount
      .mockResolvedValueOnce(match(MatchStatus.InProgress))
      .mockResolvedValueOnce(match(MatchStatus.Settled));
    connection.sendRawTransaction.mockResolvedValue("sig");
    connection.confirmTransaction.mockRejectedValueOnce(
      new Error("block height exceeded"),
    );

    await settle(GAME, winner, allClients, ["pid1", "pid2"]);

    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(matchRegistry.isWagered(GAME)).toBe(false);
  });

  it("gives up after a bounded number of attempts", async () => {
    fetchMatchAccount.mockResolvedValue(match(MatchStatus.InProgress));
    connection.sendRawTransaction.mockRejectedValue(new Error("down"));

    await expect(
      settle(GAME, winner, allClients, ["pid1", "pid2"]),
    ).rejects.toThrow("down");
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(5);
    // Still registered: the pot is still there to be refunded.
    expect(matchRegistry.isWagered(GAME)).toBe(true);
  });

  it("resolves the winner's wallet for THIS game", async () => {
    // pid1 has since staked into another match with another wallet.
    walletRegistry.bind(OTHER_GAME, "pid1", W3.toBase58());
    fetchMatchAccount.mockResolvedValue(match(MatchStatus.InProgress));
    connection.sendRawTransaction.mockResolvedValue("sig");

    await settle(GAME, winner, allClients, ["pid1", "pid2"]);

    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("refuses to pay out a match one of its stakers was not in", async () => {
    // W2 staked, but the match was played by pid1 alone.
    fetchMatchAccount.mockResolvedValue(match(MatchStatus.InProgress));

    await settle(GAME, winner, allClients, ["pid1"]);

    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(matchRegistry.isWagered(GAME)).toBe(true);
  });

  it("pays the winner's own wallet, not a stand-in", async () => {
    fetchMatchAccount.mockResolvedValue(match(MatchStatus.InProgress));
    connection.sendRawTransaction.mockResolvedValue("sig");

    await settle(GAME, winner, allClients, ["pid1", "pid2"]);

    const wire = connection.sendRawTransaction.mock.calls[0][0] as Buffer;
    // The settle instruction names the winner, so their key is in the message.
    expect(Buffer.from(wire).includes(W1.toBuffer())).toBe(true);
    expect(PublicKey.isOnCurve(W1.toBytes())).toBe(true);
  });
});
