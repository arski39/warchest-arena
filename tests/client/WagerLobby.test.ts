// [ARENA] The stake prompt is the last thing a player sees before money
// moves, and until now nothing rendered it.
//
// The two things worth pinning are both about *what the numbers say*:
//
//   * amounts must render as whole tokens. The panel used to print raw base
//     units, so a lobby the host set to the 5 tier told the player "5000000" —
//     which is how someone stakes an amount they believe they checked.
//   * the mint must stay visible. ARENA_STAKE_SYMBOL is an operator string,
//     not on-chain metadata, so the ticker alone is an unverifiable claim.
//
// It also guards the light-DOM move: the component used to have a shadow root
// and a hand-written palette, which is exactly why it missed every design
// token. Querying it from the host element only works without that boundary.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WagerInfo } from "../../src/core/Schemas";

// The panel's buttons pull in the wallet stack, which wants a browser
// extension and @solana/web3.js. Nothing here clicks them.
vi.mock("../../src/client/arena/WalletProvider", () => ({
  connectWallet: vi.fn(),
  getConnectedWallet: () => null,
}));
vi.mock("../../src/client/arena/onchainJoin", () => ({
  joinMatchOnChain: vi.fn(),
}));
vi.mock("../../src/client/arena/walletAuth", () => ({
  signAuthMessage: vi.fn(),
}));
vi.mock("../../src/client/Auth", () => ({ getPlayToken: vi.fn() }));

const MINT = "CtVDnzfPa4TDGLv886X3FJkbzZz5LXt9RpLHWNMtsJLe";

function wagerInfo(overrides: Partial<WagerInfo> = {}): WagerInfo {
  return {
    matchPDA: "11111111111111111111111111111112",
    vault: "11111111111111111111111111111113",
    mint: MINT,
    entryFee: "5000000",
    maxPlayers: 2,
    rakeBps: 0,
    programId: "11111111111111111111111111111114",
    rpcUrl: "http://127.0.0.1:8899",
    decimals: 6,
    symbol: "ARENA",
    ...overrides,
  };
}

async function render(wager: WagerInfo) {
  await import("../../src/client/arena/WagerLobby");
  const el = document.createElement("arena-wager-lobby") as HTMLElement & {
    wager: WagerInfo | null;
    gameId: string;
  };
  el.wager = wager;
  el.gameId = "game1";
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

describe("[ARENA] wager stake prompt", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders into the light DOM", () => {
    // The whole reason the panel can use Tailwind and o-button at all.
    return render(wagerInfo()).then((el) => {
      expect(el.shadowRoot).toBeNull();
      expect(el.textContent).not.toBe("");
    });
  });

  it("shows whole tokens, never base units", async () => {
    const el = await render(wagerInfo());
    const text = el.textContent ?? "";
    expect(text).toContain("5 ARENA");
    expect(text).not.toContain("5000000");
  });

  it("leads with what the winner actually takes", async () => {
    // 2 players at 5 each, no rake.
    const el = await render(wagerInfo());
    expect(el.textContent).toContain("10 ARENA");
  });

  it("subtracts the rake from the headline figure", async () => {
    // 10 gross, 10% rake -> 9. Showing the gross pot would overstate the
    // prize on every deployment that takes a cut.
    const el = await render(wagerInfo({ rakeBps: 1000 }));
    expect(el.textContent).toContain("9 ARENA");
    expect(el.textContent).not.toContain("10 ARENA");
  });

  it("keeps the mint visible next to the symbol", async () => {
    const el = await render(wagerInfo());
    expect(el.textContent).toContain(MINT.slice(0, 6));
  });

  it("survives a mint with no symbol configured", async () => {
    const el = await render(wagerInfo({ symbol: "" }));
    const text = el.textContent ?? "";
    expect(text).toContain("10");
    expect(text).not.toContain("undefined");
  });

  it("handles a 0-decimal mint", async () => {
    const el = await render(
      wagerInfo({ decimals: 0, entryFee: "25", maxPlayers: 4 }),
    );
    expect(el.textContent).toContain("100 ARENA");
  });

  it("says what backing out costs, on the prompt itself", async () => {
    // Signing is the irreversible half — the stake is in the vault whatever
    // the browser does next — so the one screen that can still change a
    // player's mind is this one, not the waiting room behind it. Both halves
    // are asserted because they are two different moments: an unfilled lobby
    // refunds, a filled one forfeits.
    //
    // Keys, not English: translateText returns the key uninitialised, which is
    // how the rest of this suite reads translated markers.
    const el = await render(wagerInfo());

    expect(el.textContent).toContain("wager_lobby.refund_notice");
    expect(el.textContent).toContain("wager_lobby.forfeit_notice");
  });

  it("puts the disclaimer above the button that spends the money", async () => {
    // Below the button it is a disclaimer nobody reads before deciding, which
    // is the same as not having one. Position is the whole point of the
    // change, so it is what this asserts.
    const el = await render(wagerInfo());

    const notice = [...el.querySelectorAll("p")].find((p) =>
      (p.textContent ?? "").includes("wager_lobby.refund_notice"),
    );
    const button = el.querySelector("o-button");
    expect(notice).toBeDefined();
    expect(button).not.toBeNull();
    expect(
      notice!.compareDocumentPosition(button!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders nothing without a wager", async () => {
    await import("../../src/client/arena/WagerLobby");
    const el = document.createElement("arena-wager-lobby");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    expect((el.textContent ?? "").trim()).toBe("");
  });
});
