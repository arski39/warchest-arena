// [ARENA] What the end-of-match screen says after a match somebody paid for.
//
// Upstream's win modal ends every game with a promo box: "Support OpenFront!"
// over three buyable territory skins. In this fork that box could never show a
// skin -- `/cosmetics.json` is served empty and the storefront is deleted -- so
// it rendered as a heading advertising upstream by name, from a fork, at the
// exact moment two players wanted to know what had happened to their tokens.
//
// A wagered match now ends on the pot instead: the winner sees what they take,
// the loser sees what it cost and a way back in.
import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  getGamesPlayed: () => 10,
  isInIframe: () => false,
  TUTORIAL_VIDEO_URL: "https://example.com/tutorial",
}));

vi.mock("../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: { happytime: vi.fn(), gameplayStop: vi.fn() },
}));

vi.mock("../../src/client/SteamSDK", () => ({
  steamSDK: { isOnSteam: () => false },
}));

import { rememberStakedMatch } from "../../src/client/arena/wagerSession";
import { WinModal } from "../../src/client/hud/layers/WinModal";

/** Tier 1 of a 6-decimal mint, two seats, the deployment's 2.5% rake. */
const DUEL = {
  entryFee: "1000000",
  maxPlayers: 2,
  rakeBps: 250,
  decimals: 6,
  symbol: "WARC",
};

function endScreen(opts: { won: boolean; wagered: boolean }): {
  text: string;
  buttons: string[];
} {
  if (opts.wagered) rememberStakedMatch("endgame", DUEL);
  const el = new WinModal();
  const m = el as unknown as Record<string, unknown>;
  el.game = {
    gameID: () => "endgame",
    config: () => ({ gameConfig: () => ({ rankedType: undefined }) }),
    myPlayer: () => ({ isAlive: () => false }),
  } as never;
  m.isWin = opts.won;
  el.show();
  const host = document.createElement("div");
  render((m.innerHtml as () => unknown)() as never, host);
  return {
    text: host.textContent ?? "",
    // o-button carries its label as a property, not as text.
    buttons: [...host.querySelectorAll("o-button")].map(
      (b) => (b as unknown as { title: string }).title ?? "",
    ),
  };
}

describe("[ARENA] the end of a wagered match", () => {
  beforeEach(() => sessionStorage.clear());

  it("tells the winner what they take, net of rake", () => {
    const { text } = endScreen({ won: true, wagered: true });

    expect(text).toContain("win_modal.arena_won_title");
    // 2 WARC pot less 2.5% = 1.95. Rendered as data, outside the translated
    // string, so a missing translation cannot hide the number -- and through
    // winnerPayout(), so it is the same figure the stake prompt quoted.
    expect(text).toContain("1.95 WARC");
    expect(text).toContain("win_modal.arena_won_note");
  });

  it("tells the loser what it cost, and offers another go", () => {
    const { text, buttons } = endScreen({ won: false, wagered: true });

    expect(text).toContain("win_modal.arena_lost_title");
    expect(text).toContain("1 WARC");
    expect(buttons).toContain("win_modal.arena_try_again");
  });

  it("never advertises a storefront this deployment does not have", () => {
    // The whole point, and it must hold for a free game too: the promo could
    // only ever render an empty box under upstream's name.
    for (const wagered of [true, false]) {
      for (const won of [true, false]) {
        sessionStorage.clear();
        const { text } = endScreen({ won, wagered });
        expect(text).not.toContain("win_modal.support_openfront");
        expect(text).not.toContain("win_modal.territory_pattern");
      }
    }
  });

  it("leaves a free match on the ordinary screen", () => {
    // Scoped on the stake actually recorded by the join gate, so nothing
    // changes for solo, free 1v1 or a public FFA.
    const { text } = endScreen({ won: true, wagered: false });

    expect(text).not.toContain("win_modal.arena_won_title");
    expect(text).not.toContain("WARC");
  });

  it("does not carry one match's pot into the next", () => {
    // sessionStorage survives the reload a reconnecting player goes through,
    // which is why the key is per-game rather than a single "current wager".
    rememberStakedMatch("someothergame", DUEL);
    const el = new WinModal();
    const m = el as unknown as Record<string, unknown>;
    el.game = {
      gameID: () => "endgame",
      config: () => ({ gameConfig: () => ({ rankedType: undefined }) }),
      myPlayer: () => ({ isAlive: () => false }),
    } as never;
    m.isWin = true;
    el.show();

    expect(m.stake).toBeNull();
  });
});
