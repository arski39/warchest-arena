// [ARENA] The menu wallet card: when it shows, what it shows, and the
// translation wiring it depends on.
//
// The last item is here because it already broke once. Lit components render
// on mount, translations load asynchronously afterwards, and LangSelector
// re-renders a HARDCODED LIST of tag names when they arrive. A component
// mounted at page load and missing from that list shows raw keys forever —
// which is exactly what this card did until it was added. Nothing else in the
// build catches it: tsc, lint and the i18n key checks all pass, because the
// key exists and is referenced. Only looking at the page finds it.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "../..");

let mint = "DhnecsQ9QKppoqcAJG3t9kPkKxcwXr3wEtZXjBGUXZkJ";
let rpc = "https://rpc.example";
let connected: { publicKey: string } | null = null;
let provider: string | null = null;
let remembered: string | null = null;

vi.mock("../../src/client/Utils", async (orig) => {
  const actual = await orig<typeof import("../../src/client/Utils")>();
  return { ...actual, translateText: (key: string) => key };
});

vi.mock("../../src/client/ClientEnv", () => ({
  ClientEnv: {
    arenaStakeMint: () => mint,
    arenaRpcUrl: () => rpc,
    arenaStakeSymbol: () => "WARC",
  },
}));

vi.mock("../../src/client/arena/WalletProvider", () => ({
  getConnectedWallet: () => connected,
  phantomBrowseLink: () => null,
}));

vi.mock("../../src/client/Auth", () => ({
  sessionProvider: async () => provider,
}));

vi.mock("../../src/client/arena/walletSession", () => ({
  storedWalletAddress: () => remembered,
}));

import { WalletBalanceCard } from "../../src/client/arena/WalletBalanceCard";

/** Constructed, not createElement'd — an erased type import never registers. */
function mount(): WalletBalanceCard {
  const el = new WalletBalanceCard();
  document.body.appendChild(el);
  return el;
}

describe("[ARENA] menu wallet card", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mint = "DhnecsQ9QKppoqcAJG3t9kPkKxcwXr3wEtZXjBGUXZkJ";
    rpc = "https://rpc.example";
    connected = null;
    provider = null;
    remembered = null;
    vi.restoreAllMocks();
  });

  it("renders nothing when this deployment has no wagering", async () => {
    // Free-to-play servers set neither, and must not get a wallet card that
    // queries a blank endpoint.
    mint = "";
    rpc = "";
    const el = mount();
    await el.updateComplete;
    expect(el.querySelector("div")).toBeNull();
  });

  it("offers a connect button when no wallet is connected", async () => {
    const el = mount();
    await el.updateComplete;
    const button = el.querySelector("button");
    expect(button).not.toBeNull();
    // Reuses the account modal's strings rather than its own copies: one
    // action should not have two wordings that can drift apart.
    expect(el.innerHTML).toContain("account_modal.wallet_login");
  });

  it("sums every token account for the mint, not just the first", async () => {
    // A wallet can legitimately hold more than one token account for a mint —
    // join_match checks owner and mint, not ATA derivation — so showing only
    // the first would understate the balance.
    connected = { publicKey: "8uqQv5J69KNM3pHx7bVKhGMLQLa6LvDHpjYfivD72bdc" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const method = JSON.parse(init.body).method as string;
        const result =
          method === "getBalance"
            ? { value: 1_234_500_000 }
            : {
                value: [
                  {
                    account: {
                      data: {
                        parsed: {
                          info: {
                            tokenAmount: { amount: "1500000", decimals: 6 },
                          },
                        },
                      },
                    },
                  },
                  {
                    account: {
                      data: {
                        parsed: {
                          info: {
                            tokenAmount: { amount: "500000", decimals: 6 },
                          },
                        },
                      },
                    },
                  },
                ],
              };
        return { ok: true, json: async () => ({ result }) };
      }),
    );

    const el = mount();
    await el.updateComplete;
    // Wait on the SOL figure specifically: "2" alone appears in the markup
    // immediately and would let this assert before the balances render.
    await vi.waitFor(() => {
      expect(el.innerHTML).toContain("1.2345");
    });
    // 1.5 + 0.5 == 2 WARC, summed across both token accounts.
    expect(el.innerHTML).toContain(">2");
  });

  it("keeps the last balance and flags it when the RPC fails", async () => {
    // A balance is informational. An endpoint hiccup must not put an error
    // card on the menu — public RPCs rate-limit hard.
    connected = { publicKey: "8uqQv5J69KNM3pHx7bVKhGMLQLa6LvDHpjYfivD72bdc" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })),
    );
    const el = mount();
    await el.updateComplete;
    await vi.waitFor(() => {
      expect(el.innerHTML).toContain("wallet_card.stale");
    });
  });

  it("shows the session's wallet before the extension has woken up", async () => {
    // The reload right after walletLogin(): the session is real and the nav
    // says so, but Phantom's auto-connect has not finished, so the extension
    // reports nothing. Reading only the extension put a "Connect wallet"
    // button in front of someone who had just connected their wallet --
    // clicking it signed them in again and reloaded to the same screen.
    connected = null;
    provider = "wallet";
    remembered = "8uqQv5J69KNM3pHx7bVKhGMLQLa6LvDHpjYfivD72bdc";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const method = JSON.parse(init.body).method as string;
        const result =
          method === "getBalance"
            ? { value: 1_234_500_000 }
            : {
                value: [
                  {
                    account: {
                      data: {
                        parsed: {
                          info: {
                            tokenAmount: { amount: "7000000", decimals: 6 },
                          },
                        },
                      },
                    },
                  },
                ],
              };
        return { ok: true, json: async () => ({ result }) };
      }),
    );

    const el = mount();
    await el.updateComplete;
    await vi.waitFor(() => {
      expect(el.innerHTML).toContain("1.2345");
    });
    expect(el.innerHTML).toContain(">7");
    expect(el.innerHTML).not.toContain("account_modal.wallet_login");
  });

  it("ignores a remembered address without a wallet session", async () => {
    // A stale entry from a logout that failed to clear is only ever ignored:
    // the token's provider claim is the authority on whether this is a
    // session, the address is only how to render it.
    connected = null;
    provider = null;
    remembered = "8uqQv5J69KNM3pHx7bVKhGMLQLa6LvDHpjYfivD72bdc";
    const el = mount();
    await el.updateComplete;
    await vi.waitFor(() => {
      expect(el.innerHTML).toContain("account_modal.wallet_login");
    });
  });

  it("is registered for re-translation, or it renders raw keys forever", () => {
    // The regression this file exists for. LangSelector re-renders a hardcoded
    // list of tags once translations load; a component mounted at page load
    // and absent from it never gets a second render.
    const source = fs.readFileSync(
      path.join(REPO, "src/client/LangSelector.ts"),
      "utf8",
    );
    expect(source).toContain('"wallet-balance-card"');
  });
});
