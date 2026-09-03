// [ARENA] new file — the fixed stake tiers, and the one place a tier is turned
// into token base units.
//
// Wager amounts are a short fixed list rather than a free-form number. That is
// a product decision (inspired by DamnBruh's $1/$5/$20 lobbies), but it also
// buys a security property worth stating plainly:
//
//   The server derives `entry_fee` from the tier. The client never sends an
//   amount. So an off-tier stake is not "rejected" — it is unrepresentable.
//
// That is the same reasoning CLAUDE.md gives for gating a wagered start on the
// escrow reporting `InProgress` rather than on a seat count: a check that
// cannot drift from the rule it enforces.
//
// A drifted client copy of STAKE_TIERS therefore cannot create a wrong escrow.
// The worst it can do is offer a tier the server refuses. The shared list is
// for *rendering*; the derivation has exactly one implementation, below.
//
// **This file imports nothing, deliberately.** It is loaded by the server, by
// the browser, and by the root bankrun suite, which reaches across the repo
// boundary into OpenFrontIO/ and can only do that for modules with no
// OpenFrontIO imports and no Node built-ins. Zod is not a root dependency
// either, which is why validation here is hand-written rather than a schema.

/**
 * The stakes a host may choose, in **whole units** of the operator's staking
 * token (`ARENA_STAKE_MINT`). Not base units — see `entryFeeForTier`.
 *
 * `ARENA_MAX_ENTRY_FEE` filters this list per deployment; it is not the
 * offered set on its own. Ask the server (`wagerOptions` on
 * `GET /api/game/:id`) rather than assuming all three are available.
 */
export const STAKE_TIERS = [1, 5, 25] as const;

export type StakeTier = (typeof STAKE_TIERS)[number];

export function isStakeTier(value: unknown): value is StakeTier {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (STAKE_TIERS as readonly number[]).includes(value)
  );
}

/**
 * The largest `decimals` a staking mint may declare.
 *
 * Not arbitrary. `entry_fee` is a u64, and the largest tier is 25, so the
 * derivation below overflows once `25 * 10^decimals >= 2^64`:
 *
 *     2^64 - 1        = 18446744073709551615
 *     25 * 10^17      = 2500000000000000000   ok
 *     25 * 10^18      = 25000000000000000000  overflows
 *
 * so the arithmetic ceiling is 17. This is deliberately far stricter: SOL is 9
 * and USDC is 6, and a mint declaring more than 9 is a typo or a hostile
 * configuration. Being strict here turns what would otherwise be a throw
 * inside `buildCreateMatchIx` — surfacing as a 502 on a lobby the host has
 * already set up — into a one-line refusal at boot.
 *
 * Raising this past 17 is not a policy change, it is a correctness bug.
 */
export const MAX_STAKE_MINT_DECIMALS = 9;

/**
 * A tier in whole tokens -> `entry_fee` in base units.
 *
 * The single derivation. Throws rather than saturating: every caller is either
 * boot-time configuration or a validated request, so a bad value here is a
 * programming error, not user input.
 */
export function entryFeeForTier(tier: number, decimals: number): bigint {
  if (!isStakeTier(tier)) {
    throw new RangeError(`${tier} is not a stake tier`);
  }
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_STAKE_MINT_DECIMALS
  ) {
    throw new RangeError(
      `mint decimals ${decimals} outside 0..${MAX_STAKE_MINT_DECIMALS}`,
    );
  }
  return BigInt(tier) * 10n ** BigInt(decimals);
}

/**
 * Base units -> a human string, optionally suffixed with the token symbol.
 *
 * **Never routes through `Number`.** `entryFee` crosses the wire as a decimal
 * string precisely because a u64 loses precision above 2^53; parsing it back
 * to a float to divide would reintroduce exactly the bug the string avoids.
 * This is BigInt string surgery instead.
 *
 * Trailing zeros are trimmed, so 6-decimal base units render as "5" rather
 * than "5.000000", and a sub-unit amount still renders exactly.
 */
export function formatStake(
  baseUnits: bigint | string,
  decimals: number,
  symbol?: string,
): string {
  const raw = typeof baseUnits === "bigint" ? baseUnits : BigInt(baseUnits);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;

  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = abs % scale;

  let text = whole.toString();
  if (fraction > 0n) {
    const padded = fraction.toString().padStart(decimals, "0");
    text += `.${padded.replace(/0+$/, "")}`;
  }
  if (negative) text = `-${text}`;
  return symbol ? `${text} ${symbol}` : text;
}
