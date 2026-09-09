// [ARENA] The matchmaking decision: join an open duel at your tier, or become
// the one waiting.
//
// This is the whole of "1v1 is a matchmaking button, not a create-a-lobby
// button". Getting the filter wrong is not a visual bug — matching a lobby at
// the wrong tier would put a player into an escrow for an amount they did not
// choose, and matching a full one would send them to a lobby that can never
// admit them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicGameInfo, PublicGames } from "../../src/core/Schemas";

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
}));

vi.mock("../../src/client/ClientEnv", () => ({
  ClientEnv: { arenaStakeSymbol: () => "WARC" },
}));

import { DuelPanel } from "../../src/client/arena/DuelPanel";

/** A listed duel lobby as the master broadcasts it. 6 decimals, like the mint. */
function duelLobby(opts: {
  gameID: string;
  tier: number;
  numClients?: number;
  maxPlayers?: number;
}): PublicGameInfo {
  return {
    gameID: opts.gameID,
    numClients: opts.numClients ?? 1,
    publicGameType: "hosted",
    wager: {
      entryFee: String(BigInt(opts.tier) * 10n ** 6n),
      maxPlayers: opts.maxPlayers ?? 2,
      decimals: 6,
      rakeBps: 250,
      symbol: "WARC",
    },
  } as PublicGameInfo;
}

function lobbies(...hosted: PublicGameInfo[]): PublicGames {
  return { serverTime: Date.now(), games: { hosted } } as PublicGames;
}

describe("[ARENA] duel matchmaking", () => {
  let panel: DuelPanel;
  let joined: { gameID: string; source?: string }[];
  let hostOpened: Record<string, unknown>[];
  // Braces, not a concise body: the concise form returns push()'s number, and
  // the cast to EventListener then fails because the types do not overlap.
  const onJoin = (e: CustomEvent): void => {
    joined.push(e.detail);
  };

  beforeEach(async () => {
    document.body.innerHTML = "";
    joined = [];
    hostOpened = [];

    // The host lobby is the waiting room the create path hands off to.
    const host = document.createElement("host-lobby-modal");
    (host as unknown as { open: (a: Record<string, unknown>) => void }).open = (
      args,
    ) => hostOpened.push(args);
    document.body.appendChild(host);

    // Constructed, not createElement'd: an import used only in type positions
    // is erased, @customElement never runs, and every assertion below would
    // pass vacuously against an inert HTMLElement.
    panel = new DuelPanel();
    // close() is BaseModal's page-swap. Stubbed so these tests exercise the
    // matchmaking decision rather than the modal shell around it.
    (panel as unknown as { close: () => void }).close = () => {};
    document.body.appendChild(panel);
    await panel.updateComplete;

    document.addEventListener("join-lobby", onJoin as EventListener);
  });

  // Removed, not just re-created: document listeners outlive the element, so
  // leaving them attached makes every later dispatch record once per test that
  // has run so far.
  afterEach(() => {
    document.removeEventListener("join-lobby", onJoin as EventListener);
  });

  /** Feeds the panel a lobby list the way GameModeSelector's socket does. */
  function broadcast(games: PublicGames): void {
    document.dispatchEvent(
      new CustomEvent("public-lobbies-update", { detail: { payload: games } }),
    );
  }

  /** Picks a tier and presses Find, bypassing the DOM. */
  async function find(tier: number | null): Promise<void> {
    const p = panel as unknown as {
      tier: number | null;
      handleFind: () => Promise<void>;
    };
    p.tier = tier;
    await p.handleFind();
  }

  it("joins an open duel at the chosen tier", async () => {
    broadcast(lobbies(duelLobby({ gameID: "opendueL1", tier: 5 })));
    await find(5);

    // source "private" is what Main.resolveWagerJoin keys on to run the stake
    // gate. Any other source and the player joins a wagered lobby without
    // staking, which the server then refuses on the socket.
    expect(joined).toEqual([{ gameID: "opendueL1", source: "private" }]);
    expect(hostOpened).toEqual([]);
  });

  it("creates and advertises one when nobody is waiting", async () => {
    broadcast(lobbies());
    await find(25);

    expect(joined).toEqual([]);
    expect(hostOpened).toEqual([{ preset: "duel", tier: 25, list: true }]);
  });

  it("does not match a duel at a different tier", async () => {
    // The one that would take someone's money for an amount they did not pick.
    broadcast(lobbies(duelLobby({ gameID: "cheapduel", tier: 1 })));
    await find(25);

    expect(joined).toEqual([]);
    expect(hostOpened).toEqual([{ preset: "duel", tier: 25, list: true }]);
  });

  it("does not match a duel that is already full", async () => {
    // Two seats, two clients. Joining sends a player to a lobby that cannot
    // admit them and whose escrow is already closed to new stakes.
    broadcast(
      lobbies(duelLobby({ gameID: "fullduel1", tier: 5, numClients: 2 })),
    );
    await find(5);

    expect(joined).toEqual([]);
    expect(hostOpened).toHaveLength(1);
  });

  it("does not match a wagered lobby that is not a duel", async () => {
    // Same tier, but a 16-seat pot. Matching it would drop a player expecting a
    // 1v1 into a lobby that only starts when sixteen people have staked.
    broadcast(
      lobbies(duelLobby({ gameID: "bigpotlob", tier: 5, maxPlayers: 16 })),
    );
    await find(5);

    expect(joined).toEqual([]);
    expect(hostOpened).toHaveLength(1);
  });

  it("does nothing until a stake is chosen", async () => {
    broadcast(lobbies(duelLobby({ gameID: "opendueL1", tier: 5 })));
    await find(null);

    expect(joined).toEqual([]);
    expect(hostOpened).toEqual([]);
  });

  it("counts who is waiting at each stake, from the same data it matches on", async () => {
    // The count and the behaviour must come from one source: if the picker says
    // one player is waiting at 5, pressing Find must join them. Two independent
    // reads is how a "1 waiting" that matches nobody happens.
    broadcast(
      lobbies(
        duelLobby({ gameID: "waiting5a", tier: 5 }),
        duelLobby({ gameID: "waiting5b", tier: 5 }),
        duelLobby({ gameID: "waiting1a", tier: 1 }),
        // Started duels leave the list, and a 16-seat pot is not a duel.
        duelLobby({ gameID: "bigpotlob", tier: 5, maxPlayers: 16 }),
      ),
    );
    await panel.updateComplete;

    const p = panel as unknown as { waitingAt: (t: number) => number };
    expect(p.waitingAt(5)).toBe(2);
    expect(p.waitingAt(1)).toBe(1);
    expect(p.waitingAt(25)).toBe(0);
  });

  it("prefers joining over creating when both are possible", async () => {
    // Two players pressing Find at the same tier must converge rather than each
    // creating a lobby and waiting in it. Preferring an existing lobby is what
    // makes that self-heal.
    broadcast(
      lobbies(
        duelLobby({ gameID: "fullduel1", tier: 5, numClients: 2 }),
        duelLobby({ gameID: "opendueL1", tier: 5 }),
      ),
    );
    await find(5);

    expect(joined).toEqual([{ gameID: "opendueL1", source: "private" }]);
  });
});
