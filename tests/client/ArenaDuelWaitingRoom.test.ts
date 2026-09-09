// [ARENA] What a duel host is offered while waiting, and why it is not the
// shared host-lobby start button.
//
// Reported from the live site: a duel nobody joined sat on "STARTING IN 0S.
// CLICK TO CANCEL" and the click did nothing. The label was the part that made
// it unreadable. The countdown a listed duel eventually shows is armed by
// maybeAutoStartListed() five minutes after listing, and when it expires
// cancelUnfilledWageredMatch() CANCELS the lobby and refunds the stake -- so
// the screen promised a start at the exact moment a cancellation was due.
//
// The cancel could not work either: maybeAutoStartListed() only skips a lobby
// whose startsAt is already set, so a manual disarm is re-armed on the next
// tick a second later. Offering an inert button on the one screen where the
// player has money at stake is what this pins.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { WagerInfo } from "../../src/core/Schemas";

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  renderDuration: vi.fn(() => "4:32"),
  getSecondsUntilServerTimestamp: vi.fn(() => 272),
  getMapName: vi.fn((m: string) => m),
  getModifierLabels: vi.fn(() => []),
  calculateServerTimeOffset: vi.fn(() => 0),
  translateModifier: vi.fn((m: string) => m),
}));

import { HostLobbyModal } from "../../src/client/HostLobbyModal";

function wagerInfo(): WagerInfo {
  return {
    matchPDA: "11111111111111111111111111111112",
    vault: "11111111111111111111111111111113",
    mint: "CtVDnzfPa4TDGLv886X3FJkbzZz5LXt9RpLHWNMtsJLe",
    entryFee: "1000000",
    maxPlayers: 2,
    rakeBps: 250,
    programId: "11111111111111111111111111111114",
    rpcUrl: "http://127.0.0.1:8899",
    decimals: 6,
    symbol: "WARC",
  } as WagerInfo;
}

interface Rendered {
  /** Prose the player reads. */
  text: string;
  /**
   * o-button labels. Set as PROPERTIES, so they never reach textContent --
   * reading them off the element is the only way to see them.
   */
  buttons: string[];
}

/** Renders the duel waiting room's body without mounting the modal shell. */
function waitingRoom(opts: {
  clients: number;
  startAt: number | null;
}): Rendered {
  const el = new HostLobbyModal();
  const m = el as unknown as Record<string, unknown>;
  m.duelPreset = true;
  m.wager = wagerInfo();
  m.lobbyStartAt = opts.startAt;
  m.serverTimeOffset = 0;
  m.clients = Array.from({ length: opts.clients }, (_, i) => ({
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

describe("[ARENA] duel waiting room", () => {
  it("says it is waiting for an opponent, not that a game is starting", () => {
    const { text, buttons } = waitingRoom({ clients: 1, startAt: null });

    expect(text).toContain("duel.waiting_opponent");
    expect(buttons).not.toContain("host_modal.start");
  });

  it("calls an expiring timer what it is: a cancel-and-refund deadline", () => {
    // The regression that produced the report. One staked seat and a timer
    // armed means the lobby is heading for cancellation, so "starting" is the
    // opposite of the truth.
    const { text, buttons } = waitingRoom({
      clients: 1,
      startAt: Date.now() + 272_000,
    });

    expect(text).toContain("duel.cancelling_in");
    expect(text).not.toContain("host_modal.starting_in");
    expect(buttons).not.toContain("host_modal.starting_in");
  });

  it("offers only cancel-and-refund while unfilled", () => {
    // Leaving is the action that actually works: it routes through end()'s
    // not-started branch, the single refund site. toggle_game_start_timer is
    // refused by the wager start-gate, and a disarm is instantly re-armed.
    for (const startAt of [null, Date.now() + 272_000]) {
      const { buttons } = waitingRoom({ clients: 1, startAt });
      expect(buttons).toEqual(["duel.cancel_and_refund"]);
    }
  });

  it("counts down to the start once both seats are staked, with no button", () => {
    // The server arms the countdown itself (maybeAutoStartFilledWager) and
    // starts the match, so there is nothing left for either player to press.
    // A cancel here would be re-armed on the next tick, which is exactly the
    // do-nothing button the unfilled case used to have.
    const { text, buttons } = waitingRoom({
      clients: 2,
      startAt: Date.now() + 5_000,
    });

    expect(text).toContain("duel.starting_in");
    expect(buttons).toEqual([]);
    expect(text).not.toContain("duel.waiting_opponent");
    expect(text).not.toContain("duel.cancel_and_refund");
  });

  it("says it is starting even before the server's countdown lands", () => {
    // One broadcast can separate the second stake from startsAt arriving.
    // Falling back to the unfilled copy there would tell a player who has
    // already paid that nobody has joined.
    const { text, buttons } = waitingRoom({ clients: 2, startAt: null });

    expect(text).toContain("duel.starting_soon");
    expect(buttons).toEqual([]);
    expect(text).not.toContain("duel.waiting_opponent");
  });

  it("still shows the stake and the pot, which is what was paid for", () => {
    const { text } = waitingRoom({ clients: 1, startAt: null });

    expect(text).toContain("1 WARC");
    expect(text).toContain("duel.your_stake");
  });
});
