// [ARENA] What this browser staked on a given match, remembered for the end
// screen.
//
// The end-of-match modal runs inside the game, where the lobby is long gone:
// `GameStartInfo` carries the map, the seed and the roster, but no escrow --
// deliberately, since none of the simulation may depend on one. So the only
// place that knows a match was wagered is the stake gate that took the
// payment, and the only way that fact reaches the win screen is if the gate
// writes it down.
//
// Keyed by game id, in sessionStorage, for two reasons. A reload mid-match is
// ordinary -- the player reconnects and plays on -- and losing the stake here
// would show them the free-play screen after winning real tokens. And keying
// on the id is what stops the *next* match inheriting this one's pot.
//
// Nothing here is authoritative. It is a display cache of a number the chain
// already holds: the payout is decided by `settle_match` against the server's
// replay, never by anything a browser remembers. A tampered entry can only
// mislead the person who tampered with it.
const KEY_PREFIX = "arena_wager_game:";

/** The subset of a WagerInfo the end screen renders. */
export interface StakedMatch {
  /** u64 base units as a decimal string; a pot is not a Number. */
  entryFee: string;
  maxPlayers: number;
  rakeBps: number;
  decimals: number;
  symbol: string;
}

export function rememberStakedMatch(gameID: string, wager: StakedMatch): void {
  try {
    sessionStorage.setItem(
      KEY_PREFIX + gameID,
      JSON.stringify({
        entryFee: wager.entryFee,
        maxPlayers: wager.maxPlayers,
        rakeBps: wager.rakeBps,
        decimals: wager.decimals,
        symbol: wager.symbol,
      }),
    );
  } catch {
    // Private mode, or storage disabled. The end screen falls back to the
    // free-play one, which is worse looking and never wrong.
  }
}

/**
 * What was staked on this match, or null if it was free (or unreadable).
 *
 * Validated on the way out rather than trusted: a hand-edited entry, or one
 * left by an older build with a different shape, must read as "free game"
 * instead of throwing inside a render.
 */
export function stakedMatch(gameID: string): StakedMatch | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY_PREFIX + gameID);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<StakedMatch>;
    if (
      typeof v.entryFee !== "string" ||
      !/^\d+$/.test(v.entryFee) ||
      typeof v.maxPlayers !== "number" ||
      typeof v.rakeBps !== "number" ||
      typeof v.decimals !== "number" ||
      typeof v.symbol !== "string"
    ) {
      return null;
    }
    return {
      entryFee: v.entryFee,
      maxPlayers: v.maxPlayers,
      rakeBps: v.rakeBps,
      decimals: v.decimals,
      symbol: v.symbol,
    };
  } catch {
    return null;
  }
}
