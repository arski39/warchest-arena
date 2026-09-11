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
 * The match clock, in minutes.
 *
 * A duel needs one at all: without a timer a losing player can stall, and a
 * wagered match that never ends leaves the pot escrowed until the 24-hour
 * `cancel_match` timeout refunds it — which pays nobody for the game they won.
 *
 * Upstream's values, kept deliberately: a compact map is smaller, so it is
 * decided sooner. This was briefly flattened to 15 everywhere and reverted —
 * per-map tuning is upstream's call and there was no evidence the shorter
 * clock was a problem.
 */
export function duelMaxTimerMinutes(compact: boolean): number {
  return compact ? 10 : 15;
}
