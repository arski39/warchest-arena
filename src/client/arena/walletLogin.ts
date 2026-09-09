// [ARENA] The browser half of `/auth/wallet`.
//
// The server half has existed and been tested since the auth service landed;
// `docs/Auth.md` recorded that it had no caller. This is that caller. A wallet
// is the only identity this site actually needs — it is what pays and what gets
// paid — and the Discord/Google/email buttons inherited from upstream point at
// endpoints this fork's auth service returns 404 for.
//
// ## What this must not import
//
// Logging in is pure ed25519 message signing. It needs no `Connection`, no
// `PublicKey`, no instruction building — so it must not import `onchainJoin.ts`,
// `core/arena/arenaProgram.ts` or `core/arena/walletSignature.ts`, each of which
// drags in `@solana/web3.js` (294 kB). `WalletProvider.ts` is safe and is
// already in the main chunk at zero cost: its only web3.js reference is an
// `import type`.
//
// AccountModal imports this dynamically anyway, so it costs nothing until
// somebody opens the sign-in screen — but the rule above is what keeps that
// true. A static import of any of those three from here would put the whole
// Solana client behind a button, and the size would not show up in the stake
// chunk where the existing check looks for it.
//
// ## Why the message is built here and never fetched
//
// `GET /auth/wallet/challenge` deliberately returns the nonce and NOT the text
// to sign, so a spoofed or compromised service cannot talk a wallet into signing
// arbitrary bytes. `walletLoginMessage()` uses a prefix deliberately distinct
// from the per-match `authMessage()`, so a captured match signature can never be
// replayed as a login. `tests/server/AuthService.test.ts` pins the server side
// of that; `tests/client/ArenaWalletLogin.test.ts` pins this side.
import { walletLoginMessage } from "../../core/arena/authMessage";
import { getApiBase, invalidateUserMe } from "../Api";
import { adoptSession } from "../Auth";
import {
  connectWallet,
  getConnectedWallet,
  toBase64,
  type WalletAdapter,
} from "./WalletProvider";
import { rememberWalletAddress } from "./walletSession";

/** Why a login attempt did not produce a session. */
export type WalletLoginFailure =
  /** No wallet extension is installed. */
  | "no-wallet"
  /** The player declined the connection or the signature. */
  | "rejected"
  /** The challenge could not be obtained, or had expired by the time we sent it. */
  | "challenge-failed"
  /** The service rejected the signature. */
  | "refused"
  /** A session is bound to something right now and must not be swapped. */
  | "busy"
  /** The service could not be reached. */
  | "network";

export class WalletLoginError extends Error {
  constructor(
    readonly reason: WalletLoginFailure,
    message: string,
  ) {
    super(message);
    this.name = "WalletLoginError";
  }
}

/**
 * Phantom and friends surface a user-declined prompt as a `4001` code, matching
 * EIP-1193. Treated as an ordinary outcome rather than an error worth shouting
 * about: someone changing their mind at the wallet prompt is not a fault.
 */
function isUserRejection(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (code === 4001 || code === "4001") return true;
  const message = (e as { message?: unknown }).message;
  return typeof message === "string" && /reject|denied|cancel/i.test(message);
}

/**
 * Whether logging in right now would pull the session out from under something
 * already bound to it.
 *
 * This is the objection `docs/Auth.md` recorded as the reason wallet login was
 * deferred: a guest→wallet upgrade swaps `sub`, and therefore the persistentID,
 * and therefore any `walletRegistry` binding and any in-flight `jti`-bound match
 * signature. Restricting login to the menu dissolves it rather than managing it
 * — at the menu there is nothing bound yet.
 *
 * Both checks read the DOM rather than importing from `Main.ts`: `src/client`'s
 * entry module owns the game lifecycle and importing it here would be a cycle.
 * `in-game` is set and cleared by `Main.ts` around a running match;
 * `arena-wager-overlay` is the stake prompt, during which a `jti` has already
 * been signed over.
 */
function sessionIsBound(): boolean {
  return (
    document.body.classList.contains("in-game") ||
    document.querySelector(".arena-wager-overlay") !== null
  );
}

async function fetchChallenge(): Promise<{ nonce: string; challenge: string }> {
  let response: Response;
  try {
    response = await fetch(getApiBase() + "/auth/wallet/challenge", {
      credentials: "include",
    });
  } catch {
    throw new WalletLoginError("network", "Could not reach the login service.");
  }
  if (!response.ok) {
    throw new WalletLoginError(
      "challenge-failed",
      `Login service returned ${response.status}.`,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  const nonce = (body as { nonce?: unknown } | null)?.nonce;
  const challenge = (body as { challenge?: unknown } | null)?.challenge;
  if (typeof nonce !== "string" || typeof challenge !== "string") {
    throw new WalletLoginError(
      "challenge-failed",
      "Login service returned a malformed challenge.",
    );
  }
  return { nonce, challenge };
}

/**
 * Connects a wallet if needed, signs the service's challenge, and exchanges it
 * for a session. Resolves with the address now signed in.
 *
 * Throws `WalletLoginError` for every failure, so a caller can tell "no
 * extension installed" (offer an install link) from "they changed their mind"
 * (say nothing) from "the service refused" (a real problem).
 */
export async function walletLogin(): Promise<{ walletAddress: string }> {
  if (sessionIsBound()) {
    throw new WalletLoginError(
      "busy",
      "Finish or leave the current match before switching wallets.",
    );
  }

  let wallet: WalletAdapter;
  try {
    wallet = getConnectedWallet() ?? (await connectWallet());
  } catch (e) {
    if (isUserRejection(e)) {
      throw new WalletLoginError("rejected", "Wallet connection was declined.");
    }
    // connectWallet()'s own "no wallet found" is the only other throw here.
    throw new WalletLoginError(
      "no-wallet",
      e instanceof Error ? e.message : String(e),
    );
  }

  const { nonce, challenge } = await fetchChallenge();

  let signature: string;
  try {
    const message = new TextEncoder().encode(walletLoginMessage(nonce));
    signature = toBase64(await wallet.signMessage(message));
  } catch (e) {
    if (isUserRejection(e)) {
      throw new WalletLoginError("rejected", "Signature was declined.");
    }
    throw new WalletLoginError(
      "rejected",
      e instanceof Error ? e.message : String(e),
    );
  }

  let response: Response;
  try {
    response = await fetch(getApiBase() + "/auth/wallet", {
      method: "POST",
      // The refresh cookie is set on this response; without credentials the
      // session would last only until the access token expired.
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: wallet.publicKey,
        challenge,
        signature,
      }),
    });
  } catch {
    throw new WalletLoginError("network", "Could not reach the login service.");
  }

  if (!response.ok) {
    // invalid_challenge is the one worth distinguishing: the challenge is good
    // for five minutes, and someone who leaves the wallet prompt open longer
    // than that should be told to try again rather than that they were refused.
    const body: unknown = await response.json().catch(() => null);
    const error = (body as { error?: unknown } | null)?.error;
    if (error === "invalid_challenge") {
      throw new WalletLoginError(
        "challenge-failed",
        "That login request expired. Try again.",
      );
    }
    throw new WalletLoginError(
      "refused",
      typeof error === "string" ? error : `Login failed (${response.status}).`,
    );
  }

  const body: unknown = await response.json().catch(() => null);
  const jwt = (body as { jwt?: unknown } | null)?.jwt;
  const expiresIn = (body as { expiresIn?: unknown } | null)?.expiresIn;
  if (typeof jwt !== "string" || typeof expiresIn !== "number") {
    throw new WalletLoginError(
      "refused",
      "Login service returned a malformed session.",
    );
  }

  adoptSession(jwt, expiresIn);
  // The token says `wallet` but carries no address, and the extension may not
  // have re-connected by the time the next page load renders. Remember it, or a
  // real session has nothing to display itself with.
  rememberWalletAddress(wallet.publicKey);
  // The cached /users/@me belongs to the guest we just stopped being.
  invalidateUserMe();
  return { walletAddress: wallet.publicKey };
}
