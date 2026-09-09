// [ARENA] Which pages the nav offers, and which it deliberately does not.
//
// Both nav bars are hand-written Lit templates with no config and no ordering
// utilities, so an entry is removed -- or put back -- by editing plain DOM
// order. That is the same shape as the home page's mode list, which got
// GameModeSelectorOrder.test.ts for the same reason: easy to change, and just
// as easy to change back by accident.
//
// Two entries are absent on purpose and both would be *restored* by an
// upstream merge, since these files are merge targets:
//
//   * page-item-store -- the storefront is gone. This deployment sells
//     nothing: /cosmetics.json serves an empty catalogue and every purchase
//     endpoint 404s.
//   * page-clan -- all 18 /clans* endpoints live in upstream's closed API.
//     The modal's no-args path reads /users/@me's deliberate `user: {}` as
//     "not signed in", toasts, closes itself and redirects to the account
//     page. ClanModal and ClanApi are untouched and still reachable at
//     #modal=clan; only the button is gone.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  getGamesPlayed: vi.fn(() => 0),
}));

vi.mock("../../src/core/AssetUrls", () => ({
  assetUrl: vi.fn((p: string) => p),
}));

import { DesktopNavBar } from "../../src/client/components/DesktopNavBar";
import { MobileNavBar } from "../../src/client/components/MobileNavBar";

// Constructed, not createElement'd: an import used only in type positions is
// erased, @customElement never runs, and every assertion below would pass
// vacuously against an inert HTMLElement.
async function mount<T extends DesktopNavBar | MobileNavBar>(
  el: T,
): Promise<T> {
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

/** Every page the bar links to, in DOM order. */
function pages(el: HTMLElement): string[] {
  return [...el.querySelectorAll("[data-page]")].map(
    (e) => (e as HTMLElement).dataset.page ?? "",
  );
}

describe("[ARENA] nav bar entries", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("lists the desktop entries in order, with no store and no clans", async () => {
    const el = await mount(new DesktopNavBar());

    expect(pages(el)).toEqual([
      "page-play",
      "page-news",
      "page-settings",
      "page-leaderboard",
      "page-help",
      "page-account",
    ]);
  });

  it("lists the mobile entries in order, with no store and no clans", async () => {
    // Asserted separately because the two templates are independent copies --
    // removing an entry from one and not the other is the likely half-fix.
    const el = await mount(new MobileNavBar());

    expect(pages(el)).toEqual([
      "page-play",
      "page-news",
      "page-leaderboard",
      "page-settings",
      "page-account",
      "page-help",
    ]);
  });

  it("offers no route to a page that no longer exists", async () => {
    // showPage() is generic: it hides the play page, then getElementById's the
    // target and does nothing if it is null. So a surviving store link would
    // not be a harmless no-op -- it would blank the screen.
    for (const bar of [new DesktopNavBar(), new MobileNavBar()]) {
      const el = await mount(bar);
      expect(pages(el)).not.toContain("page-item-store");
      expect(pages(el)).not.toContain("page-clan");
      document.body.innerHTML = "";
    }
  });

  it("shows the help dot now that no store dot outranks it", async () => {
    // The dot chain was News > Store > Help. The store dot fired on any
    // catalogue change, and on a fresh browser that was always -- so it
    // suppressed the help dot for essentially every new player, pointing at a
    // storefront that could not sell anything. Dropping it from the chain is
    // what restores the dot for the audience it was written for.
    const el = await mount(new DesktopNavBar());

    expect(el.querySelector(".bg-yellow-400")).not.toBeNull();
  });
});
