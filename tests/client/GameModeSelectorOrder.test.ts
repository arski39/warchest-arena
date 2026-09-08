// [ARENA] The order of the home page's modes, and the duel preset behind the
// primary one.
//
// Ordering here is plain DOM order in one Lit template with no `order-*`
// utilities and no config, which makes it both easy to change and easy to
// change back by accident — the whole feature is "1v1 is first and the public
// lobby grid is last", so it needs something asserting it.
//
// It also pins the invariant that made the reorder cheap: exactly ONE card
// carries the accent treatment, and it marks the primary mode. That used to be
// Solo. If a later change gives two cards the accent, the page no longer says
// which mode the site is for.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  getMapName: vi.fn((m: string) => m),
  getModifierLabels: vi.fn(() => []),
  renderDuration: vi.fn(() => "0:30"),
  calculateServerTimeOffset: vi.fn(() => 0),
  getSecondsUntilServerTimestamp: vi.fn(() => 30),
}));

// No WebSocket: connectedCallback would otherwise open the real public-lobby
// socket on mount.
vi.mock("../../src/client/LobbySocket", () => ({
  PublicLobbySocket: class {
    start() {}
    stop() {}
  },
}));

vi.mock("src/client/ClientEnv", () => ({
  ClientEnv: { gameCreationRate: () => 30_000 },
}));

vi.mock("../../src/client/TerrainMapFileLoader", () => ({
  terrainMapFileLoader: {
    getMapData: () => ({
      webpPath: "",
      manifest: async () => ({ map: { width: 2, height: 1 } }),
    }),
  },
}));

import { GameModeSelector } from "../../src/client/GameModeSelector";

// Constructed rather than createElement("game-mode-selector"): the import is
// erased if the class is only ever used as a type, and then @customElement
// never runs, createElement returns an inert HTMLElement, and every assertion
// here passes vacuously against an empty DOM.
function mount(): GameModeSelector {
  const el = new GameModeSelector();
  document.body.appendChild(el);
  return el;
}

/** Buttons in DOM order, labelled by the translation key they render. */
function actionLabels(el: GameModeSelector): string[] {
  return [...el.querySelectorAll("button")].map((b) =>
    (b.textContent ?? "").trim(),
  );
}

describe("[ARENA] home page mode order", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("puts 1v1 first", async () => {
    const el = mount();
    await el.updateComplete;

    expect(actionLabels(el)[0]).toBe("main.duel");
  });

  it("puts the public lobby grid last, below every mode button", async () => {
    const el = mount();
    await el.updateComplete;

    // lobbies is null until the socket delivers, so the grid slot renders its
    // spinner. Either way it is the lobby-grid branch, which is what must come
    // last — this is the half of the change that demotes multiplayer.
    const grid = el.querySelector(".animate-spin");
    expect(grid).not.toBeNull();

    const buttons = [...el.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(
        button.compareDocumentPosition(grid!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("gives the accent treatment to 1v1 and to nothing else", async () => {
    const el = mount();
    await el.updateComplete;

    const accented = [...el.querySelectorAll("button")].filter((b) =>
      b.className.includes("bg-malibu-blue"),
    );
    expect(accented).toHaveLength(1);
    expect((accented[0].textContent ?? "").trim()).toBe("main.duel");
  });

  it("still offers solo and the private-lobby actions", async () => {
    const el = mount();
    await el.updateComplete;

    expect(actionLabels(el)).toEqual([
      "main.duel",
      "main.solo",
      "main.create",
      "mode_selector.ranked_title",
      "main.join",
    ]);
  });

  it("opens the host lobby with the duel preset", async () => {
    // The behaviour, not just the label: a duel is an ordinary two-seat wagered
    // lobby, and `preset: "duel"` is what caps and locks the seat count. Losing
    // the argument would silently give a 16-seat escrow to a mode called 1v1.
    const open = vi.fn();
    const modal = document.createElement("host-lobby-modal");
    (modal as unknown as { open: unknown }).open = open;
    document.body.appendChild(modal);

    const el = mount();
    await el.updateComplete;
    el.querySelector("button")!.click();

    expect(open).toHaveBeenCalledWith({ preset: "duel" });
  });
});
