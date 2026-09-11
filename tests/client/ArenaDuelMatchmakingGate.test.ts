// [ARENA] A duel must not stake into a lobby nobody can find.
//
// `DuelPanel` matches players by looking for an open duel in the PUBLIC lobby
// list, so a duel only pairs anyone if it can be listed. When
// ARENA_PUBLIC_WAGER_LOBBIES is off -- or its replay probe failed -- a wagered
// lobby may not be listed at all (`listingRefusedForWager`), and every press of
// Find therefore created a lobby no other player could ever discover, with the
// stake already in escrow.
//
// That happened on the live site: two 1-WARC escrows created three minutes
// apart, neither able to see the other, both waiting on the sweeper to hand
// the tokens back hours later.
//
// The two halves of the gate are deliberately a pair, so the stake would be
// refused anyway -- `wagerRefusedForVisibility` mirrors
// `listingRefusedForWager`. The only thing the order changes is whether the
// player learns about it before or after their tokens move.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", async (orig) => {
  const actual = await orig<typeof import("../../src/client/Utils")>();
  return { ...actual, translateText: (key: string) => key };
});

vi.mock("../../src/client/ClientEnv", () => ({
  ClientEnv: {
    workerPath: () => "w0",
    numWorkers: () => 1,
    arenaStakeSymbol: () => "WARC",
  },
}));

const calls: string[] = [];
let publicLobbies = true;
let listingOk = true;

vi.mock("../../src/client/Api", () => ({
  createLobby: vi.fn(),
  getUserMe: vi.fn(async () => false),
  fetchLobbyWager: vi.fn(async () => {
    calls.push("fetchLobbyWager");
    return { available: true, publicLobbies, wager: null, options: null };
  }),
  setLobbyWager: vi.fn(async () => {
    calls.push("setLobbyWager");
    return {
      ok: true,
      wager: {
        matchPDA: "11111111111111111111111111111112",
        entryFee: "1000000",
        maxPlayers: 2,
        decimals: 6,
        symbol: "WARC",
      },
    };
  }),
  setLobbyListed: vi.fn(async () => {
    calls.push("setLobbyListed");
    return { ok: listingOk };
  }),
}));

import { HostLobbyModal } from "../../src/client/HostLobbyModal";

async function attachDuel(): Promise<{ error: unknown; calls: string[] }> {
  calls.length = 0;
  const el = new HostLobbyModal();
  const m = el as unknown as Record<string, unknown>;
  m.duelPreset = true;
  m.duelShouldList = true;
  m.lobbyId = "duelgame";
  await (m.attachDuelWager as (t: number) => Promise<void>)(1);
  return { error: m.wagerError, calls: [...calls] };
}

describe("[ARENA] a duel checks it can be matched before it takes money", () => {
  it("creates no escrow when wagered lobbies cannot be listed", async () => {
    publicLobbies = false;

    const { error, calls: seen } = await attachDuel();

    // The whole point: the tokens never move.
    expect(seen).not.toContain("setLobbyWager");
    expect(seen).toEqual(["fetchLobbyWager"]);
    // And the player is told why, rather than being left waiting for an
    // opponent who cannot see them.
    expect(error).toBe("duel.error_matchmaking_off");
  });

  it("stakes and lists when the server can advertise it", async () => {
    publicLobbies = true;
    listingOk = true;

    const { error, calls: seen } = await attachDuel();

    expect(seen).toEqual([
      "fetchLobbyWager",
      "setLobbyWager",
      "setLobbyListed",
    ]);
    expect(error).toBeNull();
  });

  it("still reports a listing that fails for some other reason", async () => {
    // The gate says yes but the listing is refused anyway (a join whitelist,
    // the cluster-wide cap). The escrow exists by then, so this keeps the
    // original message: the lobby is real and its link still works.
    publicLobbies = true;
    listingOk = false;

    const { error } = await attachDuel();

    expect(error).toBe("duel.error_not_listed");
  });
});
