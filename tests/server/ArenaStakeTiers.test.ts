// [ARENA] Stakes are a fixed list of tiers (1 / 5 / 25 whole tokens), and the
// server derives the entry fee from the tier rather than accepting an amount.
//
// That is the property this suite exists to pin: an off-tier stake is not
// "rejected", it is unrepresentable, because no amount ever crosses the wire.
// The same reasoning as gating a wagered start on the escrow reporting
// InProgress rather than on a seat count — a check that cannot drift from the
// rule it enforces.
//
// Tested as pure functions rather than through the express handler, following
// the precedent that split `entryFeeWithinCap` out of Worker.ts "so the
// boundary is testable without standing up express".

import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  entryFeeForTier,
  formatStake,
  isStakeTier,
  MAX_STAKE_MINT_DECIMALS,
  STAKE_TIERS,
} from "../../src/core/arena/stakeTiers";
import type { ResolvedStake } from "../../src/server/arena/stakeMint";

describe("[ARENA] stake tiers", () => {
  it("offers exactly 1, 5 and 25", () => {
    expect([...STAKE_TIERS]).toEqual([1, 5, 25]);
  });

  it.each([1, 5, 25])("accepts tier %i", (tier) => {
    expect(isStakeTier(tier)).toBe(true);
  });

  it.each([0, 2, 24, 26, -1, 1.5, Number.NaN, Infinity])(
    "rejects %p",
    (value) => {
      expect(isStakeTier(value)).toBe(false);
    },
  );

  it.each(["5", null, undefined, {}, [5]])("rejects non-number %p", (value) => {
    expect(isStakeTier(value)).toBe(false);
  });

  describe("entryFeeForTier", () => {
    it("derives base units at 6 decimals", () => {
      expect(entryFeeForTier(1, 6)).toBe(1_000_000n);
      expect(entryFeeForTier(5, 6)).toBe(5_000_000n);
      expect(entryFeeForTier(25, 6)).toBe(25_000_000n);
    });

    it("handles a 0-decimal mint", () => {
      // Legal and reachable — tests/arena.ts creates exactly such a mint.
      expect(entryFeeForTier(5, 0)).toBe(5n);
    });

    it("handles a 9-decimal mint", () => {
      expect(entryFeeForTier(25, 9)).toBe(25_000_000_000n);
    });

    it("stays inside a u64 at the supported ceiling", () => {
      // The whole reason MAX_STAKE_MINT_DECIMALS exists: past 17 the largest
      // tier overflows, which would throw inside buildCreateMatchIx and surface
      // as a 502 on a lobby the host has already set up.
      const largest = entryFeeForTier(25, MAX_STAKE_MINT_DECIMALS);
      expect(largest).toBeLessThanOrEqual(0xffffffffffffffffn);
    });

    it("refuses a tier it does not know", () => {
      expect(() => entryFeeForTier(10, 6)).toThrow(RangeError);
    });

    it("refuses decimals beyond the supported ceiling", () => {
      expect(() => entryFeeForTier(25, MAX_STAKE_MINT_DECIMALS + 1)).toThrow(
        RangeError,
      );
    });
  });
});

describe("[ARENA] resolveTierEntryFee", () => {
  const MINT = new PublicKey("11111111111111111111111111111112");

  function stake(tiers: number[], decimals = 6): ResolvedStake {
    return {
      mint: MINT,
      mintBase58: MINT.toBase58(),
      decimals,
      symbol: "ARENA",
      tiers: tiers as ResolvedStake["tiers"],
      entryFees: new Map(
        tiers.map((t) => [
          t as (typeof STAKE_TIERS)[number],
          entryFeeForTier(t, decimals),
        ]),
      ),
    };
  }

  async function load() {
    vi.resetModules();
    return await import("../../src/server/arena/stakeMint");
  }

  beforeEach(() => {
    vi.stubEnv("ARENA_MAX_ENTRY_FEE", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("derives the fee for an offered tier", async () => {
    const { resolveTierEntryFee } = await load();
    const out = resolveTierEntryFee(stake([1, 5, 25]), 5);
    expect(out).toEqual({ ok: true, entryFee: 5_000_000n });
  });

  it.each([0, 2, 26, -5, 1.5, "5", null])(
    "refuses %p as not a tier at all",
    async (value) => {
      const { resolveTierEntryFee } = await load();
      const out = resolveTierEntryFee(stake([1, 5, 25]), value);
      expect(out).toEqual({ ok: false, error: "wager_tier_invalid" });
    },
  );

  it("refuses a real tier this deployment suppressed", async () => {
    // The cap has to be enforced server-side; a client offering 25 anyway must
    // not be able to buy one.
    const { resolveTierEntryFee } = await load();
    const out = resolveTierEntryFee(stake([1, 5]), 25);
    expect(out).toEqual({ ok: false, error: "wager_entry_fee_too_high" });
  });

  it("re-checks the cap even if the offered map disagrees", async () => {
    // Belt and braces. entryFees is built through entryFeeWithinCap, but
    // keeping the check on the path means the boundary test still means
    // something if the map is ever built differently.
    vi.stubEnv("ARENA_MAX_ENTRY_FEE", "1000000");
    const { resolveTierEntryFee } = await load();
    const out = resolveTierEntryFee(stake([1, 5, 25]), 5);
    expect(out).toEqual({ ok: false, error: "wager_entry_fee_too_high" });
  });

  it("accepts a tier exactly at the cap", async () => {
    vi.stubEnv("ARENA_MAX_ENTRY_FEE", "5000000");
    const { resolveTierEntryFee } = await load();
    expect(resolveTierEntryFee(stake([1, 5]), 5)).toEqual({
      ok: true,
      entryFee: 5_000_000n,
    });
  });
});

describe("[ARENA] formatStake", () => {
  it("renders whole tokens", () => {
    expect(formatStake(5_000_000n, 6)).toBe("5");
    expect(formatStake(25_000_000n, 6, "ARENA")).toBe("25 ARENA");
  });

  it("trims trailing zeros but keeps real fractions", () => {
    expect(formatStake(1_500_000n, 6)).toBe("1.5");
    expect(formatStake(1_050_000n, 6)).toBe("1.05");
  });

  it("renders a sub-unit amount exactly", () => {
    expect(formatStake(1n, 6)).toBe("0.000001");
  });

  it("handles a 0-decimal mint", () => {
    expect(formatStake(25n, 0, "PIP")).toBe("25 PIP");
  });

  it("never routes a u64 through Number", () => {
    // The precision boundary the wire format exists to avoid. 2^53 + 1 is the
    // smallest integer a double cannot represent; going through Number would
    // render this as ...992 rather than ...993.
    expect(formatStake("9007199254740993", 0)).toBe("9007199254740993");
    expect(formatStake((2n ** 64n - 1n).toString(), 0)).toBe(
      "18446744073709551615",
    );
  });

  it("accepts a decimal string as well as a bigint", () => {
    expect(formatStake("5000000", 6, "ARENA")).toBe("5 ARENA");
  });
});
