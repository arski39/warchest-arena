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

    // [ARENA] No Ranked: its queue is upstream's closed API and 404s here, so
    // the button never worked. The modal and Matchmaking.ts are untouched and
    // the page is still reachable at #modal=ranked.
    expect(actionLabels(el)).toEqual([
      "main.duel",
      "main.solo",
      "main.create",
      "main.join",
    ]);
  });

  it("opens the duel panel, not the host lobby", async () => {
    // 1v1 is matchmaking, not lobby creation: it opens the tier picker, which
    // then either joins an open duel at that stake or creates one. Wiring it
    // straight to the host lobby — as it briefly was — makes the site's primary
    // mode a create-and-share-a-link button, which is not a mode.
    const openDuel = vi.fn();
    const openHost = vi.fn();
    const duel = document.createElement("arena-duel-panel");
    (duel as unknown as { open: unknown }).open = openDuel;
    document.body.appendChild(duel);
    const host = document.createElement("host-lobby-modal");
    (host as unknown as { open: unknown }).open = openHost;
    document.body.appendChild(host);

    const el = mount();
    await el.updateComplete;
    el.querySelector("button")!.click();

    expect(openDuel).toHaveBeenCalledTimes(1);
    expect(openHost).not.toHaveBeenCalled();
  });
});

// [ARENA] A hover effect must fit in the gutter, because the scroller clips it.
//
// `MainLayout`'s scrolling div is `overflow-y-auto overflow-x-hidden`, so
// whatever a card's hover draws outside itself is cut at that box's edge. The
// room available is `#page-play`'s `lg:px-4` — 16px.
//
// A uniform `hover:scale-105` on the FULL-WIDTH Solo card (~724px at the
// desktop max width) pushes each edge ~18px out, past the 16px gutter: the
// hover ring's left and right sides were clipped away and the glow never
// showed, so the card appeared to grow a top and bottom border and nothing
// else. Create and Join hid the same bug — they sit in a 2-column grid, so at
// ~354px each the same scale only reached ~8.8px and stayed inside.
//
// jsdom has no layout, so this cannot measure. It pins the class instead,
// which is the thing that regresses: a uniform scale on a card whose width is
// set by the page is the bug, and `scale-105` is how it gets written.
describe("[ARENA] home page hover effects survive the scroller's clip", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("gives no action card a uniform hover scale", async () => {
    const el = mount();
    await el.updateComplete;

    const buttons = [...el.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.className).not.toContain("hover:scale-105");
    }
  });

  it("scales the action cards on Y and only slightly on X", async () => {
    const el = mount();
    await el.updateComplete;

    // The four mode buttons, as opposed to the lobby-grid cards below them,
    // which are half-width and have their own (already safe) treatment.
    const cards = [...el.querySelectorAll("button")].filter((b) =>
      b.className.includes("hover:scale-y-105"),
    );
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card.className).toContain("hover:scale-x-[1.01]");
    }
  });

  it("keeps the hover ring on the secondary cards", async () => {
    // The glow is the highlight the clip was eating. Losing it while fixing
    // the clip would be fixing the symptom by deleting the feature.
    const el = mount();
    await el.updateComplete;

    const glowing = [...el.querySelectorAll("button")].filter((b) =>
      b.className.includes("--shadow-action-card-hover"),
    );
    expect(glowing.map((b) => (b.textContent ?? "").trim())).toEqual([
      "main.solo",
      "main.create",
      "main.join",
    ]);
  });
});
