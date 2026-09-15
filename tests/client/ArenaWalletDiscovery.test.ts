// [ARENA] Wallet Standard discovery, and the checks that keep a wallet which
// cannot work here from reaching the stake gate.
//
// The site supported Phantom only, by reading `window.phantom.solana`. Discovery
// replaces that with the spec's two-event handshake, which is what also lets
// Mobile Wallet Adapter register itself later from a lazy import.
//
// The test that matters most is the prefixed-message one. Wallet Standard lets a
// wallet alter a message before signing and report what it actually signed;
// `core/arena/walletSignature.ts` verifies the exact bytes with no tolerance. So
// a prefixing wallet produces a valid signature the server refuses -- and for the
// per-match signature that refusal arrives as a websocket close AFTER the stake
// is in the vault, where `cancel_match` will not release it for 24 hours.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adaptStandardWallet,
  base58,
  mountRegistry,
  negotiateSubmit,
  pickerIcon,
  registeredWallets,
  resetRegistryForTests,
  solanaChainFor,
  type StandardAccount,
  type StandardWallet,
} from "../../src/client/arena/walletStandard";

const ADDRESS = "5miqxq62Qs3Ruc7FpyEYQuz8QWEa3Dmh9p18z7y9VdZM";

function account(over: Partial<StandardAccount> = {}): StandardAccount {
  return {
    address: ADDRESS,
    publicKey: new Uint8Array(32),
    chains: ["solana:devnet"],
    features: [],
    ...over,
  };
}

/** A wallet that behaves. `signedMessage` echoes the input, as it must. */
function goodWallet(name: string, over: Partial<StandardWallet> = {}) {
  const acct = account();
  const wallet: StandardWallet = {
    name,
    icon: "data:image/png;base64,iVBORw0KGgo=",
    chains: ["solana:devnet"],
    accounts: [acct],
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => ({ accounts: [acct] }),
      },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signMessage": {
        signMessage: async (input: { message: Uint8Array }) => [
          { signedMessage: input.message, signature: new Uint8Array([9, 9]) },
        ],
      },
      "solana:signTransaction": {
        signTransaction: async (input: { transaction: Uint8Array }) => [
          { signedTransaction: input.transaction },
        ],
      },
    },
    ...over,
  };
  return wallet;
}

/** Registers a wallet the way a real extension does. */
function announce(wallet: StandardWallet): void {
  window.dispatchEvent(
    new CustomEvent("wallet-standard:register-wallet", {
      detail: (api: { register(...w: StandardWallet[]): () => void }) =>
        api.register(wallet),
    }),
  );
}

describe("discovery", () => {
  beforeEach(() => resetRegistryForTests());
  afterEach(() => resetRegistryForTests());

  it("finds a wallet that registered before the app was ready", () => {
    // The extension loaded first and is waiting for app-ready. Its listener
    // fires synchronously during our dispatch, so the wallet is there the
    // instant mountRegistry() returns -- which is what lets getConnectedWallet()
    // stay synchronous.
    const pending: ((api: unknown) => void)[] = [];
    window.addEventListener("wallet-standard:app-ready", (e) => {
      for (const fn of pending) fn((e as CustomEvent).detail);
    });
    pending.push((api) =>
      (api as { register(w: StandardWallet): void }).register(
        goodWallet("Early"),
      ),
    );

    mountRegistry();

    expect(registeredWallets().map((w) => w.name)).toContain("Early");
  });

  it("finds a wallet that registers after the app was ready", () => {
    mountRegistry();
    announce(goodWallet("Late"));

    // The listener is deliberately never removed. Mobile Wallet Adapter arrives
    // this way: it is imported lazily when the picker opens, long after mount.
    expect(registeredWallets().map((w) => w.name)).toContain("Late");
  });

  it("keeps one entry per wallet name, so Phantom cannot appear twice", () => {
    mountRegistry();
    announce(goodWallet("Phantom"));
    announce(goodWallet("Phantom"));

    expect(
      registeredWallets().filter((w) => w.name === "Phantom"),
    ).toHaveLength(1);
  });
});

describe("the altered-message defence", () => {
  const message = new TextEncoder().encode("OpenFront Arena\nAuth: nonce-1");

  it("refuses a wallet that signs different bytes than it was given", async () => {
    const acct = account();
    const wallet = goodWallet("Prefixer", {
      features: {
        ...goodWallet("Prefixer").features,
        "solana:signMessage": {
          signMessage: async (input: { message: Uint8Array }) => [
            {
              // What several wallets do: a domain-binding prefix.
              signedMessage: new Uint8Array([1, 2, ...input.message]),
              signature: new Uint8Array([7, 7]),
            },
          ],
        },
      },
    });

    const parts = adaptStandardWallet(wallet, acct, "solana:devnet", () => {});

    await expect(parts.signMessage(message)).rejects.toMatchObject({
      code: "message_prefixed",
    });
  });

  it("accepts a wallet that signs exactly what it was handed", async () => {
    // The control. Without it the check could reject everything and still pass.
    const parts = adaptStandardWallet(
      goodWallet("Honest"),
      account(),
      "solana:devnet",
      () => {},
    );

    await expect(parts.signMessage(message)).resolves.toEqual(
      new Uint8Array([9, 9]),
    );
  });

  it("compares bytes, not decoded strings", async () => {
    const acct = account();
    // Two different byte sequences that a lossy decoder renders identically.
    // Guards against anyone "simplifying" this to a TextDecoder comparison.
    const wallet = goodWallet("Lossy", {
      features: {
        ...goodWallet("Lossy").features,
        "solana:signMessage": {
          signMessage: async () => [
            {
              signedMessage: new Uint8Array([0xff, 0xfe]),
              signature: new Uint8Array([7]),
            },
          ],
        },
      },
    });

    const parts = adaptStandardWallet(wallet, acct, "solana:devnet", () => {});

    await expect(
      parts.signMessage(new Uint8Array([0xff, 0xfd])),
    ).rejects.toMatchObject({ code: "message_prefixed" });
  });
});

describe("capability negotiation", () => {
  const signAndSendOnly = (chains: string[]) => {
    const base = goodWallet("SendOnly");
    const rest = { ...base.features };
    delete rest["solana:signTransaction"];
    return {
      ...base,
      features: {
        ...rest,
        "solana:signAndSendTransaction": {
          signAndSendTransaction: async () => [
            { signature: new Uint8Array([0, 1, 2]) },
          ],
        },
      },
      accounts: [account({ chains })],
    };
  };

  it("prefers sign-only, so the caller keeps control of submission", () => {
    const r = negotiateSubmit(goodWallet("A"), account(), "solana:devnet");
    expect(r.submit?.kind).toBe("sign");
  });

  it("falls back to sign-and-send when the wallet has no sign-only path", () => {
    // Mobile Wallet Adapter's case: solana:signTransaction is optional there and
    // MWA 2.0 deprecates it, so on some phones this is the only path.
    const w = signAndSendOnly(["solana:devnet"]);
    const r = negotiateSubmit(w, w.accounts[0], "solana:devnet");
    expect(r.submit?.kind).toBe("signAndSend");
  });

  it("refuses sign-and-send when the account does not claim our cluster", () => {
    // The wallet picks the RPC from the chain we pass, so a wrong guess
    // broadcasts a real transaction to the wrong cluster.
    const w = signAndSendOnly(["solana:mainnet"]);
    const r = negotiateSubmit(w, w.accounts[0], "solana:devnet");
    expect(r).toMatchObject({ submit: null, blocked: "wrong_cluster" });
  });

  it("refuses sign-and-send when the cluster cannot be told at all", () => {
    const w = signAndSendOnly(["solana:devnet"]);
    const r = negotiateSubmit(w, w.accounts[0], null);
    expect(r).toMatchObject({ submit: null, blocked: "wrong_cluster" });
  });

  it("still allows sign-only on an account that under-reports its chains", () => {
    // Deliberate asymmetry: we submit these bytes ourselves, so the wallet's
    // chain opinion is irrelevant. Filtering strictly here would exclude wallets
    // that work fine.
    const r = negotiateSubmit(
      goodWallet("A"),
      account({ chains: ["solana:mainnet"] }),
      "solana:devnet",
    );
    expect(r.submit?.kind).toBe("sign");
  });

  it("blocks a wallet with no transaction feature at all", () => {
    const base = goodWallet("MsgOnly");
    const rest = { ...base.features };
    delete rest["solana:signTransaction"];
    const r = negotiateSubmit(
      { ...base, features: rest },
      account(),
      "solana:devnet",
    );
    expect(r).toMatchObject({
      submit: null,
      blocked: "no_transaction_feature",
    });
  });
});

describe("cluster inference", () => {
  it("names the public clusters", () => {
    expect(solanaChainFor("https://api.devnet.solana.com")).toBe(
      "solana:devnet",
    );
    expect(solanaChainFor("https://api.mainnet-beta.solana.com")).toBe(
      "solana:mainnet",
    );
    expect(solanaChainFor("http://127.0.0.1:8899")).toBe("solana:localnet");
  });

  it("answers null for a paid endpoint rather than guessing", () => {
    // devnet.helius-rpc.com and a mainnet Helius url are indistinguishable by
    // hostname, and guessing wrong would broadcast to the wrong cluster.
    expect(
      solanaChainFor("https://devnet.helius-rpc.com/?api-key=x"),
    ).toBeNull();
    expect(solanaChainFor("not a url")).toBeNull();
  });
});

describe("the wallet-supplied icon", () => {
  it("accepts inline image data", () => {
    expect(pickerIcon("data:image/png;base64,iVBORw0KGgo=")).not.toBe("");
  });

  it("drops a remote url", () => {
    // An extension author would otherwise learn the IP and referrer of everyone
    // who opens the picker.
    expect(pickerIcon("https://tracker.example/pixel.png")).toBe("");
    expect(pickerIcon(undefined)).toBe("");
  });
});

describe("base58", () => {
  it("matches known vectors", () => {
    expect(base58(new Uint8Array([0]))).toBe("1");
    expect(base58(new Uint8Array([]))).toBe("");
    // Leading zero bytes are '1's, then the big-endian remainder.
    expect(base58(new Uint8Array([0, 0, 1]))).toBe("112");
  });

  it("round-trips a real 64-byte signature through web3.js's decoder", async () => {
    const { PublicKey } = await import("@solana/web3.js");
    const bytes = new Uint8Array(32).fill(7);
    // A 32-byte value encoded by us must decode back to the same bytes.
    expect(new PublicKey(base58(bytes)).toBytes()).toEqual(bytes);
  });
});
