// @vitest-environment node
// [ARENA] A wallet login stands in for the per-match wallet signature.
//
// A player signed in with their wallet used to be prompted twice per wagered
// game: a message signature proving the wallet was this session's, then the
// stake. The login already proved the first, so the server now accepts a
// session whose `sub` is the id derived from the staked address -- and the
// browser skips the prompt when its token is exactly that.
//
// What must hold is that the shortcut is only ever taken for *that* wallet's
// login: not a guest, not a login for another wallet. Node environment because
// the client half hashes with crypto.subtle, and jsdom's TextEncoder output is
// a foreign-realm array (see AuthService.test.ts).

import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { walletUserId } from "../src/auth/identity";
import type { TokenPayload } from "../src/core/ApiSchemas";
import { uuidToBase64url } from "../src/core/Base64";
import { sessionIsWalletLogin } from "../src/server/arena/auth";

const ADDRESS = "5miqxq62Qs3Ruc7FpyEYQuz8QWEa3Dmh9p18z7y9VdZM";
const OTHER = "CtVDnzfPa4TDGLv886X3FJkbzZz5LXt9RpLHWNMtsJLe";

function claims(provider: string, address: string): TokenPayload {
  return { provider, sub: walletUserId(address), jti: "j" } as TokenPayload;
}

/** JWT-shaped; only the payload is read client-side. */
function token(payload: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "EdDSA" })}.${enc(payload)}.sig`;
}

function loginToken(provider: string, address: string): string {
  return token({
    provider,
    sub: uuidToBase64url(walletUserId(address)),
    jti: "session-nonce",
  });
}

describe("the wallet identity derivation", () => {
  it("is unchanged by moving it into core", () => {
    // Computed from the derivation as it stood in auth/identity.ts before the
    // move. A different value here renames every wallet player there is, and
    // would make every wallet session fall back to the signature prompt.
    expect(walletUserId(ADDRESS)).toBe("cc776dce-11ce-8511-941f-eed58369c0e5");
  });
});

describe("server: sessionIsWalletLogin", () => {
  it("accepts a wallet login for the staked address", () => {
    expect(sessionIsWalletLogin(claims("wallet", ADDRESS), ADDRESS)).toBe(true);
  });

  it("refuses a wallet login for a different address", () => {
    // Signed in as one wallet, staking from another: the login proves nothing
    // about the second, so it has to be signed for.
    expect(sessionIsWalletLogin(claims("wallet", OTHER), ADDRESS)).toBe(false);
  });

  it("refuses a session the issuer did not mark as a wallet login", () => {
    expect(sessionIsWalletLogin(claims("guest", ADDRESS), ADDRESS)).toBe(false);
    expect(
      sessionIsWalletLogin(
        { sub: walletUserId(ADDRESS), jti: "j" } as TokenPayload,
        ADDRESS,
      ),
    ).toBe(false);
  });

  it("refuses an anonymous dev session", () => {
    expect(sessionIsWalletLogin(null, ADDRESS)).toBe(false);
  });
});

describe("client: isWalletLoginFor", () => {
  it("agrees with the server on the same session", async () => {
    const { isWalletLoginFor } = await import("../src/client/arena/walletAuth");
    expect(await isWalletLoginFor(loginToken("wallet", ADDRESS), ADDRESS)).toBe(
      true,
    );
    expect(await isWalletLoginFor(loginToken("wallet", OTHER), ADDRESS)).toBe(
      false,
    );
    expect(await isWalletLoginFor(loginToken("guest", ADDRESS), ADDRESS)).toBe(
      false,
    );
  });

  it("is a plain no for anything that is not a JWT", async () => {
    const { isWalletLoginFor } = await import("../src/client/arena/walletAuth");
    // Dev's bare persistentID.
    expect(
      await isWalletLoginFor("0f9a8b7c-6d5e-4f3a-2b1c-0d9e8f7a6b5c", ADDRESS),
    ).toBe(false);
    expect(
      await isWalletLoginFor(token({ provider: "wallet", sub: "!!" }), ADDRESS),
    ).toBe(false);
  });
});

describe("client: proveWallet", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../src/client/arena/WalletProvider");
  });

  /** A connected wallet at a real address, counting signature prompts. */
  function mockWallet() {
    // The describe above already imported walletAuth against the real
    // WalletProvider; a cached copy would ignore this mock.
    vi.resetModules();
    const kp = nacl.sign.keyPair();
    const address = new PublicKey(kp.publicKey).toBase58();
    const signMessage = vi.fn(async (msg: Uint8Array) =>
      nacl.sign.detached(Uint8Array.from(msg), kp.secretKey),
    );
    vi.doMock("../src/client/arena/WalletProvider", async () => ({
      toBase64: (
        await vi.importActual<
          typeof import("../src/client/arena/WalletProvider")
        >("../src/client/arena/WalletProvider")
      ).toBase64,
      getConnectedWallet: () => ({ publicKey: address, signMessage }),
      connectWallet: async () => {
        throw new Error("should not need to connect");
      },
    }));
    return { address, signMessage };
  }

  it("does not prompt a player signed in with the wallet they stake from", async () => {
    const { address, signMessage } = mockWallet();
    const { proveWallet } = await import("../src/client/arena/walletAuth");

    const proof = await proveWallet(loginToken("wallet", address), "game1");

    expect(signMessage).not.toHaveBeenCalled();
    expect(proof).toEqual({ walletAddress: address });
  });

  it("still prompts a guest", async () => {
    const { address, signMessage } = mockWallet();
    const { proveWallet } = await import("../src/client/arena/walletAuth");

    const proof = await proveWallet(loginToken("guest", address), "game1");

    expect(signMessage).toHaveBeenCalledOnce();
    expect(proof.walletSig).toEqual(expect.any(String));
  });

  it("still prompts a player signed in with a different wallet", async () => {
    const { signMessage } = mockWallet();
    const { proveWallet } = await import("../src/client/arena/walletAuth");

    const proof = await proveWallet(loginToken("wallet", OTHER), "game1");

    expect(signMessage).toHaveBeenCalledOnce();
    expect(proof.walletSig).toEqual(expect.any(String));
  });
});
