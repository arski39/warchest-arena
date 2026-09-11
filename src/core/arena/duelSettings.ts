// [ARENA] What a 1v1 duel is played on, and under what settings.
//
// These values are upstream's, lifted out of `MapPlaylist.get1v1Config()` so
// that the ranked path and the wagered duel path read ONE list rather than two
// copies that drift. `get1v1Config()` now imports from here; nothing was
// re-tuned in the move.
//
// Why a duel takes them at all: both players stake the same amount, so both
// should get the same kind of game. Letting whoever pressed the button first
// pick the map, the bot count and the timer is an edge bought with nothing, and
// it is the player putting up money who pays for it. A duel host configures
// nothing — `HostLobbyModal` renders no settings at all in duel mode.
//
// Lives in `core/` because both `src/server/MapPlaylist.ts` and
// `src/client/HostLobbyModal.ts` need it. It imports only `core/game/Game`, so
// it stays free of anything server- or DOM-shaped.
import { GameMapType } from "../game/Game";

/**
 * The duel map pool, weighted by repetition: Australia 40%, then Iceland, Asia
 * and EuropeClassic at 20% each.
 *
 * Repetition rather than a weight table because the only consumer is a uniform
 * pick, and a table would need its own sampling code to say the same thing.
 */
export const DUEL_MAP_POOL: readonly GameMapType[] = [
  GameMapType.Australia,
  GameMapType.Australia,
  GameMapType.Iceland,
  GameMapType.Asia,
  GameMapType.EuropeClassic,
];

/** How often a duel is played on the compact variant of its map. */
export const DUEL_COMPACT_CHANCE = 0.2;

export function randomDuelMap(): GameMapType {
  return DUEL_MAP_POOL[Math.floor(Math.random() * DUEL_MAP_POOL.length)]!;
}

export function duelIsCompact(): boolean {
  return Math.random() < DUEL_COMPACT_CHANCE;
}

/** A smaller map wants fewer bots, or the two humans never meet. */
export function duelBots(compact: boolean): number {
  return compact ? 100 : 400;
}

/**
 * The match clock, in minutes. **Always 15, on every map.**
 *
 * A duel needs one at all: without a timer a losing player can stall, and a
 * wagered match that never ends leaves the pot escrowed until the 24-hour
 * `cancel_match` timeout refunds it — which pays nobody for the game they won.
 *
 * ⚠️ This is the one value in this file that is deliberately **not** upstream's.
 * `get1v1Config()` shortens the clock to 10 on a compact map, which is sound
 * tuning for a free ladder game and the wrong trade here: a duel is something
 * two people paid a fixed stake to enter, and "how long do I have" should not
 * depend on a map roll they did not choose and are not shown. A predictable
 * contest is worth more than per-map tuning once money is involved.
 *
 * `compact` is kept in the signature rather than dropped so the divergence
 * stays visible at both call sites instead of looking like the parameter was
 * never relevant. The ranked path (`MapPlaylist.get1v1Config()`) reads this
 * too and therefore also gets 15 — harmless here, since Ranked is hidden in
 * this fork (its queue 404s).
 */
export function duelMaxTimerMinutes(_compact: boolean): number {
  return 15;
}
