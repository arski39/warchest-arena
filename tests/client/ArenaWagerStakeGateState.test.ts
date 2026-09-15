// [ARENA] The stake prompt must not offer a payment the program will refuse.
//
// Seen live on warchest-arena.com. The panel showed JOIN & STAKE on an escrow
// that was already `InProgress`; Phantom then said "Failed to simulate the
// results of this request", and the panel printed the whole simulation log
// ending in `custom program error: 0x1771` -- AnchorError NotOpen, "Match is
// not open for joining". Every piece of that was the program working: it pins
// `match_account.status == Open`. What was wrong was asking at all.
//
// The case that matters most is the reload. A player who staked and then
// refreshed comes back through the gate, and by then the escrow is full
// *because of their own stake* -- so they were being asked to pay a second
// time for a seat they already owned, with a transaction that could not
// succeed. They now skip straight through: membership in `players[]` is
// payment, the same fact the server's verifyOnchainMembership reads.
//
// The third state is the one that must NOT close the gate. readEscrowState
// answers null when the RPC is unreachable, and this runs against the shared
// keyless endpoint -- so unknown has to keep offering the stake and let the
// attempt be the answer, or a throttled read strands a player who can pay.

// translateText is unwired here and echoes its key, so the assertions below
// name `wager_lobby.*` keys. That is the stabler assertion in any case: a copy
// edit to en.json should not break a test about which state the panel is in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatchStatus } from "../../src/core/arena/arenaProgram";
import type { WagerInfo } from "../../src/core/Schemas";

const WALLET = "5miqxq62Qs3Ruc7FpyEYQuz8QWEa3Dmh9p18z7y9VdZM";

const joinMatchOnChain = vi.fn();
const readEscrowState = vi.fn();
const signAuthMessage = vi.fn();

vi.mock("../../src/client/arena/WalletProvider", () => ({
  connectWallet: vi.fn(),
  getConnectedWallet: () => ({ publicKey: WALLET }),
  phantomBrowseLink: () => null,
}));
vi.mock("../../src/client/arena/onchainJoin", () => ({
  joinMatchOnChain: (...a: unknown[]) => joinMatchOnChain(...a),
  readEscrowState: (...a: unknown[]) => readEscrowState(...a),
}));
vi.mock("../../src/client/arena/walletAuth", () => ({
  signAuthMessage: (...a: unknown[]) => signAuthMessage(...a),
}));
vi.mock("../../src/client/Auth", () => ({ getPlayToken: async () => "tok" }));

function wagerInfo(): WagerInfo {
  return {
    matchPDA: "11111111111111111111111111111112",
    vault: "11111111111111111111111111111113",
    mint: "CtVDnzfPa4TDGLv886X3FJkbzZz5LXt9RpLHWNMtsJLe",
    entryFee: "1000000",
    maxPlayers: 2,
    rakeBps: 250,
    programId: "4CGRLB5WJ4LK4nqwhzN5uhU78cakuHzG5wfrUZrQ2G64",
    rpcUrl: "http://127.0.0.1:8899",
    decimals: 6,
    symbol: "WARC",
  };
}

async function mount() {
  await import("../../src/client/arena/WagerLobby");
  const el = document.createElement("arena-wager-lobby") as HTMLElement & {
    wager: WagerInfo | null;
    gameId: string;
    updateComplete: Promise<unknown>;
  };
  el.wager = wagerInfo();
  el.gameId = "game1";
  document.body.appendChild(el);
  await el.updateComplete;
  // connectedCallback kicks off the escrow read without awaiting it.
  await Promise.resolve();
  await Promise.resolve();
  await el.updateComplete;
  return el;
}

/** The primary action button, or null when the panel is not offering one. */
function stakeButton(el: HTMLElement): HTMLElement | null {
  return el.querySelector('o-button[variant="primary"]');
}

function buttonTitle(el: HTMLElement): string {
  const b = stakeButton(el) as (HTMLElement & { title?: string }) | null;
  return b?.title ?? "";
}

describe("the stake prompt against live escrow state", () => {
  beforeEach(() => {
    joinMatchOnChain.mockReset().mockResolvedValue("txsig");
    readEscrowState.mockReset();
    signAuthMessage
      .mockReset()
      .mockResolvedValue({ walletAddress: WALLET, walletSig: "sig" });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("offers the stake while the escrow is Open", async () => {
    readEscrowState.mockResolvedValue({
      status: MatchStatus.Open,
      alreadyStaked: false,
      playerCount: 1,
      maxPlayers: 2,
    });

    const el = await mount();
    expect(stakeButton(el)).not.toBeNull();
    expect(el.textContent).not.toContain("wager_lobby.match_closed");
  });

  it("withdraws the stake button once the escrow is full", async () => {
    readEscrowState.mockResolvedValue({
      status: MatchStatus.InProgress,
      alreadyStaked: false,
      playerCount: 2,
      maxPlayers: 2,
    });

    const el = await mount();
    // 0x1771 territory. Offering the button here is what produced the wallet's
    // "failed to simulate" and the raw AnchorError dump.
    expect(stakeButton(el)).toBeNull();
    expect(el.textContent).toContain("wager_lobby.match_closed");
  });

  it("keeps offering the stake when the escrow cannot be read", async () => {
    readEscrowState.mockResolvedValue(null);

    const el = await mount();
    // Unknown is not closed. A 429 from the shared public endpoint must not
    // lock out a player who can pay.
    expect(stakeButton(el)).not.toBeNull();
  });

  it("does not charge a wallet that already staked, and still signs", async () => {
    readEscrowState.mockResolvedValue({
      status: MatchStatus.InProgress,
      alreadyStaked: true,
      playerCount: 2,
      maxPlayers: 2,
    });

    const el = await mount();
    const joined = new Promise<CustomEvent>((resolve) =>
      el.addEventListener("arena-wager-joined", (e) =>
        resolve(e as CustomEvent),
      ),
    );
    stakeButton(el)?.dispatchEvent(new Event("click"));
    const detail = (await joined).detail;

    // No second payment...
    expect(joinMatchOnChain).not.toHaveBeenCalled();
    // ...but the session still has to prove the wallet is this session's, and
    // the signature is bound to the jti, so it cannot be reused from before.
    expect(signAuthMessage).toHaveBeenCalledOnce();
    expect(detail.walletAddress).toBe(WALLET);
    expect(detail.onchainTxSig).toBeUndefined();
  });

  it("tells a player who already staked that their seat is paid for", async () => {
    readEscrowState.mockResolvedValue({
      status: MatchStatus.InProgress,
      alreadyStaked: true,
      playerCount: 2,
      maxPlayers: 2,
    });

    const el = await mount();
    expect(el.textContent).toContain("wager_lobby.already_staked");
    expect(buttonTitle(el)).toBe("wager_lobby.continue_to_lobby");
  });

  it("renders a named refusal rather than the simulation log", async () => {
    readEscrowState.mockResolvedValue(null);
    // What joinMatchOnChain now throws for `custom program error: 0x1771`.
    const refusal = Object.assign(new Error("join_match refused: not_open"), {
      code: "not_open",
    });
    joinMatchOnChain.mockRejectedValue(refusal);

    const el = await mount();
    stakeButton(el)?.dispatchEvent(new Event("click"));
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;

    // The key for the sentence, not the log. en.json carries the wording.
    expect(el.textContent).toContain("wager_lobby.error_not_open");
    expect(el.textContent).not.toContain("custom program error");
    expect(el.textContent).not.toContain("AnchorError");
  });
});
