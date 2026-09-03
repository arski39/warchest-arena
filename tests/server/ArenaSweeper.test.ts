// [ARENA] H2: the recovery sweeper is the only thing that gets money back out
// of an escrow whose worker process died. Two properties carry all the risk:
//
//   * the age windows. Too long and stakes sit locked; too short and the
//     sweeper refunds a lobby that is still filling, out from under the people
//     playing in it. The Open window is the dangerous one — the program accepts
//     a cancel on an Open match at any age, so nothing on chain stops it.
//   * that a single bad match cannot abort the sweep, or one unrecoverable pot
//     would strand every other one behind it.
//
// The match bytes here are built at the real layout offsets and run through the
// real decodeMatchAccount, so the suite fails if the sweeper is reading a field
// the program does not write there.

import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeMatchAccount,
  MATCH_ACCOUNT_DISCRIMINATOR,
  MATCH_ACCOUNT_LAYOUT,
  MATCH_ACCOUNT_SIZE,
  MATCH_TIMEOUT_SECS,
  MatchStatus,
  type MatchAccountView,
} from "../../src/core/arena/arenaProgram";
import { MAX_GAME_DURATION_MS } from "../../src/core/Schemas";

const AUTHORITY = Keypair.generate();
const PROGRAM_ID = new PublicKey("11111111111111111111111111111112");
const MINT = new PublicKey("11111111111111111111111111111113");

const getProgramAccounts = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/rpcClient", () => ({
  getConnection: () => ({ getProgramAccounts }),
}));

const serverKeypair = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/serverKeypair", () => ({
  serverKeypair,
  serverKeypairPath: vi.fn(() => "/run/secrets/arena-authority.json"),
}));

// The refund mechanics belong to settler.ts and are proven in bankrun. What
// matters here is that the sweeper hands it the right escrow.
const cancelAndRefund = vi.hoisted(() => vi.fn());
const closeMatchAccount = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/settler", () => ({
  cancelAndRefund,
  closeMatchAccount,
}));

const wageringOperational = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../src/server/arena/preflight", () => ({ wageringOperational }));

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

interface MatchOpts {
  status: MatchStatus;
  /** How long before NOW the escrow was created. */
  ageMs: number;
  players?: PublicKey[];
  authority?: PublicKey;
}

/** A MatchAccount written at the layout offsets the program uses. */
function encodeMatch(opts: MatchOpts): Buffer {
  const players = opts.players ?? [];
  const data = Buffer.alloc(MATCH_ACCOUNT_SIZE);
  const L = MATCH_ACCOUNT_LAYOUT;

  data.set(MATCH_ACCOUNT_DISCRIMINATOR, L.discriminator);
  data.set((opts.authority ?? AUTHORITY.publicKey).toBytes(), L.authority);
  data.set(MINT.toBytes(), L.mint);
  data.set(Keypair.generate().publicKey.toBytes(), L.vault);
  data.writeBigUInt64LE(1_000n, L.entryFee);
  data.writeUInt16LE(0, L.rakeBps);
  data.writeUInt8(2, L.maxPlayers);
  data.writeUInt8(players.length, L.playerCount);
  data.writeUInt8(opts.status, L.status);
  players.forEach((p, i) => {
    data.set(p.toBytes(), L.players + i * 32);
    data.writeBigUInt64LE(1_000n, L.stakes + i * 8);
  });
  data.writeBigInt64LE(
    BigInt(Math.floor((NOW - opts.ageMs) / 1000)),
    L.createdAt,
  );
  data.writeBigUInt64LE(7n, L.nonce);
  data.writeUInt8(255, L.bump);
  return data;
}

function account(opts: MatchOpts, pubkey = Keypair.generate().publicKey) {
  return {
    pubkey,
    account: { data: encodeMatch(opts), owner: PROGRAM_ID },
  };
}

/**
 * Answers the four status-filtered queries in the order the sweeper makes
 * them: Open and InProgress for the orphan scan, then Settled and Cancelled
 * for the rent-reclaim pass.
 */
function respondWith(
  open: unknown[],
  inProgress: unknown[] = [],
  settled: unknown[] = [],
  cancelled: unknown[] = [],
) {
  getProgramAccounts
    .mockResolvedValueOnce(open)
    .mockResolvedValueOnce(inProgress)
    .mockResolvedValueOnce(settled)
    .mockResolvedValueOnce(cancelled);
}

async function load() {
  vi.resetModules();
  return await import("../../src/server/arena/sweeper");
}

describe("[ARENA] recovery sweeper", () => {
  beforeEach(() => {
    vi.stubEnv("ARENA_PROGRAM_ID", PROGRAM_ID.toBase58());
    serverKeypair.mockReturnValue(AUTHORITY);
    cancelAndRefund.mockResolvedValue("tx-signature");
    closeMatchAccount.mockResolvedValue("close-tx-signature");
    wageringOperational.mockReturnValue(true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
    getProgramAccounts.mockReset();
    cancelAndRefund.mockReset();
    closeMatchAccount.mockReset();
  });

  describe("the Open window", () => {
    it("outlasts the longest a lobby can legitimately live", async () => {
      // The relationship, not the number: a private lobby with no armed start
      // timer stays in the Lobby phase for the full MAX_GAME_DURATION_MS, so a
      // sweeper window at or below it refunds players mid-lobby. Both values
      // may change; this must keep holding.
      const { OPEN_SWEEP_AFTER_MS } = await load();
      expect(OPEN_SWEEP_AFTER_MS).toBeGreaterThan(MAX_GAME_DURATION_MS);
    });

    it("leaves a lobby that could still be filling alone", async () => {
      // One second under, not one millisecond: created_at is an i64 of whole
      // seconds, so sub-second margins truncate straight onto the boundary.
      const { isOrphaned, OPEN_SWEEP_AFTER_MS } = await load();
      const match = decode(
        encodeMatch({
          status: MatchStatus.Open,
          ageMs: OPEN_SWEEP_AFTER_MS - 1000,
        }),
      );
      expect(isOrphaned(match, NOW)).toBe(false);
    });

    it("does not touch one that is merely as old as a full-length game", async () => {
      // The window this suite exists to defend: MAX_GAME_DURATION_MS is when
      // the lobby's own end() refunds it, not when the sweeper should.
      const { isOrphaned } = await load();
      const match = decode(
        encodeMatch({ status: MatchStatus.Open, ageMs: MAX_GAME_DURATION_MS }),
      );
      expect(isOrphaned(match, NOW)).toBe(false);
    });

    it("claims one exactly at the deadline", async () => {
      const { isOrphaned, OPEN_SWEEP_AFTER_MS } = await load();
      const match = decode(
        encodeMatch({ status: MatchStatus.Open, ageMs: OPEN_SWEEP_AFTER_MS }),
      );
      expect(isOrphaned(match, NOW)).toBe(true);
    });
  });

  describe("the InProgress window", () => {
    it("is the program's own deadline, not a second copy of it", async () => {
      // cancel_match rejects an InProgress match before MATCH_TIMEOUT_SECS, so
      // a sweeper with its own shorter number just submits doomed transactions.
      const { isOrphaned } = await load();
      const justBefore = decode(
        encodeMatch({
          status: MatchStatus.InProgress,
          ageMs: MATCH_TIMEOUT_SECS * 1000 - 1000,
        }),
      );
      const atDeadline = decode(
        encodeMatch({
          status: MatchStatus.InProgress,
          ageMs: MATCH_TIMEOUT_SECS * 1000,
        }),
      );
      expect(isOrphaned(justBefore, NOW)).toBe(false);
      expect(isOrphaned(atDeadline, NOW)).toBe(true);
    });

    it("leaves a match that is merely being played alone", async () => {
      const { isOrphaned } = await load();
      const match = decode(
        encodeMatch({ status: MatchStatus.InProgress, ageMs: 2 * HOUR }),
      );
      expect(isOrphaned(match, NOW)).toBe(false);
    });
  });

  describe("what is never an orphan", () => {
    it.each([
      ["Settled", MatchStatus.Settled],
      ["Cancelled", MatchStatus.Cancelled],
    ])("a terminal %s match, however old", async (_name, status) => {
      const { isOrphaned } = await load();
      const match = decode(encodeMatch({ status, ageMs: 365 * 24 * HOUR }));
      expect(isOrphaned(match, NOW)).toBe(false);
    });

    it("one created in the future by a skewed clock", async () => {
      // Negative age must not read as "old enough" through some sign slip.
      const { isOrphaned } = await load();
      const match = decode(
        encodeMatch({ status: MatchStatus.Open, ageMs: -48 * HOUR }),
      );
      expect(isOrphaned(match, NOW)).toBe(false);
    });
  });

  describe("what it asks the chain for", () => {
    it("queries each status separately, and in two distinct passes", async () => {
      // getProgramAccounts AND-s its filters and has no OR, so one query per
      // status is a necessity rather than a choice. The order encodes the two
      // jobs: Open and InProgress are the orphan scan, Settled and Cancelled
      // are the rent reclaim — and the second only exists because close_match
      // does. Without it that terminal set would grow forever.
      const { sweepOrphanedMatches } = await load();
      respondWith([], []);
      await sweepOrphanedMatches(NOW);

      expect(getProgramAccounts).toHaveBeenCalledTimes(4);
      const asked = getProgramAccounts.mock.calls.map((c) =>
        statusFilterOf(c[1] as StatusQuery),
      );
      expect(asked).toEqual([
        MatchStatus.Open,
        MatchStatus.InProgress,
        MatchStatus.Settled,
        MatchStatus.Cancelled,
      ]);
    });

    it("scopes the query to this authority's own matches", async () => {
      // Without this the sweeper would try to cancel other operators' escrows,
      // and the program would reject every one of them as Unauthorized.
      const { sweepOrphanedMatches } = await load();
      respondWith([], []);
      await sweepOrphanedMatches(NOW);

      const { filters } = getProgramAccounts.mock.calls[0][1] as {
        filters: unknown[];
      };
      expect(filters).toContainEqual({
        memcmp: {
          offset: MATCH_ACCOUNT_LAYOUT.authority,
          bytes: AUTHORITY.publicKey.toBase58(),
        },
      });
      expect(filters).toContainEqual({ dataSize: MATCH_ACCOUNT_SIZE });
    });

    it("asks for nothing at all when wagering is not configured", async () => {
      vi.stubEnv("ARENA_PROGRAM_ID", "");
      const { sweepOrphanedMatches } = await load();
      const outcome = await sweepOrphanedMatches(NOW);

      expect(getProgramAccounts).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        scanned: 0,
        refunded: 0,
        closed: 0,
        failed: 0,
      });
    });
  });

  describe("refunding", () => {
    it("refunds the orphan and leaves the live lobby staked", async () => {
      const { sweepOrphanedMatches, OPEN_SWEEP_AFTER_MS } = await load();
      const orphan = Keypair.generate().publicKey;
      const live = Keypair.generate().publicKey;
      respondWith([
        account({ status: MatchStatus.Open, ageMs: HOUR }, live),
        account(
          { status: MatchStatus.Open, ageMs: OPEN_SWEEP_AFTER_MS },
          orphan,
        ),
      ]);

      const outcome = await sweepOrphanedMatches(NOW);

      expect(outcome).toEqual({
        scanned: 2,
        refunded: 1,
        closed: 0,
        failed: 0,
      });
      expect(cancelAndRefund).toHaveBeenCalledTimes(1);
      const [programId, matchPda] = cancelAndRefund.mock.calls[0] as [
        PublicKey,
        PublicKey,
      ];
      expect(programId.toBase58()).toBe(PROGRAM_ID.toBase58());
      expect(matchPda.toBase58()).toBe(orphan.toBase58());
    });

    it("hands over the decoded stakers, in join order", async () => {
      // cancel_match pairs remaining_accounts[i] with stakes[i], so the order
      // the decoder produced is the order the refund has to use.
      const { sweepOrphanedMatches } = await load();
      const players = [
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
      ];
      respondWith(
        [],
        [
          account({
            status: MatchStatus.InProgress,
            ageMs: MATCH_TIMEOUT_SECS * 1000,
            players,
          }),
        ],
      );

      await sweepOrphanedMatches(NOW);

      const match = refundedMatch(0);
      expect(match.players.map((p) => p.toBase58())).toEqual(
        players.map((p) => p.toBase58()),
      );
    });

    it("refunds an escrow nobody ever staked into", async () => {
      // A wager attached to a lobby that was then abandoned. player_count is 0,
      // so the program refunds nobody and just marks it Cancelled — but the
      // sweeper still has to try, or the account sits Open forever.
      const { sweepOrphanedMatches, OPEN_SWEEP_AFTER_MS } = await load();
      respondWith([
        account({
          status: MatchStatus.Open,
          ageMs: OPEN_SWEEP_AFTER_MS,
          players: [],
        }),
      ]);

      const outcome = await sweepOrphanedMatches(NOW);

      expect(outcome.refunded).toBe(1);
      expect(refundedMatch(0).players).toEqual([]);
    });
  });

  describe("one bad match does not strand the rest", () => {
    it("keeps going when a refund fails", async () => {
      const { sweepOrphanedMatches, OPEN_SWEEP_AFTER_MS } = await load();
      cancelAndRefund
        .mockRejectedValueOnce(new Error("blockhash not found"))
        .mockResolvedValueOnce("tx-2");
      respondWith([
        account({ status: MatchStatus.Open, ageMs: OPEN_SWEEP_AFTER_MS }),
        account({ status: MatchStatus.Open, ageMs: OPEN_SWEEP_AFTER_MS }),
      ]);

      const outcome = await sweepOrphanedMatches(NOW);

      expect(outcome).toEqual({
        scanned: 2,
        refunded: 1,
        closed: 0,
        failed: 1,
      });
    });

    it("keeps going when an account does not decode", async () => {
      // Shouldn't happen behind the filters, but a garbled account must not be
      // able to hold every other orphan's money hostage.
      const { sweepOrphanedMatches, OPEN_SWEEP_AFTER_MS } = await load();
      const garbled = account({
        status: MatchStatus.Open,
        ageMs: OPEN_SWEEP_AFTER_MS,
      });
      garbled.account.data.writeUInt8(0xff, MATCH_ACCOUNT_LAYOUT.playerCount);
      respondWith([
        garbled,
        account({ status: MatchStatus.Open, ageMs: OPEN_SWEEP_AFTER_MS }),
      ]);

      const outcome = await sweepOrphanedMatches(NOW);

      expect(outcome).toEqual({
        scanned: 2,
        refunded: 1,
        closed: 0,
        failed: 1,
      });
    });

    it("refuses an account the arena program does not own", async () => {
      // The decoder's owner check. Without it, any 774-byte account could be
      // made to decode into a plausible match with attacker-chosen stakers.
      const { sweepOrphanedMatches, OPEN_SWEEP_AFTER_MS } = await load();
      const foreign = account({
        status: MatchStatus.Open,
        ageMs: OPEN_SWEEP_AFTER_MS,
      });
      foreign.account.owner = Keypair.generate().publicKey;
      respondWith([foreign]);

      const outcome = await sweepOrphanedMatches(NOW);

      expect(outcome).toEqual({
        scanned: 1,
        refunded: 0,
        closed: 0,
        failed: 1,
      });
      expect(cancelAndRefund).not.toHaveBeenCalled();
    });
  });

  describe("reclaiming rent from finished matches", () => {
    it("closes terminal matches and counts them", async () => {
      // Nothing else ever removes a terminal match, so without this pass every
      // match the authority creates holds its rent forever and stays in the
      // scan for the life of the key.
      const { sweepOrphanedMatches } = await load();
      const settled = Keypair.generate().publicKey;
      const cancelled = Keypair.generate().publicKey;
      respondWith(
        [],
        [],
        [account({ status: MatchStatus.Settled, ageMs: HOUR }, settled)],
        [account({ status: MatchStatus.Cancelled, ageMs: HOUR }, cancelled)],
      );

      const outcome = await sweepOrphanedMatches(NOW);

      expect(outcome).toEqual({
        scanned: 0,
        refunded: 0,
        closed: 2,
        failed: 0,
      });
      expect(closeMatchAccount).toHaveBeenCalledTimes(2);
      const closedPdas = closeMatchAccount.mock.calls.map((c) =>
        (c[1] as PublicKey).toBase58(),
      );
      expect(closedPdas).toEqual([settled.toBase58(), cancelled.toBase58()]);
      // Terminal matches are never refund candidates, whatever their age.
      expect(cancelAndRefund).not.toHaveBeenCalled();
    });

    it("a close that cannot succeed does not stop the others", async () => {
      // The realistic cause is a vault somebody donated into: cancel_match
      // refunds `stakes`, not the balance, so it is never empty and the
      // program will refuse it every sweep from now on.
      const { sweepOrphanedMatches } = await load();
      respondWith(
        [],
        [],
        [
          account({ status: MatchStatus.Settled, ageMs: HOUR }),
          account({ status: MatchStatus.Settled, ageMs: HOUR }),
        ],
      );
      closeMatchAccount
        .mockRejectedValueOnce(new Error("VaultNotEmpty"))
        .mockResolvedValueOnce("close-tx-signature");

      const outcome = await sweepOrphanedMatches(NOW);

      expect(outcome.closed).toBe(1);
      expect(closeMatchAccount).toHaveBeenCalledTimes(2);
      // Not counted as `failed`: that number is about pots still holding money.
      expect(outcome.failed).toBe(0);
    });

    it("caps how many it closes in one sweep", async () => {
      // The first sweep after close_match ships faces every terminal match the
      // key ever created. Clearing the backlog is worth doing; doing it in one
      // breath is not.
      const { sweepOrphanedMatches, MAX_CLOSES_PER_SWEEP } = await load();
      const many = Array.from({ length: MAX_CLOSES_PER_SWEEP + 5 }, () =>
        account({ status: MatchStatus.Settled, ageMs: HOUR }),
      );
      respondWith([], [], many);

      const outcome = await sweepOrphanedMatches(NOW);

      expect(outcome.closed).toBe(MAX_CLOSES_PER_SWEEP);
      expect(closeMatchAccount).toHaveBeenCalledTimes(MAX_CLOSES_PER_SWEEP);
    });
  });

  describe("scheduling", () => {
    it("does not start when wagering is not operational", async () => {
      wageringOperational.mockReturnValue(false);
      const { startSweeper, stopSweeper } = await load();
      startSweeper();
      stopSweeper();
      expect(getProgramAccounts).not.toHaveBeenCalled();
    });

    it("sweeps once immediately, then on the interval", async () => {
      const { startSweeper, stopSweeper, SWEEP_INTERVAL_MS } = await load();
      getProgramAccounts.mockResolvedValue([]);
      vi.useFakeTimers();

      startSweeper();
      await vi.advanceTimersByTimeAsync(0);
      // Four queries per sweep: one per status, across the orphan scan and the
      // rent-reclaim pass.
      expect(getProgramAccounts).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(getProgramAccounts).toHaveBeenCalledTimes(8);
      stopSweeper();
    });

    it("skips a tick rather than overlapping a slow sweep", async () => {
      // Overlapping runs re-scan the same accounts and double-submit cancels
      // for orphans the first pass is already refunding.
      const { startSweeper, stopSweeper, SWEEP_INTERVAL_MS } = await load();
      let release: (v: unknown[]) => void = () => {};
      getProgramAccounts.mockResolvedValue([]);
      getProgramAccounts.mockReturnValueOnce(
        new Promise<unknown[]>((r) => {
          release = r;
        }),
      );

      vi.useFakeTimers();
      startSweeper();
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 3);
      expect(getProgramAccounts).toHaveBeenCalledTimes(1); // still in the first query

      release([]);
      stopSweeper();
    });
  });
});

/** The MatchAccountView the sweeper handed to the nth refund. */
function refundedMatch(n: number): MatchAccountView {
  return cancelAndRefund.mock.calls[n][2] as MatchAccountView;
}

/** Runs bytes through the real decoder, so the tests cannot drift off-layout. */
function decode(data: Buffer) {
  return decodeMatchAccount(data, PROGRAM_ID, PROGRAM_ID);
}

interface StatusQuery {
  filters: { memcmp?: { offset: number; bytes: string } }[];
}

/** The MatchStatus a getProgramAccounts call filtered on. */
function statusFilterOf(config: StatusQuery): number {
  const filter = config.filters.find(
    (f) => f.memcmp?.offset === MATCH_ACCOUNT_LAYOUT.status,
  );
  if (filter?.memcmp === undefined) throw new Error("no status filter");
  return Buffer.from(filter.memcmp.bytes, "base64")[0];
}
