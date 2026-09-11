// [ARENA] [K] — a filled duel used to start on the WRONG GameConfig.
//
// The duel preset picks the map, the bot count, the match clock and
// maxPlayers: 2 when the modal opens, and deliberately does not push them
// there: putGameConfig() travels over the eventBus, which does not exist until
// the host's lobby connection is up. The deferral was justified in a comment —
// "toggleGameStartTimer() awaits putGameConfig() before starting" — and that
// justification stopped being true the moment a filled wagered lobby began
// starting ITSELF.
//
// maybeAutoStartFilledWager() arms the countdown server-side and asks the
// client for nothing. So toggleGameStartTimer() never runs, and for an
// auto-started duel putGameConfig() never ran AT ALL: the match began on
// whatever GameConfig the server happened to be holding. Not the duel map, not
// the duel bot count, not the match clock, not two seats. A duel host
// configures nothing, so none of the other ~40 putGameConfig() call sites
// could accidentally save it — both players paid for a duel and got a generic
// game.
//
// The general rule, which outlives this instance: anything that makes the
// SERVER start a lobby on its own must first ensure the config it will start
// on is the one the lobby was advertised with.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", async (orig) => {
  const actual = await orig<typeof import("../../src/client/Utils")>();
  return { ...actual, translateText: (key: string) => key };
});

// putGameConfig() builds the shareable lobby URL before it dispatches, and
// that reads BOOTSTRAP_CONFIG, which no test page has.
vi.mock("../../src/client/ClientEnv", () => ({
  ClientEnv: {
    workerPath: () => "w0",
    numWorkers: () => 1,
    arenaStakeSymbol: () => "WARC",
    arenaStakeMint: () => "CtVDnzfPa4TDGLv886X3FJkbzZz5LXt9RpLHWNMtsJLe",
  },
}));

import { HostLobbyModal } from "../../src/client/HostLobbyModal";
import { randomDuelMap } from "../../src/core/arena/duelSettings";

interface Pushed {
  gameMap?: unknown;
  maxPlayers?: unknown;
  bots?: unknown;
}

/**
 * A host lobby with the duel preset applied, wired to collect what it would
 * send the server. Returns a function that feeds it a lobby_info, which is the
 * first proof the connection exists and therefore the first moment a config
 * CAN be sent.
 */
function duelHost(): {
  el: HostLobbyModal;
  pushes: Pushed[];
  lobbyInfo: (gameID: string) => Promise<void>;
} {
  const el = new HostLobbyModal();
  const m = el as unknown as Record<string, unknown>;
  m.duelPreset = true;
  m.lobbyId = "duelgame";
  // The preset's own choices, as onOpen() sets them.
  m.useRandomMap = true;
  m.selectedMap = randomDuelMap();
  m.bots = 4;
  m.wagerMaxPlayers = 2;

  const pushes: Pushed[] = [];
  el.addEventListener("update-game-config", (e) => {
    pushes.push((e as CustomEvent).detail.config as Pushed);
  });
  // Deliberately not appended to the document: mounting drags in the modal
  // shell's IntersectionObserver, and the event is dispatched on the element
  // itself. What is under test is what it sends, not how it renders.

  return {
    el,
    pushes,
    // putGameConfig() awaits the shareable URL before dispatching, so the push
    // lands a microtask later than the lobby_info that triggered it.
    lobbyInfo: async (gameID: string) => {
      (m.handleLobbyInfo as (e: unknown) => void)({
        lobby: { gameID, clients: [] },
        myClientID: "me",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("[ARENA] the duel preset reaches the server", () => {
  it("pushes its config as soon as the lobby connection exists", async () => {
    const { pushes, lobbyInfo } = duelHost();
    expect(pushes).toHaveLength(0);

    await lobbyInfo("duelgame");

    // The whole of [K]: without this the server starts the match on its own
    // defaults, because nothing else on a duel screen ever pushes.
    expect(pushes).toHaveLength(1);
    expect(pushes[0].maxPlayers).toBe(2);
    expect(pushes[0].gameMap).toBeDefined();
    expect(pushes[0].bots).toBe(4);
  });

  it("pushes once, not on every lobby update", async () => {
    // lobby_info arrives continuously. Re-pushing on each would rewrite the
    // lobby URL every tick, since putGameConfig() regenerates it.
    const { pushes, lobbyInfo } = duelHost();
    await lobbyInfo("duelgame");
    await lobbyInfo("duelgame");
    await lobbyInfo("duelgame");

    expect(pushes).toHaveLength(1);
  });

  it("ignores lobby info for a different lobby", async () => {
    const { pushes, lobbyInfo } = duelHost();
    await lobbyInfo("someoneelse");

    expect(pushes).toHaveLength(0);
  });

  it("leaves an ordinary host lobby alone", async () => {
    // Scoped to the duel preset deliberately. Every other host lobby has a
    // settings screen whose first interaction pushes, and pushing local
    // defaults unasked would clobber the real config of a lobby reopened
    // through attachToExistingLobby().
    const { el, pushes, lobbyInfo } = duelHost();
    (el as unknown as Record<string, unknown>).duelPreset = false;
    await lobbyInfo("duelgame");

    expect(pushes).toHaveLength(0);
  });
});
