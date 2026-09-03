// [ARENA] new file — resolves the deployment's staking token once, at boot.
//
// A wager tier ("5") only means something against a known token and its
// decimals, so the mint stopped being a host input and became an operator
// setting. That closes a footgun on the way past: a host could previously point
// a lobby at any mint they liked, and nothing validated it beyond base58 until
// `create_match` failed on chain.
//
// Shaped after devBypass.ts rather than folded into preflight.ts's `Preflight`
// union, for three reasons:
//
//   * `Preflight` is a verdict type. `runWagerPreflight()`'s return value is
//     discarded at both call sites (Master.ts and Worker.ts), so widening the
//     `ok` variant would quietly make it load-bearing where nobody reads it.
//   * A lazily self-resolving accessor would put an await back on the request
//     path, which is exactly what H1's boot preflight removed.
//   * An eagerly memoized module-scope read would re-create the master/worker
//     dotenv trap: Server.ts calls dotenv.config() after its imports, so any
//     module-level process.env read is empty in the master. Env is therefore
//     read *inside* resolveStakeMint(). See CLAUDE.md's "master/worker env
//     trap".
//
// Like the dev bypass, this is per-process module state, resolved independently
// by the master and by each worker, and it fails closed: stakeMint() reads null
// until resolution has succeeded.
import { PublicKey } from "@solana/web3.js";
import {
  decodeMintAccount,
  MintAccountDecodeError,
} from "../../core/arena/arenaProgram";
import {
  entryFeeForTier,
  isStakeTier,
  MAX_STAKE_MINT_DECIMALS,
  STAKE_TIERS,
  type StakeTier,
} from "../../core/arena/stakeTiers";
import { arenaMaxEntryFee, entryFeeWithinCap } from "./matchCreator";
import { getConnection } from "./rpcClient";

/** Bounds the operator-supplied display symbol. Reaches every browser. */
const SYMBOL_PATTERN = /^[A-Za-z0-9._-]{1,12}$/;

export interface ResolvedStake {
  mint: PublicKey;
  mintBase58: string;
  decimals: number;
  /**
   * Display only, and an unverifiable claim — it is an operator string, not
   * on-chain metadata. The mint address stays visible in the stake prompt so a
   * player can check what they are actually being asked to stake.
   */
  symbol: string;
  /** The tiers this deployment offers, after ARENA_MAX_ENTRY_FEE filtering. */
  tiers: StakeTier[];
  /** tier -> entry_fee in base units. The one derivation, precomputed. */
  entryFees: Map<StakeTier, bigint>;
}

let resolved: ResolvedStake | null = null;

/**
 * The staking token, or null if it has not been resolved successfully.
 *
 * Synchronous and the only thing call sites should consult. Null before boot
 * completes is the same fail-closed posture as `wageringOperational()` reading
 * false, and preflight refuses to report `ok` without it.
 */
export function stakeMint(): ResolvedStake | null {
  return resolved;
}

export type StakeMintOutcome =
  | { ok: true; stake: ResolvedStake }
  | { ok: false; reason: string };

export type TierOutcome =
  | { ok: true; entryFee: bigint }
  /** Not one of STAKE_TIERS at all — only a broken or hostile client. */
  | { ok: false; error: "wager_tier_invalid" }
  /** A real tier this deployment suppressed via ARENA_MAX_ENTRY_FEE. */
  | { ok: false; error: "wager_entry_fee_too_high" };

/**
 * Turns a requested tier into an entry fee, or says why not.
 *
 * Pure, and split out from the express handler on purpose — the same precedent
 * `entryFeeWithinCap` set, so the boundary is testable without standing up a
 * server. The handler is a thin shell over this.
 *
 * Checks membership of the deployment's **offered** list, not of STAKE_TIERS,
 * so the cap is enforced server-side rather than being a client-side courtesy.
 */
export function resolveTierEntryFee(
  stake: ResolvedStake,
  tier: unknown,
): TierOutcome {
  if (!isStakeTier(tier)) {
    return { ok: false, error: "wager_tier_invalid" };
  }
  const entryFee = stake.entryFees.get(tier);
  if (entryFee === undefined) {
    // A tier that exists but this deployment does not offer.
    return { ok: false, error: "wager_entry_fee_too_high" };
  }
  // Belt and braces: entryFees was built through entryFeeWithinCap, but keeping
  // the check on the path means the test that pins that boundary still means
  // something if the map is ever built differently.
  if (!entryFeeWithinCap(entryFee)) {
    return { ok: false, error: "wager_entry_fee_too_high" };
  }
  return { ok: true, entryFee };
}

/**
 * Reads ARENA_STAKE_MINT, fetches it, decodes it, and works out which tiers
 * this deployment can offer. Never throws; preflight turns a failure into a
 * `broken` verdict carrying the reason.
 */
export async function resolveStakeMint(): Promise<StakeMintOutcome> {
  resolved = null;

  const raw = process.env.ARENA_STAKE_MINT;
  if (!raw) {
    return {
      ok: false,
      reason:
        "ARENA_PROGRAM_ID is set but ARENA_STAKE_MINT is not — there is no " +
        "token for stakes to be denominated in, and a tier of 5 has nothing " +
        "to be 5 of",
    };
  }

  let mint: PublicKey;
  try {
    mint = new PublicKey(raw);
  } catch {
    return {
      ok: false,
      reason: `ARENA_STAKE_MINT is not a valid base58 address ("${raw}")`,
    };
  }

  const symbol = process.env.ARENA_STAKE_SYMBOL ?? "";
  if (symbol !== "" && !SYMBOL_PATTERN.test(symbol)) {
    return {
      ok: false,
      reason:
        `ARENA_STAKE_SYMBOL "${symbol}" must match ${SYMBOL_PATTERN.source} — ` +
        "it is displayed to every player",
    };
  }

  let info;
  try {
    info = await getConnection().getAccountInfo(mint);
  } catch (e) {
    return {
      ok: false,
      reason: `could not reach the RPC to verify ARENA_STAKE_MINT (${
        e instanceof Error ? e.message : String(e)
      })`,
    };
  }
  if (info === null) {
    return {
      ok: false,
      reason: `no account at ARENA_STAKE_MINT ${mint.toBase58()} on this cluster`,
    };
  }

  let decoded;
  try {
    decoded = decodeMintAccount(info.data, info.owner);
  } catch (e) {
    if (e instanceof MintAccountDecodeError) {
      return {
        ok: false,
        reason: `ARENA_STAKE_MINT ${mint.toBase58()} is not a usable SPL mint: ${e.message}`,
      };
    }
    throw e;
  }

  // See MAX_STAKE_MINT_DECIMALS: past this the largest tier overflows a u64
  // inside buildCreateMatchIx, which would surface as a 502 on a live lobby.
  if (decoded.decimals > MAX_STAKE_MINT_DECIMALS) {
    return {
      ok: false,
      reason:
        `ARENA_STAKE_MINT ${mint.toBase58()} declares ${decoded.decimals} ` +
        `decimals; the maximum supported is ${MAX_STAKE_MINT_DECIMALS}`,
    };
  }

  const entryFees = new Map<StakeTier, bigint>();
  const tiers: StakeTier[] = [];
  for (const tier of STAKE_TIERS) {
    const fee = entryFeeForTier(tier, decoded.decimals);
    // One cap knob, not two: ARENA_MAX_ENTRY_FEE filters the offered tiers
    // rather than getting a parallel ARENA_MAX_STAKE_TIER beside it.
    if (!entryFeeWithinCap(fee)) continue;
    tiers.push(tier);
    entryFees.set(tier, fee);
  }

  if (tiers.length === 0) {
    return {
      ok: false,
      reason:
        `ARENA_MAX_ENTRY_FEE (${arenaMaxEntryFee()?.toString()}) is below every ` +
        `stake tier at ${decoded.decimals} decimals, so no wager could ever be ` +
        "created — raise it or unset it",
    };
  }

  const stake: ResolvedStake = {
    mint,
    mintBase58: mint.toBase58(),
    decimals: decoded.decimals,
    symbol,
    tiers,
    entryFees,
  };
  resolved = stake;

  // The cap's meaning changes with the mint's decimals — the same
  // ARENA_MAX_ENTRY_FEE is tier 5 on a 6-decimal mint and 0.005 on a 9-decimal
  // one — so say out loud what it was taken to mean.
  const suppressed = STAKE_TIERS.filter((t) => !tiers.includes(t));
  console.log(
    `[arena/stakeMint] staking ${symbol || mint.toBase58()} ` +
      `(${decoded.decimals} decimals), tiers offered: ${tiers.join(", ")}` +
      (suppressed.length > 0
        ? `; suppressed by ARENA_MAX_ENTRY_FEE: ${suppressed.join(", ")}`
        : ""),
  );

  if (decoded.hasFreezeAuthority) {
    // Not a refusal: a legitimate token may well have one, and whether that is
    // acceptable is the operator's call. But picking one mint for the whole
    // deployment turns what used to be a per-lobby risk into a global one, so
    // it should not be discovered later.
    console.warn(
      `[arena/stakeMint] ${mint.toBase58()} has a freeze authority. If it ` +
        "freezes the vault or a player's token account, BOTH settle_match and " +
        "cancel_match fail on the transfer and those stakes have no on-chain " +
        "path out — the 24h timeout-cancel does not help, because it is the " +
        "transfer itself that fails.",
    );
  }

  return { ok: true, stake };
}
