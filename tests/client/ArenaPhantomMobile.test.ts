// [ARENA] Reaching Phantom from a phone, which is not the same problem as
// reaching it from a desktop.
//
// Reported from the live site: tapping sign in on a phone did nothing. Phantom
// ships a browser EXTENSION on desktop and a standalone APP on mobile, so
// mobile Safari and Chrome inject no window.phantom at all -- and
// connectWallet() answered "install Phantom" to someone who had it installed.
// The app is simply not reachable from an ordinary mobile browser tab; the only
// way in is Phantom's own in-app browser, via a universal link.
//
// The link format is what this pins. A malformed one fails the way everything
// mobile fails: silently, on a device with no console.
import { afterEach, describe, expect, it, vi } from "vitest";
import { phantomBrowseLink } from "../../src/client/arena/WalletProvider";

const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
const IPAD_OS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/**
 * Drives the two things the decision reads: the UA and the injected provider.
 *
 * defineProperty rather than vi.spyOn: jsdom does not define maxTouchPoints or
 * a settable location at all, and spyOn refuses to stub a property that does
 * not exist.
 */
function browser(opts: {
  ua: string;
  touchPoints?: number;
  phantom?: boolean;
  href?: string;
}) {
  const stub = (obj: object, key: string, value: unknown) => {
    Object.defineProperty(obj, key, {
      value,
      configurable: true,
      writable: true,
    });
  };
  stub(navigator, "userAgent", opts.ua);
  stub(navigator, "maxTouchPoints", opts.touchPoints ?? 0);

  const w = window as unknown as { phantom?: unknown; solana?: unknown };
  if (opts.phantom) {
    w.phantom = { solana: { publicKey: null, isConnected: false } };
  } else {
    delete w.phantom;
    delete w.solana;
  }

  // Only the pieces the link is built from are read.
  stub(window, "location", {
    href: opts.href ?? "https://warchest-arena.com/",
    protocol: "https:",
    host: "warchest-arena.com",
  });
}

describe("[ARENA] reaching Phantom on mobile", () => {
  const realNavigator = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    "userAgent",
  );
  const realLocation = window.location;

  afterEach(() => {
    vi.restoreAllMocks();
    if (realNavigator) {
      Object.defineProperty(Navigator.prototype, "userAgent", realNavigator);
    }
    Object.defineProperty(window, "location", {
      value: realLocation,
      configurable: true,
      writable: true,
    });
    const w = window as unknown as { phantom?: unknown; solana?: unknown };
    delete w.phantom;
    delete w.solana;
  });

  it("offers no link on desktop, where the answer is the extension", () => {
    browser({ ua: DESKTOP });

    expect(phantomBrowseLink()).toBeNull();
  });

  it("offers no link when a provider is already injected", () => {
    // The in-app browser itself lands here. Offering to reopen Phantom from
    // inside Phantom would be a loop.
    browser({ ua: IPHONE, phantom: true });

    expect(phantomBrowseLink()).toBeNull();
  });

  it.each([
    ["iPhone", IPHONE, 0],
    ["Android", ANDROID, 0],
    // iPadOS 13+ reports itself as Macintosh; touch points are the only tell.
    ["iPadOS", IPAD_OS, 5],
  ])("offers the link on %s with no provider", (_label, ua, touchPoints) => {
    browser({ ua, touchPoints });

    expect(phantomBrowseLink()).toMatch(
      /^https:\/\/phantom\.app\/ul\/browse\//,
    );
  });

  it("does not mistake a Mac for an iPad", () => {
    // Same UA as iPadOS, no touch. Getting this wrong shows a desktop user a
    // link that only opens phantom.app's marketing page.
    browser({ ua: IPAD_OS, touchPoints: 0 });

    expect(phantomBrowseLink()).toBeNull();
  });

  it("encodes the target url and the referrer", () => {
    // Phantom requires both encoded. Unencoded, the lobby's own query string
    // terminates the deeplink's and the app opens the wrong page -- which on a
    // phone looks like nothing happening.
    browser({
      ua: IPHONE,
      href: "https://warchest-arena.com/w2/game/FU1Lg8sp?lobby&s=ok44u",
    });

    const link = phantomBrowseLink();
    expect(link).toBe(
      "https://phantom.app/ul/browse/" +
        encodeURIComponent(
          "https://warchest-arena.com/w2/game/FU1Lg8sp?lobby&s=ok44u",
        ) +
        "?ref=" +
        encodeURIComponent("https://warchest-arena.com"),
    );
    // Exactly one "?" outside the encoded payload: the deeplink's own.
    expect(link!.split("?")).toHaveLength(2);
  });

  it("returns to the same page, so a link opens where it was tapped", () => {
    browser({ ua: ANDROID, href: "https://warchest-arena.com/#modal=account" });

    expect(phantomBrowseLink()).toContain(
      encodeURIComponent("https://warchest-arena.com/#modal=account"),
    );
  });
});
