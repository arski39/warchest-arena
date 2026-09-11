// [ARENA] The duel map pool, and that both consumers really share it.
//
// The pool was upstream's, inline in `MapPlaylist.get1v1Config()`. The wagered
// duel path needed the same one, and the obvious move — copying the five map
// names into the client — is the exact drift this repo has been bitten by
// before (the wallet-signature prefix declared twice with a "must match server"
// comment). So it lives in one module and this asserts that the ranked path
// still draws from it.
//
// It matters beyond tidiness: a duel is a wagered match, so the map is part of
// what both players paid for. Two players staking the same amount getting
// systematically different games is a fairness problem, not a cosmetic one.
import { describe, expect, it, vi } from "vitest";
import {
  DUEL_COMPACT_CHANCE,
  DUEL_MAP_POOL,
  duelBots,
  duelIsCompact,
  duelMaxTimerMinutes,
  randomDuelMap,
} from "../src/core/arena/duelSettings";
import { GameMapType } from "../src/core/game/Game";
import { MapPlaylist } from "../src/server/MapPlaylist";

describe("[ARENA] duel settings", () => {
  it("weights Australia at 40% and the rest at 20% each", () => {
    // Weighting is by repetition, so the pool's shape IS the distribution.
    // Asserting the counts rather than the order, which carries no meaning.
    const counts = new Map<GameMapType, number>();
    for (const map of DUEL_MAP_POOL) {
      counts.set(map, (counts.get(map) ?? 0) + 1);
    }
    expect(DUEL_MAP_POOL).toHaveLength(5);
    expect(counts.get(GameMapType.Australia)).toBe(2);
    expect(counts.get(GameMapType.Iceland)).toBe(1);
    expect(counts.get(GameMapType.Asia)).toBe(1);
    expect(counts.get(GameMapType.EuropeClassic)).toBe(1);
  });

  it("only ever picks a map from the pool", () => {
    for (let i = 0; i < 200; i++) {
      expect(DUEL_MAP_POOL).toContain(randomDuelMap());
    }
  });

  it("gives the ranked 1v1 path the same pool", () => {
    // The point of the shared module. If someone re-inlines a list in either
    // place, this is what notices.
    const playlist = new MapPlaylist();
    for (let i = 0; i < 50; i++) {
      const config = playlist.get1v1Config();
      expect(DUEL_MAP_POOL).toContain(config.gameMap);
      expect(config.maxPlayers).toBe(2);
      // Nations are a third party deciding a wagered match.
      expect(config.nations).toBe("disabled");
    }
  });

  it("keeps the ranked config's bots and timer tied to the shared helpers", () => {
    // Pinning both branches rather than whichever one chance produced: these
    // moved out of get1v1Config in the extraction, and a silent re-tune there
    // would change what a staked match plays like.
    expect(duelBots(false)).toBe(400);
    expect(duelBots(true)).toBe(100);
    // [ARENA] 15 on every map, deliberately unlike upstream's 10-on-compact.
    // A duel is a fixed-stake contest, so how long you have must not depend on
    // a map roll the players did not choose and are not shown.
    expect(duelMaxTimerMinutes(false)).toBe(15);
    expect(duelMaxTimerMinutes(true)).toBe(15);
  });

  it("uses the compact variant about a fifth of the time", () => {
    expect(DUEL_COMPACT_CHANCE).toBe(0.2);
    // Driven, not sampled: a probabilistic assertion here would be a flake
    // waiting to happen, and the threshold is what actually matters.
    const random = vi.spyOn(Math, "random");
    random.mockReturnValue(0.19);
    expect(duelIsCompact()).toBe(true);
    random.mockReturnValue(0.2);
    expect(duelIsCompact()).toBe(false);
    random.mockRestore();
  });
});
