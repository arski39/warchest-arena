// [ARENA] The menu wordmark, and the two rules it must not break.
//
// 1. **The name comes from SITE_NAME.** The root CLAUDE.md makes this the one
//    place the site's name lives, so a rename is that variable plus the logo
//    art. A literal in the component would silently make this the second place,
//    and "Warchest Arena" is still a placeholder.
//
// 2. **It is not a translated string.** A site name is a proper noun. ~40
//    Crowdin-managed locale files hardcode upstream's name and only en.json is
//    editable here, so routing the wordmark through translateText() would have
//    the fork calling itself OpenFront in every language but English -- the
//    AGPL §7 misrepresentation that AppShellBranding.test.ts already pins for
//    the <title>. Same rule, second surface.
//
// The face itself is deliberately NOT asserted on -- jsdom has no FontFace, so
// every run here is the fallback path by construction. That IS worth pinning,
// because it is also what a 404 or a decode failure produces in a browser, and
// a wordmark that throws or blanks in that case would be worse than a plain one.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";
import {
  resetDisplayFontForTests,
  type SiteNameplate,
} from "../../src/client/components/SiteNameplate";

// Imported once, at module scope. vi.resetModules() would re-run the
// @customElement decorator and the registry refuses a second "site-nameplate".
// ClientEnv.reset() is the seam that actually matters here -- it drops the
// memoised BOOTSTRAP_CONFIG so each test can supply a different SITE_NAME.

const BOOTSTRAP = {
  gameEnv: "dev",
  numWorkers: 1,
  turnstileSiteKey: "k",
  jwtAudience: "localhost",
  instanceId: "i",
  gitCommit: "c",
  arenaDevBypass: false,
  arenaStakeSymbol: "",
  arenaStakeMint: "",
  arenaRpcUrl: "",
};

function setBootstrap(extra: Record<string, unknown>) {
  (window as unknown as { BOOTSTRAP_CONFIG: unknown }).BOOTSTRAP_CONFIG = {
    ...BOOTSTRAP,
    ...extra,
  };
  ClientEnv.reset();
}

async function mount() {
  resetDisplayFontForTests();
  const el = document.createElement("site-nameplate") as SiteNameplate;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("the menu nameplate", () => {
  beforeEach(() => {
    ClientEnv.reset();
    setBootstrap({});
  });

  afterEach(() => {
    ClientEnv.reset();
    document.body.innerHTML = "";
    delete (window as unknown as { BOOTSTRAP_CONFIG?: unknown })
      .BOOTSTRAP_CONFIG;
  });

  it("renders the name the server was configured with", async () => {
    setBootstrap({ siteName: "Warchest Arena" });

    const el = await mount();
    expect(el.textContent).toContain("Warchest Arena");
  });

  it("renders a renamed deployment's name, with nothing hardcoded", async () => {
    setBootstrap({ siteName: "Some Other Name" });

    const el = await mount();
    // The point of the rule: SITE_NAME is the single source, so a rename needs
    // no code change. A literal in the component would fail exactly here.
    expect(el.textContent).toContain("Some Other Name");
    expect(el.textContent).not.toContain("Warchest");
  });

  it("does not route the name through the translation system", async () => {
    setBootstrap({ siteName: "Warchest Arena" });

    const el = await mount();
    // No data-i18n attribute anywhere in the nameplate. ~40 locale files
    // hardcode upstream's name and only en.json is editable here, so a
    // translated wordmark is an AGPL §7 problem, not a cosmetic one.
    expect(el.querySelector("[data-i18n]")).toBeNull();
    expect(el.innerHTML).not.toContain("data-i18n");
  });

  it("exposes the plain name to assistive tech, not the decorative glyphs", async () => {
    setBootstrap({ siteName: "Warchest Arena" });

    const el = await mount();
    const labelled = el.querySelector('[role="img"]');
    expect(labelled?.getAttribute("aria-label")).toBe("Warchest Arena");
  });

  it("still renders when the display font is absent", async () => {
    setBootstrap({ siteName: "Warchest Arena" });
    // jsdom has no FontFace, the same shape of failure as a 404 or a decode
    // error in a browser. Neither may throw, and neither may blank the wordmark.
    const el = await mount();

    expect(el.textContent).toContain("Warchest Arena");
    const heading = el.querySelector("h1");
    expect(heading).not.toBeNull();
    // A fallback stack, so the name is drawn in *something* rather than
    // inheriting a face that was never loaded.
    expect(heading?.getAttribute("style") ?? "").toMatch(/serif/);
  });

  it("falls back to the hostname rather than rendering an empty plate", async () => {
    setBootstrap({ siteName: "" });

    const el = await mount();
    // ServerEnv.siteName() falls back to DOMAIN; the client mirrors that with
    // the host, so a deployment that never set SITE_NAME still says something
    // true.
    expect(el.textContent?.trim()).toBe(window.location.hostname);
  });
});
