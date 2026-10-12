// [ARENA] The wallet picker: asked only when there is a choice, and never
// mistaken for a bound session.
//
// The test that matters most is the overlay-class one. `sessionIsBound()`
// reads `.arena-wager-overlay` as "a match signature is in flight", and
// `walletLogin()` refuses while it is true -- so a picker that borrowed the
// stake prompt's class would block the very sign-in it was opened for.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletChoice } from "../../src/client/arena/WalletProvider";

const connectWallet = vi.fn(async (name?: string) => ({
  publicKey: "addr",
  name: name ?? "default",
}));
let choices: WalletChoice[] = [];
let lastUsed: string | null = null;
let mobile = false;
const SITE_NAME = "Warchest Arena";

async function loadPicker() {
  vi.resetModules();
  vi.doMock("../../src/client/arena/WalletProvider", () => ({
    connectWallet,
    listWallets: () => choices,
    isMobileBrowser: () => mobile,
  }));
  vi.doMock("../../src/client/arena/walletSession", () => ({
    storedWalletName: () => lastUsed,
  }));
  vi.doMock("../../src/client/ClientEnv", () => ({
    ClientEnv: { siteName: () => SITE_NAME },
  }));
  return import("../../src/client/arena/walletPicker");
}

const PHANTOM: WalletChoice = { name: "Phantom", icon: "" };
const SOLFLARE: WalletChoice = {
  name: "Solflare",
  icon: "data:image/png;base64,iVBORw0KGgo=",
};

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".arena-wallet-picker-overlay");
}

/** Lets the picker mount, which happens after listWallets() resolves. */
async function opened(): Promise<HTMLElement> {
  await vi.waitFor(() => expect(overlay()).not.toBeNull());
  return overlay()!;
}

function row(name: string): HTMLButtonElement {
  return overlay()!.querySelector<HTMLButtonElement>(
    `button[data-wallet="${name}"]`,
  )!;
}

function suggestion(name: string): HTMLButtonElement | null {
  return overlay()!.querySelector<HTMLButtonElement>(
    `button[data-suggestion="${name}"]`,
  );
}

function action(name: "cancel" | "more"): HTMLButtonElement | null {
  return overlay()!.querySelector<HTMLButtonElement>(
    `button[data-action="${name}"]`,
  );
}

beforeEach(() => {
  connectWallet.mockClear();
  choices = [];
  lastUsed = null;
  mobile = false;
});

afterEach(() => {
  overlay()?.remove();
  vi.restoreAllMocks();
  vi.doUnmock("../../src/client/arena/WalletProvider");
  vi.doUnmock("../../src/client/arena/walletSession");
  vi.doUnmock("../../src/client/ClientEnv");
});

describe("connectPickedWallet", () => {
  it("asks nothing with a single wallet", async () => {
    choices = [PHANTOM];
    const { connectPickedWallet } = await loadPicker();
    await connectPickedWallet();
    expect(overlay()).toBeNull();
    expect(connectWallet).toHaveBeenCalledWith();
  });

  it("asks nothing with no wallet, leaving the error to connectWallet", async () => {
    connectWallet.mockRejectedValueOnce(new Error("no_wallet"));
    const { connectPickedWallet } = await loadPicker();
    await expect(connectPickedWallet()).rejects.toThrow("no_wallet");
    expect(overlay()).toBeNull();
  });

  it("connects the wallet the player picks", async () => {
    choices = [PHANTOM, SOLFLARE];
    const { connectPickedWallet } = await loadPicker();
    const result = connectPickedWallet();
    await opened();
    row("Solflare").click();
    await expect(result).resolves.toMatchObject({ name: "Solflare" });
    expect(connectWallet).toHaveBeenCalledWith("Solflare");
    expect(overlay()).toBeNull();
  });

  it("resolves null, connecting nothing, when dismissed", async () => {
    choices = [PHANTOM, SOLFLARE];
    const { connectPickedWallet } = await loadPicker();

    const byCancel = connectPickedWallet();
    const cancel = [...(await opened()).querySelectorAll("button")].find(
      (b) => b.dataset.wallet === undefined,
    )!;
    cancel.click();
    await expect(byCancel).resolves.toBeNull();

    const byEscape = connectPickedWallet();
    await opened();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(byEscape).resolves.toBeNull();

    const byBackdrop = connectPickedWallet();
    (await opened()).click();
    await expect(byBackdrop).resolves.toBeNull();

    expect(connectWallet).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
  });
});

describe("the picker overlay", () => {
  it("is not a bound session, so sign-in stays allowed while it is open", async () => {
    choices = [PHANTOM, SOLFLARE];
    const { connectPickedWallet } = await loadPicker();
    const { sessionIsBound } =
      await import("../../src/client/arena/sessionBinding");
    const result = connectPickedWallet();
    const el = await opened();
    expect(el.classList.contains("arena-wager-overlay")).toBe(false);
    expect(sessionIsBound()).toBe(false);
    row("Phantom").click();
    await result;
  });

  it("puts the last-used wallet first and marks it", async () => {
    choices = [PHANTOM, SOLFLARE];
    lastUsed = "Solflare";
    const { connectPickedWallet } = await loadPicker();
    const result = connectPickedWallet();
    const el = await opened();
    const names = [...el.querySelectorAll<HTMLElement>("[data-wallet]")].map(
      (b) => b.dataset.wallet,
    );
    expect(names).toEqual(["Solflare", "Phantom"]);
    expect(row("Solflare").textContent).toContain("wallet_picker.last_used");
    expect(row("Phantom").textContent).not.toContain("wallet_picker.last_used");
    row("Phantom").click();
    await result;
  });

  it("renders an extension-supplied name as text, never as markup", async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    choices = [PHANTOM, { name: hostile, icon: "" }];
    const { connectPickedWallet } = await loadPicker();
    const result = connectPickedWallet();
    const el = await opened();
    expect(el.querySelector("img[onerror]")).toBeNull();
    expect(el.textContent).toContain(hostile);
    row("Phantom").click();
    await result;
  });

  it("shows an icon only when there is one", async () => {
    choices = [PHANTOM, SOLFLARE];
    const { connectPickedWallet } = await loadPicker();
    const result = connectPickedWallet();
    await opened();
    expect(row("Solflare").querySelector("img")?.getAttribute("src")).toBe(
      SOLFLARE.icon,
    );
    expect(row("Phantom").querySelector("img")).toBeNull();
    row("Phantom").click();
    await result;
  });

  it("never offers a wallet to go and get from the stake prompt", async () => {
    // The player is in a lobby. A link into a wallet's in-app browser would
    // reopen it there as a second client -- see phantomBrowseLink.
    choices = [PHANTOM, SOLFLARE];
    mobile = true;
    const { connectPickedWallet } = await loadPicker();
    const result = connectPickedWallet();
    const el = await opened();
    expect(el.querySelector("[data-suggestion]")).toBeNull();
    expect(action("more")).toBeNull();
    row("Phantom").click();
    await result;
  });
});

// [ARENA] The sign-in picker: the first thing a new player sees of the wallet
// side, so unlike the stake prompt it always asks, says where they are, and
// shows where to get a wallet they do not have.
describe("connectForSignIn", () => {
  /** jsdom cannot navigate; stand in a location whose assign() is observable. */
  function stubLocation(href = "https://warchest-arena.com/") {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href,
        protocol: "https:",
        host: "warchest-arena.com",
        hostname: "warchest-arena.com",
        assign,
      },
    });
    return assign;
  }

  const realLocation = window.location;
  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: realLocation,
    });
  });

  it("asks even with a single wallet, under the site's own name", async () => {
    choices = [PHANTOM];
    const { connectForSignIn } = await loadPicker();
    const result = connectForSignIn();
    const el = await opened();

    // SITE_NAME as data, never a translation key (the AGPL §7 rule the
    // nameplate follows): the test translator echoes keys, so a translated
    // title would read "wallet_picker.…" here.
    expect(el.querySelector("#arena-wallet-picker-title")?.textContent).toBe(
      SITE_NAME,
    );
    expect(row("Phantom").textContent).toContain("wallet_picker.detected");

    row("Phantom").click();
    await expect(result).resolves.toMatchObject({ name: "Phantom" });
    expect(connectWallet).toHaveBeenCalledWith("Phantom");
  });

  it("keeps wallets to install one click away when one is already there", async () => {
    choices = [PHANTOM];
    const { connectForSignIn } = await loadPicker();
    const result = connectForSignIn();
    await opened();

    // Phantom is detected, so it is not offered for install as well.
    expect(suggestion("Phantom")).toBeNull();
    expect(suggestion("Solflare")?.hidden).toBe(true);
    expect(action("more")?.getAttribute("aria-expanded")).toBe("false");

    action("more")!.click();
    expect(suggestion("Solflare")?.hidden).toBe(false);
    expect(suggestion("Backpack")?.hidden).toBe(false);
    expect(action("more")?.getAttribute("aria-expanded")).toBe("true");

    row("Phantom").click();
    await result;
  });

  it("on desktop with no wallet, links the install pages and stays open", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { connectForSignIn } = await loadPicker();
    const result = connectForSignIn();
    const el = await opened();

    // Nothing installed: the suggestions are the whole answer, so not folded.
    expect(action("more")).toBeNull();
    expect(suggestion("Phantom")?.hidden).toBe(false);
    expect(suggestion("Phantom")?.textContent).toContain(
      "wallet_picker.install",
    );
    expect(el.textContent).toContain("wallet_picker.reload_hint");

    suggestion("Phantom")!.click();
    expect(open).toHaveBeenCalledWith(
      "https://phantom.com/download",
      "_blank",
      "noopener,noreferrer",
    );
    // Installing happens in another tab; the picker waits for them.
    expect(overlay()).not.toBeNull();

    action("cancel")!.click();
    await expect(result).resolves.toBeNull();
    expect(connectWallet).not.toHaveBeenCalled();
  });

  it("on a phone, hands this page to the wallet's in-app browser", async () => {
    mobile = true;
    const assign = stubLocation("https://warchest-arena.com/#modal=account");
    const { connectForSignIn } = await loadPicker();
    const result = connectForSignIn();
    await opened();

    expect(suggestion("Solflare")?.textContent).toContain(
      "wallet_picker.open_app",
    );
    // No documented browse link, so not offered: installing an app does not
    // help the tab they are in.
    expect(suggestion("Backpack")).toBeNull();

    suggestion("Solflare")!.click();
    expect(assign).toHaveBeenCalledWith(
      "https://solflare.com/ul/v1/browse/" +
        encodeURIComponent("https://warchest-arena.com/#modal=account") +
        "?ref=" +
        encodeURIComponent("https://warchest-arena.com"),
    );
    // The page is leaving; sign-in reports it as a change of mind.
    await expect(result).resolves.toBeNull();
    expect(connectWallet).not.toHaveBeenCalled();
  });
});

describe("suggestWallets", () => {
  it("offers what is not installed, in the order the directory lists", async () => {
    const { suggestWallets } =
      await import("../../src/client/arena/walletDirectory");
    expect(
      suggestWallets(
        ["Solflare"],
        false,
        "https://x.test/",
        "https://x.test",
      ).map((s) => s.name),
    ).toEqual(["Phantom", "MetaMask", "Trust", "Backpack"]);
  });

  it("treats 'Trust Wallet' and 'Trust' as the same wallet", async () => {
    // Trust's adapter says "Trust"; a Wallet Standard registration may say
    // "Trust Wallet". An installed Trust must not also be offered for install.
    const { suggestWallets } =
      await import("../../src/client/arena/walletDirectory");
    const names = suggestWallets(
      ["Trust Wallet", "metamask"],
      false,
      "https://x.test/",
      "https://x.test",
    ).map((s) => s.name);
    expect(names).not.toContain("Trust");
    expect(names).not.toContain("MetaMask");
  });

  it("builds MetaMask's and Trust's mobile links in their documented shapes", async () => {
    const { suggestWallets } =
      await import("../../src/client/arena/walletDirectory");
    const byName = new Map(
      suggestWallets(
        [],
        true,
        "https://warchest-arena.com/play?x=1#modal=account",
        "https://warchest-arena.com",
      ).map((s) => [s.name, s.action]),
    );
    // link.metamask.io/dapp/{dappUrl}: bare host and path, as its one example.
    expect(byName.get("MetaMask")).toEqual({
      kind: "open",
      url: "https://link.metamask.io/dapp/warchest-arena.com/play?x=1",
    });
    // open_url?coin_id=&url=, with Solana's SLIP-44 index.
    expect(byName.get("Trust")).toEqual({
      kind: "open",
      url:
        "https://link.trustwallet.com/open_url?coin_id=501&url=" +
        encodeURIComponent("https://warchest-arena.com/play?x=1#modal=account"),
    });
  });

  it("uses Phantom's documented link shape on mobile", async () => {
    const { suggestWallets } =
      await import("../../src/client/arena/walletDirectory");
    const [phantom] = suggestWallets(
      [],
      true,
      "https://x.test/game?a=1",
      "https://x.test",
    );
    expect(phantom.action).toEqual({
      kind: "open",
      url:
        "https://phantom.app/ul/browse/" +
        encodeURIComponent("https://x.test/game?a=1") +
        "?ref=" +
        encodeURIComponent("https://x.test"),
    });
  });
});
