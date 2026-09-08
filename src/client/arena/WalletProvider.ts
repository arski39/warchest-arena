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
