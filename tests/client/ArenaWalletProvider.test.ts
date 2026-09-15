// [ARENA] The provider layer on top of Wallet Standard discovery.
//
// `ArenaWalletDiscovery.test.ts` pins the protocol — the handshake, the
// altered-message defence, capability negotiation. This pins what the app does
// with it: which wallet gets connected when nobody said, what each failure is
// called, and what happens when the player changes something in the extension
// while a match is riding on the wallet that was connected.
//
// The last of those is the one with money attached. `settle_match` pays exactly
// one wallet, chosen from the escrow's `players[]`, and the per-match signature
// is bound to a `jti` that names the address that signed it. So following an
// account switch mid-match would leave the player looking at an address that
// cannot be paid — and would do it silently, because the switch happens in the
// extension rather than on this page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";
import {
  resetRegistryForTests,
  type StandardAccount,
  type StandardWallet,
} from "../../src/client/arena/walletStandard";

const ADDRESS = "5miqxq62Qs3Ruc7FpyEYQuz8QWEa3Dmh9p18z7y9VdZM";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

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
  // Devnet by name, so `solanaChainFor` can tell the cluster and the
  // sign-and-send arm is reachable at all.
  arenaRpcUrl: "https://api.devnet.solana.com",
};

function account(over: Partial<StandardAccount> = {}): StandardAccount {
  return {
    address: ADDRESS,
    publicKey: new Uint8Array(32),
    chains: ["solana:devnet"],
    features: [],
    ...over,
  };
}

type ChangeListener = (props: {
  accounts?: readonly StandardAccount[];
}) => void;

interface Fake {
  wallet: StandardWallet;
  /** Every `connect()` call, so a silent reconnect that prompts is visible. */
  connects: ({ silent?: boolean } | undefined)[];
  /** Fires the wallet's `standard:events` change listeners. */
  change(accounts: readonly StandardAccount[]): void;
}

/**
 * A well-behaved Wallet Standard wallet.
 *
 * `accounts` starts empty by default: a wallet that has not authorized this site
 * reports none, which is the state a first-time `connect()` moves it out of.
 * Tests that want the reconnect-without-prompting path hand it one up front.
 */
function fakeWallet(
  name: string,
  opts: {
    accounts?: StandardAccount[];
    features?: Record<string, unknown>;
  } = {},
): Fake {
  const listeners = new Set<ChangeListener>();
  const connects: ({ silent?: boolean } | undefined)[] = [];
  const acct = account();
  const wallet: StandardWallet = {
    name,
    icon: "data:image/png;base64,iVBORw0KGgo=",
    chains: ["solana:devnet"],
    accounts: opts.accounts ?? [],
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async (input?: { silent?: boolean }) => {
          connects.push(input);
          return { accounts: [acct] };
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (_e: "change", fn: ChangeListener) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
      "solana:signMessage": {
        signMessage: async (input: { message: Uint8Array }) => [
          { signedMessage: input.message, signature: new Uint8Array([1]) },
        ],
      },
      "solana:signTransaction": {
        signTransaction: async (input: { transaction: Uint8Array }) => [
          { signedTransaction: input.transaction },
        ],
      },
      ...opts.features,
    },
  };
  return {
    wallet,
    connects,
    change: (accounts) => {
      for (const fn of listeners) fn({ accounts });
    },
  };
}

function announce(wallet: StandardWallet): void {
  window.dispatchEvent(
    new CustomEvent("wallet-standard:register-wallet", {
      detail: (api: { register(...w: StandardWallet[]): () => void }) =>
        api.register(wallet),
    }),
  );
}

type Provider = typeof import("../../src/client/arena/WalletProvider");

/**
 * A fresh provider.
 *
 * The registry and the connected wallet are module-level state by design —
 * discovery is a page-wide fact — so each test resets both rather than importing
 * a new copy. `vi.resetModules()` would be the other way, and would silently
 * split this module's registry from `walletStandard`'s.
 */
async function load(): Promise<Provider> {
  const provider = await import("../../src/client/arena/WalletProvider");
  provider.resetWalletProviderForTests();
  return provider;
}

describe("which wallet gets connected", () => {
  let provider: Provider;

  beforeEach(async () => {
    resetRegistryForTests();
    localStorage.clear();
    (window as unknown as { BOOTSTRAP_CONFIG: unknown }).BOOTSTRAP_CONFIG =
      BOOTSTRAP;
    ClientEnv.reset();
    provider = await load();
    provider.mountWalletProvider();
  });

  afterEach(() => {
    provider.resetWalletProviderForTests();
    resetRegistryForTests();
    document.body.innerHTML = "";
    document.body.className = "";
    delete (window as unknown as { phantom?: unknown }).phantom;
    ClientEnv.reset();
  });

  it("offers every discovered wallet, not just Phantom", () => {
    announce(fakeWallet("Solflare").wallet);
    announce(fakeWallet("Backpack").wallet);

    expect(provider.listWallets().map((w) => w.name)).toEqual([
      "Solflare",
      "Backpack",
    ]);
  });

  it("does not list Phantom twice when it both registers and injects", () => {
    announce(fakeWallet(provider.PHANTOM_NAME).wallet);
    (window as unknown as { phantom: unknown }).phantom = {
      solana: { isConnected: false, publicKey: null },
    };

    // The registration is the better of the two — it carries an icon and
    // reports its capabilities — so the injected provider contributes no row.
    const rows = provider.listWallets();
    expect(rows).toHaveLength(1);
    expect(rows[0].icon).not.toBe("");
  });

  it("connects the wallet the player named", async () => {
    announce(fakeWallet("Solflare").wallet);
    announce(fakeWallet("Backpack").wallet);

    const wallet = await provider.connectWallet("Backpack");
    expect(wallet.name).toBe("Backpack");
    expect(provider.getConnectedWallet()?.publicKey).toBe(ADDRESS);
  });

  it("prefers the wallet this browser used last when nobody named one", async () => {
    announce(fakeWallet("Solflare").wallet);
    announce(fakeWallet("Backpack").wallet);
    await provider.connectWallet("Backpack");
    provider.resetWalletProviderForTests();

    // No argument: the surfaces that have not grown a picker yet.
    expect((await provider.connectWallet()).name).toBe("Backpack");
  });

  it("reports a wallet that cannot sign messages as unusable, not as absent", async () => {
    // A registered wallet with no solana:signMessage cannot prove anything
    // here, so it is filtered out of the list — but naming it explicitly has to
    // produce a sentence about THAT wallet, never "install a wallet".
    const crippled = fakeWallet("Toy");
    delete (crippled.wallet.features as Record<string, unknown>)[
      "solana:signMessage"
    ];
    announce(crippled.wallet);

    expect(provider.listWallets()).toHaveLength(0);
    await expect(provider.connectWallet("Toy")).rejects.toMatchObject({
      name: "WalletConnectError",
      code: "cannot_sign",
      walletName: "Toy",
    });
  });

  it("distinguishes a wallet that is gone from one that never existed", async () => {
    announce(fakeWallet("Solflare").wallet);

    await expect(provider.connectWallet("Ghost")).rejects.toMatchObject({
      code: "unknown_wallet",
    });
  });

  it("says no wallet only when there really is none", async () => {
    await expect(provider.connectWallet()).rejects.toMatchObject({
      code: "no_wallet",
      walletName: null,
    });
  });

  it("still connects an injected-only Phantom", async () => {
    // The fallback for a build old enough not to register. Removing it would
    // regress the only wallet this site has ever supported.
    (window as unknown as { phantom: unknown }).phantom = {
      solana: {
        isConnected: false,
        publicKey: { toBase58: () => ADDRESS },
        connect: async () => {},
        signMessage: async () => ({ signature: new Uint8Array([1]) }),
        signTransaction: async () => ({ serialize: () => new Uint8Array() }),
      },
    };

    const wallet = await provider.connectWallet();
    expect(wallet.name).toBe(provider.PHANTOM_NAME);
    expect(wallet.publicKey).toBe(ADDRESS);
  });
});

describe("reconnecting without a prompt", () => {
  let provider: Provider;

  beforeEach(async () => {
    resetRegistryForTests();
    localStorage.clear();
    (window as unknown as { BOOTSTRAP_CONFIG: unknown }).BOOTSTRAP_CONFIG =
      BOOTSTRAP;
    ClientEnv.reset();
    provider = await load();
  });

  afterEach(() => {
    provider.resetWalletProviderForTests();
    resetRegistryForTests();
    ClientEnv.reset();
  });

  it("restores the remembered wallet from its own accounts, asking nothing", async () => {
    localStorage.setItem("arena_wallet_name", "Solflare");
    const fake = fakeWallet("Solflare", { accounts: [account()] });

    provider.mountWalletProvider();
    announce(fake.wallet);
    await vi.waitFor(() =>
      expect(provider.getConnectedWallet()).not.toBeNull(),
    );

    expect(provider.getConnectedWallet()?.name).toBe("Solflare");
    // A wallet that already exposes an authorized account needs no call at all.
    // Wallets are only ASKED to honour `silent`, so the cheapest way not to pop
    // a modal on every page load is not to make the call.
    expect(fake.connects).toEqual([]);
  });

  it("asks silently when the wallet exposes no account up front", async () => {
    localStorage.setItem("arena_wallet_name", "Solflare");
    const fake = fakeWallet("Solflare");

    provider.mountWalletProvider();
    announce(fake.wallet);
    await vi.waitFor(() => expect(fake.connects).toHaveLength(1));

    expect(fake.connects[0]).toEqual({ silent: true });
  });

  it("does not reconnect a wallet this browser never chose", async () => {
    localStorage.setItem("arena_wallet_name", "Solflare");
    const other = fakeWallet("Backpack", { accounts: [account()] });

    provider.mountWalletProvider();
    announce(other.wallet);
    await Promise.resolve();
    await Promise.resolve();

    expect(provider.getConnectedWallet()).toBeNull();
    expect(other.connects).toEqual([]);
  });

  it("catches a wallet that registers after the page loaded", async () => {
    // The Mobile Wallet Adapter case: it registers only once its lazy import
    // has run, long after mountWalletProvider(). A reconnect that only looked
    // at the registry as it stood at mount would never see it.
    localStorage.setItem("arena_wallet_name", "Mobile Wallet Adapter");
    provider.mountWalletProvider();

    const late = fakeWallet("Mobile Wallet Adapter", { accounts: [account()] });
    announce(late.wallet);
    await vi.waitFor(() =>
      expect(provider.getConnectedWallet()?.name).toBe("Mobile Wallet Adapter"),
    );
  });
});

describe("when the extension changes under us", () => {
  let provider: Provider;
  let fake: Fake;

  beforeEach(async () => {
    resetRegistryForTests();
    localStorage.clear();
    (window as unknown as { BOOTSTRAP_CONFIG: unknown }).BOOTSTRAP_CONFIG =
      BOOTSTRAP;
    ClientEnv.reset();
    provider = await load();
    provider.mountWalletProvider();
    fake = fakeWallet("Solflare");
    announce(fake.wallet);
    await provider.connectWallet("Solflare");
  });

  afterEach(() => {
    provider.resetWalletProviderForTests();
    resetRegistryForTests();
    document.body.innerHTML = "";
    document.body.className = "";
    ClientEnv.reset();
  });

  it("forgets the wallet when it locks or disconnects", () => {
    fake.change([]);
    // Reporting a public key for a wallet that has gone away is how the nav
    // ends up describing a session nobody can sign for.
    expect(provider.getConnectedWallet()).toBeNull();
  });

  it("follows an account switch at the menu, where nothing is bound", () => {
    fake.change([account({ address: OTHER })]);
    expect(provider.getConnectedWallet()?.publicKey).toBe(OTHER);
  });

  it("does NOT follow an account switch during a match", () => {
    document.body.classList.add("in-game");
    fake.change([account({ address: OTHER })]);

    // The escrow's players[] and the jti-bound match signature both name the
    // address that was connected when the match started, and settle_match pays
    // exactly one wallet out of players[]. Swapping here would leave the player
    // watching an address that cannot be paid the pot they staked.
    expect(provider.getConnectedWallet()?.publicKey).toBe(ADDRESS);
  });

  it("does NOT follow an account switch while the stake prompt is open", () => {
    const overlay = document.createElement("div");
    overlay.className = "arena-wager-overlay";
    document.body.appendChild(overlay);
    fake.change([account({ address: OTHER })]);

    // By this point a jti has been signed over, and the stake may already be in
    // the vault.
    expect(provider.getConnectedWallet()?.publicKey).toBe(ADDRESS);
  });
});
