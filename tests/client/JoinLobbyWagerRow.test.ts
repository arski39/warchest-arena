// [ARENA] The lobby browser, once wagered lobbies may be listed in it.
//
// Before Phase 4 a joining player saw no preview at all before staking: the
// stake gate ran ahead of joinLobby(), so the first thing they saw was a wallet
// prompt for an amount they had no way to check. A public tier browser is only
// an improvement if the row tells the truth about the money, so that is what
// this pins:
//
//   * the winner's take leads, and it is net of rake — the same arithmetic as
//     the stake prompt the row leads to, via the shared winnerPayout();
//   * amounts are whole tokens, never u64 base units;
//   * the filter is built from the stakes actually on offer, not from
//     STAKE_TIERS, because ARENA_MAX_ENTRY_FEE can suppress some and a chip
//     with nothing behind it is a dead end.

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { JoinLobbyModal } from "../../src/client/JoinLobbyModal";
import type {
  PublicGameInfo,
  PublicWagerSummary,
} from "../../src/core/Schemas";

function wager(
  overrides: Partial<PublicWagerSummary> = {},
): PublicWagerSummary {
  return {
    entryFee: "5000000",
    maxPlayers: 4,
    decimals: 6,
    rakeBps: 0,
    symbol: "ARENA",
    ...overrides,
  };
}

function lobby(gameID: string, w?: PublicWagerSummary): PublicGameInfo {
  return {
    gameID,
    numClients: 1,
    publicGameType: "hosted",
    ...(w === undefined ? {} : { wager: w }),
  } as PublicGameInfo;
}

/** Renders one of the modal's fragments without standing up the whole modal. */
function textOf(fragment: unknown): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(fragment as never, host);
  return host.textContent ?? "";
}

describe("[ARENA] wagered rows in the lobby browser", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("leads with what the winner takes, and prices the seat under it", () => {
    const modal = new JoinLobbyModal();
    // 4 seats at 5 each, no rake.
    const text = textOf(
      (
        modal as unknown as {
          renderRowWager: (l: PublicGameInfo) => unknown;
        }
      ).renderRowWager(lobby("g1", wager())),
    );

    expect(text).toContain("20 ARENA");
    expect(text).toContain("5 ARENA");
    // Base units must never reach a player's eye.
    expect(text).not.toContain("5000000");
  });

  it("subtracts the rake, so the card never over-promises", () => {
    // 20 gross, 10% rake -> 18. A row promising more than the stake prompt
    // pays is the kind of discrepancy nobody reports; they just stop trusting
    // the number.
    const modal = new JoinLobbyModal();
    const text = textOf(
      (
        modal as unknown as {
          renderRowWager: (l: PublicGameInfo) => unknown;
        }
      ).renderRowWager(lobby("g1", wager({ rakeBps: 1000 }))),
    );
    expect(text).toContain("18 ARENA");
    expect(text).not.toContain("20 ARENA");
  });

  it("draws nothing for a free lobby", () => {
    const modal = new JoinLobbyModal();
    const drawn = (
      modal as unknown as {
        renderRowWager: (l: PublicGameInfo) => unknown;
      }
    ).renderRowWager(lobby("g1"));
    expect(drawn).toBe("");
  });

  it("offers a filter chip per distinct stake, cheapest first", () => {
    const modal = new JoinLobbyModal() as unknown as {
      hostedLobbies: PublicGameInfo[];
      stakesOnOffer: () => { entryFee: string; label: string }[];
    };
    modal.hostedLobbies = [
      lobby("a", wager({ entryFee: "25000000" })),
      lobby("b", wager({ entryFee: "1000000" })),
      lobby("c", wager({ entryFee: "5000000" })),
      // A second lobby at the same stake must not produce a second chip.
      lobby("d", wager({ entryFee: "5000000" })),
      lobby("e"),
    ];

    expect(modal.stakesOnOffer().map((s) => s.label)).toEqual([
      "1 ARENA",
      "5 ARENA",
      "25 ARENA",
    ]);
  });

  it("sorts stakes numerically, not as strings", () => {
    // "25000000" < "5000000" lexicographically. Sorting the wire form as text
    // would put the biggest stake in the middle.
    const modal = new JoinLobbyModal() as unknown as {
      hostedLobbies: PublicGameInfo[];
      stakesOnOffer: () => { entryFee: string }[];
    };
    modal.hostedLobbies = [
      lobby("a", wager({ entryFee: "5000000" })),
      lobby("b", wager({ entryFee: "25000000" })),
    ];
    expect(modal.stakesOnOffer().map((s) => s.entryFee)).toEqual([
      "5000000",
      "25000000",
    ]);
  });

  it("hides the filter until there is something to filter", () => {
    // One stake, or none, means every chip but "any" is the whole list.
    const modal = new JoinLobbyModal() as unknown as {
      hostedLobbies: PublicGameInfo[];
      renderStakeFilter: () => unknown;
    };
    modal.hostedLobbies = [lobby("a", wager()), lobby("b")];
    expect(modal.renderStakeFilter()).toBe("");
  });
});
