// [ARENA] The one place the rest of the app talks to a Solana wallet.
//
// Two backends sit behind a single `WalletAdapter`:
//
//   * **Wallet Standard** (`walletStandard.ts`) — the protocol every current
//     wallet implements, discovered through two window events. This is what
//     brings Solflare, Backpack, Glow and the rest, and it is also what Mobile
//     Wallet Adapter registers itself into.
//   * **Phantom's injected provider** (`window.phantom.solana`) — kept as a
//     fallback for builds old enough not to register, and deduped by name
//     against the Standard registration so Phantom never appears twice.
//
// This module is in the MAIN chunk: `Main.ts` calls `mountWalletProvider()` at
// module scope. It must therefore stay free of `@solana/web3.js` (~294 kB),
// which an eslint `no-restricted-imports` rule over this file enforces rather
// than leaving to a comment. `phantomLegacyTx.ts` exists to hold the one place a
// real `Transaction` object is unavoidable, lazily imported at stake time.
//
// All wagered-game UI imports from here rather than touching wallet SDKs.
import { ClientEnv } from "../ClientEnv";
import { sessionIsBound } from "./sessionBinding";
import { rememberWalletName, storedWalletName } from "./walletSession";
import {
  adaptStandardWallet,
  canSignMessage,
  connectStandard,
  mountRegistry,
  onRegistryChange,
  pickAccount,
  pickerIcon,
  registeredWallets,
  solanaChainFor,
  type SolanaChain,
  type StandardAccount,
  type StandardWallet,
} from "./walletStandard";

/**
 * [ARENA] How this wallet can put a signed transaction on chain.
 *
 * A discriminated union rather than two optional methods, because the caller has
 * to branch anyway -- the `sign` arm ends in `sendRawTransaction` and the
 * `signAndSend` arm does not -- and because "this wallet can do neither" has to
 * be representable at all. Mobile Wallet Adapter exposes `solana:signTransaction`
 * only *optionally* (it is filled in at runtime from the connected app's reported
 * capabilities, and MWA 2.0 deprecates it in favour of sign-and-send), so
 * sign-only is a capability to negotiate, never one to assume.
 *
 * Sign-only is preferred wherever it exists: `onchainJoin.ts` submits the
 * transaction itself on purpose, so that it controls confirmation and so that a
 * refused preflight still carries the program's own error.
 */
export type StakeSubmit =
  | {
      readonly kind: "sign";
      /** Wire bytes in, fully signed wire bytes out. */
      signTransaction(transaction: Uint8Array): Promise<Uint8Array>;
    }
  | {
      readonly kind: "signAndSend";
      /** Wire bytes in, base58 transaction signature out. The wallet submits. */
      signAndSend(transaction: Uint8Array): Promise<string>;
    };

export interface WalletAdapter {
  /** base58 */
  readonly publicKey: string;
  /** The wallet app's own name, e.g. "Phantom". Display and reconnect hint only. */
  readonly name: string;
  /** A `data:image/*` URI the wallet supplied, or "" when it offered none. */
  readonly icon: string;

  /**
   * An ed25519 signature over EXACTLY `message`.
   *
   * Wallet Standard permits a wallet to prefix or otherwise alter a message
   * before signing it, and `core/arena/walletSignature.ts` verifies the exact
   * bytes with no tolerance. A wallet that alters the message therefore produces
   * a signature the server refuses -- and for the per-match signature that is
   * discovered only after the stake is already in the vault. Implementations
   * MUST compare what the wallet says it signed and throw rather than return.
   */
  signMessage(message: Uint8Array): Promise<Uint8Array>;

  /**
   * How this wallet can stake on this deployment's cluster, or null if it
   * cannot. Null is a first-class state rather than an error: `walletLogin()`
   * needs only `signMessage`, so a wallet that cannot stake is still a perfectly
   * good sign-in.
   */
  readonly submit: StakeSubmit | null;
}

type PhantomProvider = {
  publicKey: { toBase58(): string } | null;
  isConnected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  signMessage(
    message: Uint8Array,
    encoding: "utf8" | "hex",
  ): Promise<{ signature: Uint8Array }>;
  // Phantom's injected API is the one backend that still wants an object. It is
  // typed structurally so this module needs no `@solana/web3.js` import at all --
  // see phantomLegacyTx.ts, which is lazily imported only if this path is used.
  signTransaction(transaction: unknown): Promise<{ serialize(): Uint8Array }>;
};

function getPhantom(): PhantomProvider | null {
  const w = window as unknown as {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  return w.phantom?.solana ?? w.solana ?? null;
}

/**
 * [ARENA] Whether this looks like a phone or tablet browser.
 *
 * UA sniffing, which is normally a smell, but the thing being detected really
 * is "which app store did this browser come from" rather than a capability:
 * Phantom ships a browser extension on desktop and a standalone app on mobile,
 * and no feature test distinguishes those.
 *
 * iPadOS 13+ reports itself as Macintosh, so touch points are what separate an
 * iPad from a Mac. Getting this wrong is cheap in both directions -- a
 * misdetected desktop is shown a link that opens phantom.app, a misdetected
 * phone is shown install instructions -- which is why a UA test is tolerable
 * here and would not be for anything load-bearing.
 */
function isMobileBrowser(): boolean {
  const ua = navigator.userAgent;
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return /Android|iPhone|iPod|iPad/i.test(ua) || iPadOS;
}

/**
 * [ARENA] The Phantom universal link that reopens a page inside Phantom's own
 * in-app browser, where the provider IS injected.
 *
 * Returns null whenever the normal path can work: a wallet is reachable in this
 * tab already — injected, or registered through Wallet Standard, which is how
 * Mobile Wallet Adapter makes an ordinary Android tab able to sign — or this is
 * a desktop browser, where the answer is the extension rather than the app.
 *
 * This is the whole reason mobile sign-in appeared to do nothing. On a phone,
 * Safari and Chrome inject no `window.phantom`, so `connectWallet()` threw
 * "install Phantom" at people who had Phantom installed -- the app simply
 * cannot be reached from an ordinary mobile browser tab.
 *
 * ⚠️ Phantom's browser is a SEPARATE browser context: no cookies, no
 * localStorage, so following this link starts a fresh session. That is
 * harmless at the menu, where nothing is bound yet, and is why the stake
 * prompt does NOT follow it -- switching mid-lobby would rejoin the player as
 * a second client while their first one is still connected, filling a duel
 * with one person twice over.
 */
export function phantomBrowseLink(): string | null {
  if (getPhantom() !== null || usableWallets().length > 0) return null;
  if (!isMobileBrowser()) return null;
  const target = encodeURIComponent(window.location.href);
  const ref = encodeURIComponent(
    `${window.location.protocol}//${window.location.host}`,
  );
  return `https://phantom.app/ul/browse/${target}?ref=${ref}`;
}

/** The name Phantom registers under, used to dedupe injected vs Wallet Standard. */
export const PHANTOM_NAME = "Phantom";

/** A wallet the player could pick. What a picker row renders from. */
export interface WalletChoice {
  /** The Wallet Standard `name`, and the handle `connectWallet()` takes. */
  readonly name: string;
  /** A `data:image/*` URI, or "" — see `pickerIcon`. */
  readonly icon: string;
}

/** Why connecting produced no wallet. Also the `wager_lobby.error_*` suffix. */
export type WalletConnectFailure =
  /** Nothing registered, and no injected provider either. */
  | "no_wallet"
  /** A named wallet is not (or no longer) registered. A stale remembered name. */
  | "unknown_wallet"
  /** Connected, but the wallet authorized no account. */
  | "no_account"
  /** Registered, but it cannot sign messages — so it can prove nothing here. */
  | "cannot_sign";

/**
 * [ARENA] A typed connection failure.
 *
 * Replaces a bare `new Error("No Solana wallet found. Install Phantom…")`, which
 * was wrong twice over: it was an untranslated English literal that `WagerLobby`
 * rendered raw to every player, and it was the ONLY throw this function had, so
 * `walletLogin.ts` classified every failure as "install a wallet". With
 * discovery in place that would tell someone holding three working wallets to go
 * and install one.
 *
 * `code` is the field `WagerLobby.errorText()` reads, so every value here needs a
 * `wager_lobby.error_*` entry in en.json.
 */
export class WalletConnectError extends Error {
  constructor(
    readonly code: WalletConnectFailure,
    readonly walletName: string | null,
  ) {
    super(
      walletName === null
        ? `wallet connect failed: ${code}`
        : `${walletName}: ${code}`,
    );
    this.name = "WalletConnectError";
  }
}

let _connected: WalletAdapter | null = null;
/** Unsubscribes the connected wallet's `standard:events` listener. */
let _off: (() => void) | null = null;

/**
 * The injected-Phantom backend.
 *
 * Note what is NOT here: the signed-message comparison the Wallet Standard
 * adapter does. Phantom's injected `signMessage` returns only `{ signature }` --
 * there is no `signedMessage` to compare against, so the check cannot run on this
 * path. That is the status quo rather than a hole this change opens: Phantom is
 * known to sign the raw bytes, the current code has depended on it in production,
 * and the check now guards every other wallet.
 */
function adapterFor(provider: PhantomProvider, pubkey: string): WalletAdapter {
  return {
    publicKey: pubkey,
    name: PHANTOM_NAME,
    icon: "",
    signMessage: async (msg) => {
      const result = await provider.signMessage(msg, "utf8");
      return result.signature;
    },
    submit: {
      kind: "sign",
      signTransaction: async (wire) => {
        const { deserializeForPhantom } = await import("./phantomLegacyTx");
        const signed = await provider.signTransaction(
          deserializeForPhantom(wire),
        );
        return signed.serialize();
      },
    },
  };
}

/** Registered wallets that can sign a message, which is the floor for any use. */
function usableWallets(): StandardWallet[] {
  return registeredWallets().filter(canSignMessage);
}

/**
 * Every wallet the player could connect right now.
 *
 * Phantom is deduped by name: it registers through Wallet Standard *and* injects
 * `window.phantom.solana`, and the registration is the better of the two — it
 * carries an icon and reports its capabilities. The injected provider therefore
 * contributes a row only when nothing registered under that name.
 */
export function listWallets(): WalletChoice[] {
  const rows: WalletChoice[] = usableWallets().map((w) => ({
    name: w.name,
    icon: pickerIcon(w.icon),
  }));
  if (!rows.some((r) => r.name === PHANTOM_NAME) && getPhantom() !== null) {
    rows.push({ name: PHANTOM_NAME, icon: "" });
  }
  return rows;
}

/**
 * Which wallet to connect when the caller named none.
 *
 * A picker is what makes the choice explicit; this is the answer for surfaces
 * that have not asked, and for the single-wallet case where asking would be pure
 * friction. Order: the one this browser used last, then Phantom — what this site
 * has always connected to, so preferring it cannot regress anybody — then
 * whatever registered first.
 */
function defaultChoice(): StandardWallet | null {
  const wallets = usableWallets();
  if (wallets.length === 0) return null;
  const remembered = storedWalletName();
  return (
    wallets.find((w) => w.name === remembered) ??
    wallets.find((w) => w.name === PHANTOM_NAME) ??
    wallets[0]
  );
}

/** The cluster this deployment stakes on, or null when the RPC does not say. */
function deploymentChain(): SolanaChain | null {
  return solanaChainFor(ClientEnv.arenaRpcUrl());
}

/**
 * Installs a connected Standard account as *the* wallet, replacing any previous
 * one and its change subscription.
 */
function adopt(
  wallet: StandardWallet,
  account: StandardAccount,
): WalletAdapter {
  _off?.();
  const parts = adaptStandardWallet(
    wallet,
    account,
    deploymentChain(),
    (accounts) => accountsChanged(wallet, accounts),
  );
  _off = parts.off;
  _connected = {
    publicKey: parts.publicKey,
    name: parts.name,
    icon: parts.icon,
    signMessage: parts.signMessage,
    submit: parts.submit,
  };
  rememberWalletName(wallet.name);
  return _connected;
}

/**
 * [ARENA] The player changed something in their wallet extension.
 *
 * Two cases, and they are deliberately not symmetric.
 *
 * **Locked or disconnected** (no accounts) clears the adapter unconditionally.
 * Continuing to report a public key for a wallet that has gone away is how the
 * nav ends up describing a session nobody can sign for.
 *
 * **Switched account** must NOT be followed while a session is bound to the old
 * one. The JWT's `sub`, any in-flight `jti`-bound match signature and the
 * escrow's `players[]` all name the wallet that was connected when the match
 * started, so swapping silently would leave the player looking at an address
 * that cannot settle the pot they staked — and `settle_match` pays exactly one
 * wallet, chosen from `players[]`. At the menu nothing is bound and following
 * the switch is simply correct; mid-match the connected wallet is kept and the
 * disagreement is logged rather than papered over.
 */
function accountsChanged(
  wallet: StandardWallet,
  accounts: readonly StandardAccount[],
): void {
  const next = pickAccount(accounts);
  if (next === undefined) {
    _off?.();
    _off = null;
    _connected = null;
    return;
  }
  if (_connected !== null && next.address === _connected.publicKey) return;
  if (sessionIsBound()) {
    console.warn(
      `[arena] ${wallet.name} switched to ${next.address} during a bound session; keeping the connected wallet`,
    );
    return;
  }
  adopt(wallet, next);
}

/**
 * Connects a wallet and makes it the connected one.
 *
 * @param name a Wallet Standard `name` from `listWallets()`. Omitted, the
 * default choice above is used — which is what every caller does until a picker
 * exists to supply one.
 */
export async function connectWallet(name?: string): Promise<WalletAdapter> {
  let wallet: StandardWallet | null;
  if (name === undefined) {
    wallet = defaultChoice();
  } else {
    wallet = usableWallets().find((w) => w.name === name) ?? null;
    // Named, registered, and unusable is its own sentence: "the wallet you
    // picked cannot sign here" is not "install a wallet".
    if (wallet === null && registeredWallets().some((w) => w.name === name)) {
      throw new WalletConnectError("cannot_sign", name);
    }
  }

  if (wallet === null) {
    // No Standard wallet to use. The injected provider is the last resort, and
    // it is Phantom's alone.
    if (name !== undefined && name !== PHANTOM_NAME) {
      throw new WalletConnectError("unknown_wallet", name);
    }
    const provider = getPhantom();
    if (provider === null) throw new WalletConnectError("no_wallet", null);
    await provider.connect();
    if (!provider.publicKey) {
      throw new WalletConnectError("no_account", PHANTOM_NAME);
    }
    _off?.();
    _off = null;
    _connected = adapterFor(provider, provider.publicKey.toBase58());
    rememberWalletName(PHANTOM_NAME);
    return _connected;
  }

  const account = pickAccount(await connectStandard(wallet));
  if (account === undefined) {
    throw new WalletConnectError("no_account", wallet.name);
  }
  return adopt(wallet, account);
}

export function getConnectedWallet(): WalletAdapter | null {
  return _connected;
}

/**
 * base64 of raw bytes, without pulling in a Buffer polyfill. `Buffer` is a Node
 * global and is simply undefined in the browser, so the obvious
 * `Buffer.from(sig).toString("base64")` type-checks (via @types/node) and then
 * throws at runtime. btoa needs a binary string, hence the per-byte map.
 *
 * Lives here because both things that sign with a wallet need it — the
 * per-match binding in `walletAuth.ts` and the login exchange in
 * `walletLogin.ts` — and the two must not import each other. They prove
 * different claims with deliberately different message prefixes, and a shared
 * encoder is the only thing they should have in common.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * [ARENA] Reconnects the wallet this browser used last, without prompting.
 *
 * `wallet.accounts` is read BEFORE any connect call, because a wallet is only
 * *asked* to honour `silent` — it is free to prompt anyway, and a modal that
 * pops on every page load is worse than a player pressing Connect once. Wallets
 * that expose their authorized accounts up front are therefore reconnected with
 * no call at all, and only the remembered wallet is ever offered the silent
 * connect, so a spec-violating wallet can annoy at most the person who chose it.
 */
async function silentReconnect(wallet: StandardWallet): Promise<void> {
  try {
    const account =
      pickAccount(wallet.accounts) ??
      pickAccount(await connectStandard(wallet, { silent: true }));
    // Re-checked after the await: pressing Connect during the round trip wins.
    if (account !== undefined && _connected === null) adopt(wallet, account);
  } catch {
    // Refusing a silent connect is the normal answer for anyone who has not
    // authorized this site. Pressing Connect is the fix, not an error message.
  }
}

/** Wallets already offered a silent reconnect, so a registry change cannot re-ask. */
const attempted = new Set<string>();

function reconnectRemembered(): void {
  if (_connected !== null) return;
  const remembered = storedWalletName();
  if (remembered === null || attempted.has(remembered)) return;
  const wallet = usableWallets().find((w) => w.name === remembered);
  if (wallet === undefined) return;
  attempted.add(remembered);
  void silentReconnect(wallet);
}

/**
 * Call once at app startup.
 *
 * `mountRegistry()` is synchronous, and wallets call `register()` *during* its
 * `app-ready` dispatch, so anything already loaded is discoverable the moment
 * this returns. The registry subscription covers the rest: an extension that
 * injects late, and Mobile Wallet Adapter, which registers only after its lazy
 * import.
 */
export function mountWalletProvider(): void {
  mountRegistry();
  onRegistryChange(reconnectRemembered);
  reconnectRemembered();

  // Fallback for a Phantom old enough not to register. Its auto-connect has
  // usually not finished by module scope, which is why `walletSession.ts`
  // remembers the address for display — this picks up only the case where it
  // already has.
  if (_connected === null) {
    const provider = getPhantom();
    if (provider?.isConnected === true && provider.publicKey) {
      _connected = adapterFor(provider, provider.publicKey.toBase58());
    }
  }
}

/** Test seam: drop the connected wallet and the reconnect bookkeeping. */
export function resetWalletProviderForTests(): void {
  _off?.();
  _off = null;
  _connected = null;
  attempted.clear();
}
