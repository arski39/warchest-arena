// [ARENA] What the person who JOINS a duel sees while it fills.
//
// Which, before this, was the main menu. `DuelPanel` closed itself and
// dispatched `join-lobby`, and nothing opened: `Main.handleJoinLobby` only
// opens the join modal for `source: "public"`, and the lobby-browser path gets
// away with that because the modal is already open. So the single entry point
// to the site's primary mode staked the player's money and then showed them
// the menu until the match loaded.
//
// The fix is that the joiner lands in the join modal and the join modal knows
// what a duel is. That matters beyond the blank screen: the two players in a
// 1v1 were about to be looking at visibly different rooms, which is the kind
// of asymmetry nobody notices until someone asks why the other person "sees
// something different".
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", async (orig) => {
  const actual = await orig<typeof import("../../src/client/Utils")>();
  return { ...actual, translateText: (key: string) => key };
});

import { JoinLobbyModal } from "../../src/client/JoinLobbyModal";

/** 1 WARC a seat, 6 decimals, like the devnet mint. */
const DUEL_WAGER = {
  entryFee: "1000000",
  maxPlayers: 2,
  decimals: 6,
  symbol: "WARC",
};

function joinerView(opts: {
  players: number;
  wager?: Record<string, unknown> | null;
  startAt?: number | null;
  connecting?: boolean;
}): { text: string; buttons: string[] } {
  const el = new JoinLobbyModal();
  const m = el as unknown as Record<string, unknown>;
  m.currentLobbyId = "duelgame";
  m.isConnecting = opts.connecting ?? false;
  m.trackedWager = opts.wager === undefined ? DUEL_WAGER : opts.wager;
  m.lobbyStartAt = opts.startAt ?? null;
  m.serverTimeOffset = 0;
  m.players = Array.from({ length: opts.players }, (_, i) => ({
    clientID: `c${i}`,
    username: `player${i}`,
  }));
  const host = document.createElement("div");
  render((m.renderBody as () => unknown)() as never, host);
  return {
    text: host.textContent ?? "",
    buttons: [...host.querySelectorAll("o-button")].map(
      (b) => (b as unknown as { title: string }).title ?? "",
    ),
  };
}

describe("[ARENA] the duel screen the joiner gets", () => {
  it("shows the pot and both seats, not a generic lobby", () => {
    const { text } = joinerView({ players: 1 });

    expect(text).toContain("duel.pot_label");
    // Two stakes of 1 WARC. Rendered as data, outside the translated string.
    expect(text).toContain("2 WARC");
    expect(text).toContain("player0");
    // The other seat is drawn as an empty seat, which is the whole question on
    // this screen.
    expect(text).toContain("duel.slot_open");
  });

  it("counts down once both seats are staked", () => {
    const { text } = joinerView({ players: 2, startAt: Date.now() + 5_000 });

    expect(text).toContain("duel.starting_in");
    expect(text).not.toContain("duel.slot_open");
  });

  it("never offers the joiner a cancel-and-refund", () => {
    // The host may cancel an unfilled duel; the joiner may not, and this is a
    // chain fact rather than a UI preference. The joiner is the one who FILLS
    // the lobby, so the escrow flips to InProgress the moment their stake
    // lands -- and cancel_match refuses an InProgress match for 24 hours.
    // A refund button here would be offering something that cannot happen.
    for (const players of [1, 2]) {
      const { text, buttons } = joinerView({ players });
      expect(buttons).toEqual([]);
      expect(text).not.toContain("duel.cancel_and_refund");
    }
  });

  it("says it is connecting before the lobby has answered", () => {
    // The modal is opened before the stake prompt resolves, so this is the
    // state the player is actually in while they sign. Empty seats here would
    // claim the lobby is empty, which is not known yet.
    const { text } = joinerView({ players: 0, connecting: true });

    expect(text).toContain("public_lobby.connecting");
    expect(text).not.toContain("duel.slot_open");
  });

  it("leaves every other lobby on the ordinary screen", () => {
    // Scoped on the escrow's seat count, so a 16-player wagered lobby and a
    // free one both keep the lobby view they have always had.
    const sixteen = { ...DUEL_WAGER, maxPlayers: 16 };
    for (const wager of [sixteen, null]) {
      const { text } = joinerView({ players: 1, wager });
      expect(text).not.toContain("duel.pot_label");
      expect(text).not.toContain("duel.slot_open");
    }
  });
});
