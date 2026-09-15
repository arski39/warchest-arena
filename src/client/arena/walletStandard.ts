// [ARENA] Wallet Standard discovery, hand-rolled.
//
// ## Why hand-rolled
//
// This module is in the MAIN chunk -- `Main.ts` calls `mountWalletProvider()` at
// module scope, so discovery has to have run by the time the nav renders. Every
// byte here lands on players who will never stake. `@wallet-standard/app` is
// small, but the repo's Hard Rule is "do not add dependencies without stating
// why", and this codebase hand-rolled an entire Anchor client
// (`core/arena/arenaProgram.ts` -- discriminators, account layout, instruction
// encoding) for exactly this reason. Against that precedent, a dependency for
// two window events and a Map is not defensible.
//
// The protocol is frozen under the `wallet-standard:` event namespace and cannot
// change without a new namespace, so the maintenance risk that usually justifies
// a dependency does not apply.
//
// ## The handshake, and why both halves are needed
//
// Either side may load first, so the spec has the app do both:
//
//   * listen for `wallet-standard:register-wallet`, whose `detail` is a callback
//     the app hands its `{register}` api to; and
//   * dispatch `wallet-standard:app-ready` carrying that same api.
//
// Wallets call `register()` *synchronously* inside the app-ready dispatch, so a
// wallet already loaded is in the registry the instant `mount()` returns. The
// listener is installed permanently and never torn down -- that is what lets a
// wallet register late, which is exactly how Mobile Wallet Adapter joins after
// its lazy import.
//
// ## What this module must never import
//
// Nothing from `@solana/web3.js` (see the eslint guard over this file) and
// nothing from `lit`. DOM APIs and byte comparisons only.

/** A signed-message result. The spec allows `signedMessage !== message`. */
interface SignMessageOutput {
  signedMessage: Uint8Array;
  signature: Uint8Array;
}

interface StandardAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
  label?: string;
  icon?: string;
}

interface StandardWallet {
  name: string;
  icon?: string;
  chains: readonly string[];
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
}

/** The five features we touch, typed structurally. */
interface ConnectFeature {
  version: string;
  connect(input?: { silent?: boolean }): Promise<{
    accounts: readonly StandardAccount[];
  }>;
}
interface EventsFeature {
  version: string;
  on(
    event: "change",
    listener: (props: { accounts?: readonly StandardAccount[] }) => void,
  ): () => void;
}
interface SignMessageFeature {
  signMessage(
    ...inputs: { account: StandardAccount; message: Uint8Array }[]
  ): Promise<readonly SignMessageOutput[]>;
}
interface SignTransactionFeature {
  signTransaction(
    ...inputs: {
      account: StandardAccount;
      transaction: Uint8Array;
      chain?: string;
    }[]
  ): Promise<readonly { signedTransaction: Uint8Array }[]>;
}
interface SignAndSendFeature {
  signAndSendTransaction(
    ...inputs: {
      account: StandardAccount;
      transaction: Uint8Array;
      chain: string;
    }[]
  ): Promise<readonly { signature: Uint8Array }[]>;
}

export const CONNECT = "standard:connect";
export const EVENTS = "standard:events";
export const SIGN_MESSAGE = "solana:signMessage";
export const SIGN_TRANSACTION = "solana:signTransaction";
export const SIGN_AND_SEND = "solana:signAndSendTransaction";

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const registry = new Map<string, StandardWallet>();
const listeners = new Set<() => void>();
let mounted = false;

function notify(): void {
  for (const fn of listeners) fn();
}

/** Subscribe to registry changes. Returns an unsubscribe. */
export function onRegistryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Every wallet registered right now. Synchronous snapshot. */
export function registeredWallets(): StandardWallet[] {
  return [...registry.values()];
}

/**
 * Installs the handshake. Idempotent, and the listener is never removed.
 *
 * Synchronous on purpose: `mountWalletProvider()` runs at module scope and
 * callers read `registeredWallets()` immediately afterwards.
 */
export function mountRegistry(): void {
  if (mounted || typeof window === "undefined") return;
  mounted = true;

  const api = Object.freeze({
    register(...wallets: StandardWallet[]) {
      for (const w of wallets) registry.set(w.name, w);
      notify();
      return () => {
        for (const w of wallets) registry.delete(w.name);
        notify();
      };
    },
  });

  window.addEventListener("wallet-standard:register-wallet", (e) => {
    const detail = (e as CustomEvent<(api: unknown) => void>).detail;
    if (typeof detail === "function") detail(api);
  });
  window.dispatchEvent(
    new CustomEvent("wallet-standard:app-ready", { detail: api }),
  );
}

/** Test seam: forget every registered wallet and the mounted flag. */
export function resetRegistryForTests(): void {
  registry.clear();
  listeners.clear();
  mounted = false;
}

// ---------------------------------------------------------------------------
// Cluster
// ---------------------------------------------------------------------------

export type SolanaChain =
  | "solana:mainnet"
  | "solana:devnet"
  | "solana:testnet"
  | "solana:localnet";

/**
 * Which cluster an RPC url names, or null when it cannot be told.
 *
 * Null is a real answer, not a failure: a paid endpoint (Helius, Triton) has the
 * same hostname on devnet and mainnet. It matters because the two transaction
 * paths care differently. Sign-only does not -- we build the transaction and
 * submit it to our own RPC, so the wallet's opinion is irrelevant. Sign-and-send
 * does: the WALLET picks the RPC from the chain we pass, so guessing wrong
 * broadcasts a real transaction to the wrong cluster. Hence: null disables
 * sign-and-send rather than guessing.
 */
export function solanaChainFor(rpcUrl: string): SolanaChain | null {
  let host: string;
  try {
    host = new URL(rpcUrl).hostname;
  } catch {
    return null;
  }
  if (host === "localhost" || host === "127.0.0.1") return "solana:localnet";
  if (/(^|\.)devnet\.solana\.com$/.test(host)) return "solana:devnet";
  if (/(^|\.)testnet\.solana\.com$/.test(host)) return "solana:testnet";
  if (/(^|\.)mainnet-beta\.solana\.com$/.test(host)) return "solana:mainnet";
  return null;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * [ARENA] The wallet signed something other than what it was handed.
 *
 * Wallet Standard explicitly permits a wallet to prefix or otherwise modify a
 * message before signing, and returns `signedMessage` so the app can tell. The
 * arena cannot accept that: `core/arena/walletSignature.ts` verifies
 * `TextEncoder().encode(message)` byte for byte, with no prefix tolerance, so a
 * prefixing wallet produces a signature that is cryptographically valid and that
 * the server refuses.
 *
 * The cost of finding out late is the reason this is an error and not a warning.
 * For the per-match signature the server's refusal arrives as
 * `ws.close(1002, "invalid wallet signature")` -- and by then the stake is in the
 * vault and the escrow may already be `InProgress`, which `cancel_match` refuses
 * for 24 hours. Throwing here happens at the signing prompt, before any money
 * moves, because `WagerLobby.handleJoin` signs before it stakes.
 */
export class WalletAlteredMessageError extends Error {
  /** Suffix of the `wager_lobby.error_*` key the panel renders. */
  readonly code = "message_prefixed";
  constructor(readonly walletName: string) {
    super(`${walletName} altered the message before signing it`);
    this.name = "WalletAlteredMessageError";
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Only a `data:image/*` URI is safe to render. See pickerIcon below. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|svg\+xml|webp);base64,/;

/**
 * The wallet's icon, or "" when it offered nothing usable.
 *
 * The value comes from a browser extension, and the picker renders it as an
 * `<img src>`. A remote URL would hand the extension's author the IP and
 * referrer of every visitor who opens the picker, so only inline data is taken.
 */
export function pickerIcon(icon: string | undefined): string {
  return icon !== undefined && DATA_IMAGE.test(icon) ? icon : "";
}

function feature<T>(wallet: StandardWallet, name: string): T | null {
  const f = wallet.features[name];
  return f === undefined ? null : (f as T);
}

/** Whether an account can be used at all -- it must be able to sign messages. */
export function canSignMessage(wallet: StandardWallet): boolean {
  return (
    feature<ConnectFeature>(wallet, CONNECT) !== null &&
    feature<SignMessageFeature>(wallet, SIGN_MESSAGE) !== null
  );
}

/** Why a wallet cannot be used here. An i18n key suffix. */
export type WalletBlockReason =
  | "no_transaction_feature"
  | "wrong_cluster"
  | "alters_message";

/**
 * How this wallet can stake, or null.
 *
 * Sign-only is preferred wherever it exists, because `onchainJoin.ts` submits the
 * transaction itself to keep control of confirmation and to surface the
 * program's error from preflight.
 *
 * Note the deliberate asymmetry in chain checking. Sign-only does NOT require
 * `account.chains` to list our cluster: wallets under-report it -- several claim
 * only `solana:mainnet` for accounts they will happily sign devnet transactions
 * with -- and since we submit the bytes ourselves, a strict filter would exclude
 * working wallets to enforce a preference the protocol does not. The `chain`
 * argument is optional in the spec for exactly this reason, so it is passed only
 * when the account claims it. Sign-and-send is the opposite: the wallet chooses
 * the RPC from that argument, so an unclaimed or unknown cluster disables it.
 */
export function negotiateSubmit(
  wallet: StandardWallet,
  account: StandardAccount,
  chain: SolanaChain | null,
):
  | { submit: StakeSubmitImpl; blocked: null }
  | { submit: null; blocked: WalletBlockReason } {
  const signOnly = feature<SignTransactionFeature>(wallet, SIGN_TRANSACTION);
  if (signOnly !== null) {
    const hint =
      chain !== null && account.chains.includes(chain) ? chain : undefined;
    return {
      submit: {
        kind: "sign",
        signTransaction: async (transaction) => {
          const [out] = await signOnly.signTransaction(
            hint === undefined
              ? { account, transaction }
              : { account, transaction, chain: hint },
          );
          return out.signedTransaction;
        },
      },
      blocked: null,
    };
  }

  const sendable = feature<SignAndSendFeature>(wallet, SIGN_AND_SEND);
  if (sendable === null)
    return { submit: null, blocked: "no_transaction_feature" };
  if (chain === null || !account.chains.includes(chain)) {
    return { submit: null, blocked: "wrong_cluster" };
  }
  return {
    submit: {
      kind: "signAndSend",
      signAndSend: async (transaction) => {
        const [out] = await sendable.signAndSendTransaction({
          account,
          transaction,
          chain,
        });
        return base58(out.signature);
      },
    },
    blocked: null,
  };
}

/** Mirrors WalletProvider's StakeSubmit; declared here to avoid a cycle. */
type StakeSubmitImpl =
  | { kind: "sign"; signTransaction(t: Uint8Array): Promise<Uint8Array> }
  | { kind: "signAndSend"; signAndSend(t: Uint8Array): Promise<string> };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * base58 of raw bytes.
 *
 * Hand-rolled for the same reason `toBase64` is: `bs58` is present in
 * node_modules only as a hoisted transitive of @solana/web3.js, which does not
 * re-export it, so using it would be depending on hoisting. Needed because
 * `solana:signAndSendTransaction` returns the signature as bytes while
 * `confirmTransaction` and `ClientJoinMessage.onchainTxSig` want the string.
 */
export function base58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // `digits` is little-endian and always holds at least one element, so the
  // value zero arrives here as [0]. Emitting that would double-count: a leading
  // zero BYTE is already one "1", and canonical base58 of a single zero byte is
  // "1", not "11" -- and of no bytes at all is "", not "1".
  let top = digits.length - 1;
  while (top > 0 && digits[top] === 0) top--;
  const significant = digits[top] === 0 ? -1 : top;

  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = significant; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** What the provider needs to build a WalletAdapter, without importing it. */
export interface StandardAdapterParts {
  publicKey: string;
  name: string;
  icon: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  submit: StakeSubmitImpl | null;
  blocked: WalletBlockReason | null;
  /** Unsubscribe from this wallet's change events. */
  off(): void;
}

/**
 * Builds the adapter parts for one connected account.
 *
 * `onAccountsChanged` is handed straight through rather than handled here: what
 * to do about a mid-match account switch is a session question, and the session
 * predicate lives with the provider.
 */
export function adaptStandardWallet(
  wallet: StandardWallet,
  account: StandardAccount,
  chain: SolanaChain | null,
  onAccountsChanged: (accounts: readonly StandardAccount[]) => void,
): StandardAdapterParts {
  const signer = feature<SignMessageFeature>(wallet, SIGN_MESSAGE);
  const events = feature<EventsFeature>(wallet, EVENTS);
  const negotiated = negotiateSubmit(wallet, account, chain);

  const off =
    events?.on("change", (props) => {
      if (props.accounts !== undefined) onAccountsChanged(props.accounts);
    }) ?? (() => {});

  return {
    publicKey: account.address,
    name: wallet.name,
    icon: pickerIcon(wallet.icon),
    signMessage: async (message) => {
      if (signer === null)
        throw new Error(`${wallet.name} cannot sign messages`);
      const [out] = await signer.signMessage({ account, message });
      // THE CHECK. See WalletAlteredMessageError: the server verifies these
      // exact bytes, so a wallet that signed anything else has produced a
      // signature that will be refused after the stake has already been paid.
      if (!bytesEqual(out.signedMessage, message)) {
        throw new WalletAlteredMessageError(wallet.name);
      }
      return out.signature;
    },
    submit: negotiated.submit,
    blocked: negotiated.blocked,
    off,
  };
}

/**
 * Calls `standard:connect`, returning whatever accounts the wallet authorized.
 *
 * `silent: true` asks for already-authorized accounts with no prompt -- the
 * Wallet Standard equivalent of Phantom's `onlyIfTrusted`, and what makes a
 * reload not re-prompt. A wallet that does not implement silent connect is
 * permitted to prompt anyway, which is why the caller reads `wallet.accounts`
 * first and only falls through to here when it is empty.
 *
 * The feature lookup lives in this module rather than the provider so that
 * `features` is read in exactly one place.
 */
export async function connectStandard(
  wallet: StandardWallet,
  opts?: { silent?: boolean },
): Promise<readonly StandardAccount[]> {
  const connect = feature<ConnectFeature>(wallet, CONNECT);
  if (connect === null) return [];
  const { accounts } = await connect.connect(opts);
  return accounts;
}

/** The account to use from a connect result: the first one, if any. */
export function pickAccount(
  accounts: readonly StandardAccount[],
): StandardAccount | undefined {
  return accounts[0];
}

export type { ConnectFeature, StandardAccount, StandardWallet };
