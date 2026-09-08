// @vitest-environment node
//
// [ARENA] The browser half of `/auth/wallet`.
//
// The headline assertion is the domain separation. A wallet signature is a
// bearer credential for whatever it was signed over, so if the login message
// and the per-match message ever converged, a signature captured from a wagered
// join would become a candidate login — someone else's session, from a
// signature they were asked for to play a game. `AuthService.test.ts` pins that
// the server refuses a match signature as a login; this pins that the client
// never produces one in the first place.
//
// Verified against the server's REAL verifier rather than a reimplementation of
// it, for the same reason ArenaWalletAuth.test.ts does: a test that agrees with
// a copy of the server's logic proves only that the copy is self-consistent.
//
// node, not the repo's jsdom default: tweetnacl and PublicKey are real here, and
// jsdom's TextEncoder is a different realm whose Uint8Array fails tweetnacl's
// instanceof check.
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authMessage,
  walletLoginMessage,
} from "../../src/core/arena/authMessage";
import { verifyEd25519Signature } from "../../src/core/arena/walletSignature";

const NONCE = "challenge-nonce-abc123";
const CHALLENGE = "opaque.challenge.jwt";

/** The throwaway wallet the mocked provider signs with. */
let keypair: nacl.SignKeyPair;
let address: string;
/** Captured `adoptSession` calls, so a test can assert the session was installed. */
let adopted: { jwt: string; expiresIn: number }[];
let signCalls: string[];

/**
 * Loads walletLogin with the wallet, auth and API modules mocked.
 *
 * `connected` false makes getConnectedWallet() return null so the module has to
 * go through connectWallet(), which is the path a first-time login takes.
 */
async function loadWalletLogin(opts: {
  connected?: boolean;
  connectThrows?: unknown;
  signThrows?: unknown;
  fetchImpl: typeof fetch;
}) {
  const wallet = {
    publicKey: address,
    signMessage: async (msg: Uint8Array) => {
      if (opts.signThrows !== undefined) throw opts.signThrows;
      // Uint8Array.from: keeps the bytes in this realm for tweetnacl.
      const bytes = Uint8Array.from(msg);
      signCalls.push(new TextDecoder().decode(bytes));
      return nacl.sign.detached(bytes, keypair.secretKey);
    },
    signTransaction: async (t: unknown) => t,
    disconnect: async () => {},
  };

  vi.resetModules();
  vi.doMock("../../src/client/arena/WalletProvider", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/client/arena/WalletProvider")
    >("../../src/client/arena/WalletProvider");
    return {
      // toBase64 is the real one: it is what turns the signature into the
      // string the server parses, so mocking it would skip the encoding this
      // test exists to check end to end.
      toBase64: actual.toBase64,
      getConnectedWallet: () => (opts.connected === true ? wallet : null),
      connectWallet: async () => {
        if (opts.connectThrows !== undefined) throw opts.connectThrows;
        return wallet;
      },
    };
  });
  vi.doMock("../../src/client/Auth", () => ({
    adoptSession: (jwt: string, expiresIn: number) =>
      adopted.push({ jwt, expiresIn }),
  }));
  vi.doMock("../../src/client/Api", () => ({
    getApiBase: () => "https://api.example.test",
    invalidateUserMe: () => {},
  }));
  vi.stubGlobal("fetch", opts.fetchImpl);

  return import("../../src/client/arena/walletLogin");
}

/** A service that hands out a challenge and accepts the exchange. */
function happyFetch(): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/auth/wallet/challenge")) {
      return new Response(
        JSON.stringify({ nonce: NONCE, challenge: CHALLENGE, expiresIn: 300 }),
        { status: 200 },
      );
    }
    if (href.endsWith("/auth/wallet")) {
      lastExchangeBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      lastExchangeInit = init;
      return new Response(
        JSON.stringify({ jwt: "minted.jwt.here", expiresIn: 900 }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;
}

let lastExchangeBody: Record<string, unknown> | null;
let lastExchangeInit: RequestInit | undefined;

// The module reads document.body/querySelector to refuse a login that would
// swap the session out from under a running match. There is no DOM in this
// environment, so stand up the smallest one that answers those two questions.
function stubDom(opts: { inGame?: boolean; stakeOverlay?: boolean } = {}) {
  vi.stubGlobal("document", {
    body: {
      classList: { contains: (c: string) => c === "in-game" && !!opts.inGame },
    },
    querySelector: (sel: string) =>
      sel === ".arena-wager-overlay" && opts.stakeOverlay ? {} : null,
  });
}

describe("[ARENA] wallet login, browser half", () => {
  beforeEach(() => {
    keypair = nacl.sign.keyPair();
    address = new PublicKey(keypair.publicKey).toBase58();
    adopted = [];
    signCalls = [];
    lastExchangeBody = null;
    lastExchangeInit = undefined;
    stubDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("signs the LOGIN message, and produces something that is not a match signature", async () => {
    // The pin. Both halves matter: the signature must verify as a login, and
    // must NOT verify as the per-match binding. A single shared prefix would
    // make both of these pass in the wrong direction.
    const { walletLogin } = await loadWalletLogin({ fetchImpl: happyFetch() });

    const result = await walletLogin();

    expect(result.walletAddress).toBe(address);
    expect(signCalls).toEqual([walletLoginMessage(NONCE)]);

    const signature = lastExchangeBody!.signature as string;
    expect(
      verifyEd25519Signature(walletLoginMessage(NONCE), address, signature),
    ).toBe(true);
    expect(verifyEd25519Signature(authMessage(NONCE), address, signature)).toBe(
      false,
    );
  });

  it("sends the address and the opaque challenge, with the cookie", async () => {
    const { walletLogin } = await loadWalletLogin({ fetchImpl: happyFetch() });
    await walletLogin();

    expect(lastExchangeBody).toMatchObject({
      walletAddress: address,
      challenge: CHALLENGE,
    });
    // Without credentials the refresh cookie is never set and the session dies
    // at the access token's 15-minute expiry.
    expect(lastExchangeInit?.credentials).toBe("include");
  });

  it("installs the minted session", async () => {
    const { walletLogin } = await loadWalletLogin({ fetchImpl: happyFetch() });
    await walletLogin();

    expect(adopted).toEqual([{ jwt: "minted.jwt.here", expiresIn: 900 }]);
  });

  it("reports a missing extension distinctly, so the UI can offer an install link", async () => {
    const { walletLogin, WalletLoginError } = await loadWalletLogin({
      fetchImpl: happyFetch(),
      connectThrows: new Error("No Solana wallet found. Install Phantom"),
    });

    await expect(walletLogin()).rejects.toMatchObject({
      name: "WalletLoginError",
      reason: "no-wallet",
    });
    expect(WalletLoginError).toBeTypeOf("function");
  });

  it("treats a declined signature as a choice, not a fault", async () => {
    const rejection = Object.assign(new Error("User rejected the request."), {
      code: 4001,
    });
    const { walletLogin } = await loadWalletLogin({
      fetchImpl: happyFetch(),
      signThrows: rejection,
    });

    await expect(walletLogin()).rejects.toMatchObject({ reason: "rejected" });
    expect(adopted).toEqual([]);
  });

  it("tells an expired challenge apart from a refusal", async () => {
    // The challenge lives five minutes. Someone who leaves the wallet prompt
    // open longer should be told to try again, not that they were rejected.
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith("/auth/wallet/challenge")) {
        return new Response(
          JSON.stringify({ nonce: NONCE, challenge: CHALLENGE }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "invalid_challenge" }), {
        status: 401,
      });
    }) as unknown as typeof fetch;

    const { walletLogin } = await loadWalletLogin({ fetchImpl });

    await expect(walletLogin()).rejects.toMatchObject({
      reason: "challenge-failed",
    });
  });

  it("refuses to swap the session during a match", async () => {
    // The objection docs/Auth.md recorded: logging in swaps `sub`, hence the
    // persistentID, hence any walletRegistry binding for a live match.
    stubDom({ inGame: true });
    const { walletLogin } = await loadWalletLogin({ fetchImpl: happyFetch() });

    await expect(walletLogin()).rejects.toMatchObject({ reason: "busy" });
    expect(signCalls).toEqual([]);
  });

  it("refuses to swap the session while the stake prompt is open", async () => {
    // A `jti` has already been signed over by this point; re-minting the access
    // token would invalidate that signature after the stake was submitted.
    stubDom({ stakeOverlay: true });
    const { walletLogin } = await loadWalletLogin({ fetchImpl: happyFetch() });

    await expect(walletLogin()).rejects.toMatchObject({ reason: "busy" });
    expect(signCalls).toEqual([]);
  });
});
