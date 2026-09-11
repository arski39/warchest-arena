// [ARENA] In a duel, eating your opponent has to BE the win.
//
// Upstream ends an FFA when somebody owns most of the map or the match timer
// expires, and only applies "last human standing wins" to its ranked 1v1 queue
// (rankedType === OneVOne). A wagered duel is the same shape of match -- two
// humans, one pot, the bots are scenery -- but it is a private lobby and
// deliberately not ranked, so it fell through to the generic condition.
//
// Seen live on game ihMXJTQm: one player ate the other about 70 seconds in, the
// match did not end, both players left, and the server's replay faithfully
// reproduced a game with no winner. settle_match had nobody to pay, so 2 WARC
// sat in escrow waiting out the 24-hour refund. The replay was not wrong -- the
// win condition was.
//
// This runs the real core, so it is also what proves the REPLAY reaches the
// same verdict: settlement pays verdict.winner from a re-simulation, never the
// client's own claim.
import { WinCheckExecution } from "../src/core/execution/WinCheckExecution";
import {
  Game,
  GameMode,
  PlayerInfo,
  PlayerType,
  RankedType,
} from "../src/core/game/Game";
import { GameUpdateType, WinUpdate } from "../src/core/game/GameUpdates";
import { GameConfig } from "../src/core/Schemas";
import { setup } from "./util/Setup";

async function duel(
  humans: number,
  config: Partial<GameConfig> = {},
): Promise<Game> {
  const players = Array.from(
    { length: humans },
    (_, i) =>
      new PlayerInfo(
        `player${i + 1}`,
        PlayerType.Human,
        `client${i + 1}`,
        `p${i + 1}_id`,
      ),
  );
  return setup(
    "plains",
    { gameMode: GameMode.FFA, maxPlayers: humans, ...config },
    players,
  );
}

/**
 * Give a player real territory.
 *
 * players() filters on isAlive(), which means owning tiles — setSpawnTile()
 * alone leaves a player invisible to the FFA win check, which is precisely the
 * state a player is in once they have been eaten.
 */
function giveLand(game: Game, n: number, tiles = 12) {
  const player = game.player(`p${n}_id`);
  let given = 0;
  for (let x = 0; given < tiles && x < game.map().width(); x++) {
    for (let y = 0; given < tiles && y < game.map().height(); y++) {
      const tile = game.map().ref(x, y);
      if (!game.map().isLand(tile) || game.hasOwner(tile)) continue;
      player.conquer(tile);
      given++;
    }
  }
}

// WinCheckExecution only checks on ticks divisible by 10, so 11 always reaches
// at least one check.
function winUpdates(game: Game): WinUpdate[] {
  game.addExecution(new WinCheckExecution());
  const wins: WinUpdate[] = [];
  for (let i = 0; i < 11; i++) {
    wins.push(...game.executeNextTick()[GameUpdateType.Win]);
  }
  return wins;
}

describe("[ARENA] duel win condition", () => {
  it("declares the survivor the winner when the other human is gone", async () => {
    // The live failure. p2 never spawns, so players() does not carry them --
    // the same state the simulation is in once they have been eaten.
    const game = await duel(2);
    giveLand(game, 1);

    const wins = winUpdates(game);

    expect(wins).toHaveLength(1);
    expect(wins[0].winner).toEqual(["player", "client1"]);
  });

  it("does not end the duel while both humans are still in it", async () => {
    // Neither owns the map and no timer has expired, so there is nothing to
    // decide yet -- ending here would pay out a pot mid-match.
    const game = await duel(2);
    giveLand(game, 1);
    giveLand(game, 2);

    expect(winUpdates(game)).toHaveLength(0);
  });

  it("hands the win to the player who stayed when the other quits", async () => {
    // Leaving a duel forfeits it, and this is the payout rule -- not a
    // courtesy. GameServer marks a client disconnected after 30s of silence
    // and puts a mark_disconnected intent in the turn log, so the server's
    // replay reaches this same verdict from the record alone. That matters
    // more than the live game does: settlement pays verdict.winner, so the
    // quitter cannot deny the pot to the player who stayed by closing the tab
    // before a winner is announced.
    const game = await duel(2);
    giveLand(game, 1);
    giveLand(game, 2);
    game.player("p2_id").markDisconnected(true);

    const wins = winUpdates(game);

    expect(wins).toHaveLength(1);
    expect(wins[0].winner).toEqual(["player", "client1"]);
  });

  it("does not crown anybody when both players walk away", async () => {
    // Both gone is not a win for either of them, and inventing one would pay a
    // pot to somebody who did not win it. The escrow's 24h timeout refunds
    // instead -- the same fail-closed direction settlement takes everywhere.
    const game = await duel(2);
    giveLand(game, 1);
    giveLand(game, 2);
    game.player("p1_id").markDisconnected(true);
    game.player("p2_id").markDisconnected(true);

    expect(winUpdates(game)).toHaveLength(0);
  });

  it("still honours upstream's ranked 1v1 path", async () => {
    // The original rule must keep working on its own terms, not merely as a
    // side effect of the roster now happening to be two.
    const game = await duel(2, { rankedType: RankedType.OneVOne });
    giveLand(game, 1);

    const wins = winUpdates(game);

    expect(wins).toHaveLength(1);
    expect(wins[0].winner).toEqual(["player", "client1"]);
  });

  it("leaves a larger FFA to be decided the normal way", async () => {
    // The rule is a constant property of the match, counted from allPlayers().
    // Were it read from the living roster, a 4-player FFA would end the moment
    // it happened to be down to its last two.
    const game = await duel(4);
    giveLand(game, 1);

    expect(winUpdates(game)).toHaveLength(0);
  });
});
