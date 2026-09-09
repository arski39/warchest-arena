// Framework-agnostic Solana wallet provider.
// Detects injected wallets via the Wallet Standard or legacy Phantom injection.
// All wagered-game UI imports from here rather than touching wallet SDKs directly.

import type { Transaction } from "@solana/web3.js";

export interface WalletAdapter {
  publicKey: string; // base58
  signMessage(message: Uint8Array): Promise<Uint8Array>; // returns ed25519 signature
  // [ARENA] Signs but does not submit: the caller sends the raw transaction
  // itself so it controls confirmation and can surface the program's error.
  signTransaction(transaction: Transaction): Promise<Transaction>;
  disconnect(): Promise<void>;
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
  signTransaction(transaction: Transaction): Promise<Transaction>;
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
 * Returns null whenever the normal path can work: a wallet is already injected
 * (including when we are *already* inside Phantom's browser), or this is a
 * desktop browser, where the answer is the extension rather than the app.
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
  if (getPhantom() !== null || !isMobileBrowser()) return null;
  const target = encodeURIComponent(window.location.href);
  const ref = encodeURIComponent(
    `${window.location.protocol}//${window.location.host}`,
  );
  return `https://phantom.app/ul/browse/${target}?ref=${ref}`;
}

let _connected: WalletAdapter | null = null;

function adapterFor(provider: PhantomProvider, pubkey: string): WalletAdapter {
  return {
    publicKey: pubkey,
    signMessage: async (msg) => {
      const result = await provider.signMessage(msg, "utf8");
      return result.signature;
    },
    signTransaction: (tx) => provider.signTransaction(tx),
    disconnect: () => provider.disconnect(),
  };
}

export async function connectWallet(): Promise<WalletAdapter> {
  const provider = getPhantom();
  if (!provider) {
    throw new Error(
      "No Solana wallet found. Install Phantom (phantom.app) to play wagered matches.",
    );
  }
  await provider.connect();
  if (!provider.publicKey) throw new Error("Wallet connect failed");

  _connected = adapterFor(provider, provider.publicKey.toBase58());
  return _connected;
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

/** Call once at app startup — auto-reconnects if user previously authorized. */
export function mountWalletProvider(): void {
  const provider = getPhantom();
  if (!provider) return; // no wallet extension installed, silently skip
  // Phantom auto-connects on page load if authorized; pick up the existing session.
  if (provider.isConnected && provider.publicKey) {
    _connected = adapterFor(provider, provider.publicKey.toBase58());
  }
}
