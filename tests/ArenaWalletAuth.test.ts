// [ARENA] Pins the two ends of the wallet-auth handshake against each other.
//
// The client signs a message and the server verifies it; if they disagree by a
// single byte the only symptom is an "invalid wallet signature" disconnect with
// nothing to indicate which side is wrong. That is worth a test on its own, and
// doubly so now that the nonce has two sources (the JWT's jti, or the dev
// substitute) which both sides have to choose identically.

import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../src/client/ClientEnv";
import { authMessage, devAuthNonce } from "../src/core/arena/authMessage";
import { GameEnv } from "../src/core/configuration/Config";
import { verifyWalletSig, walletAuthNonce } from "../src/server/arena/auth";

// The server's real verifier, not a reimplementation of it — otherwise this
// would only prove the client agrees with a copy of the server's logic.
// verifyWalletSig takes a base58 address, so the throwaway ed25519 key is
// wrapped in a PublicKey to reach it the way a real wallet address would.
function verify(nonce: string, walletKey: Uint8Array, sigBase64: string) {
  return verifyWalletSig(nonce, new PublicKey(walletKey).toBase58(), sigBase64);
}

const GAME_ID = "abcd1234";

function setEnv(gameEnv: "dev" | "prod") {
  (window as any).BOOTSTRAP_CONFIG = {
    gameEnv,
    numWorkers: 1,
    turnstileSiteKey: "x",
    jwtAudience: "localhost",
    instanceId: "desktop",
    gitCommit: "test",
  };
  ClientEnv.reset();
}

/** Stands in for the injected wallet: signs with a throwaway ed25519 key. */
function mockWallet() {
  const kp = nacl.sign.keyPair();
  vi.doMock("../src/client/arena/WalletProvider", () => ({
    getConnectedWallet: () => ({
      publicKey: "unused-in-these-assertions",
      // Uint8Array.from: jsdom's TextEncoder returns an array from another
      // realm, which tweetnacl's instanceof check rejects. Real wallets get a
      // structured clone across the extension bridge, so this is a test
      // artifact rather than something production has to handle.
      signMessage: async (msg: Uint8Array) =>
        nacl.sign.detached(Uint8Array.from(msg), kp.secretKey),
      signTransaction: async (tx: unknown) => tx,
      disconnect: async () => {},
    }),
    connectWallet: async () => {
      throw new Error("should not need to connect");
    },
  }));
  return kp;
}

/** A JWT-shaped token. Only the payload is read; the signature is the server's job. */
function tokenWithJti(jti: string): string {
  const payload = btoa(JSON.stringify({ jti, sub: "someone" }));
  return `header.${payload}.signature`;
}

afterEach(() => {
  delete (window as any).BOOTSTRAP_CONFIG;
  ClientEnv.reset();
  vi.resetModules();
  vi.doUnmock("../src/client/arena/WalletProvider");
});

describe("arena wallet auth", () => {
  it("signs over the jti when the session has a JWT", async () => {
    setEnv("prod");
    const kp = mockWallet();
    const { signAuthMessage: sign } =
      await import("../src/client/arena/walletAuth");

    const { walletSig } = await sign(tokenWithJti("session-nonce"), GAME_ID);

    expect(verify("session-nonce", kp.publicKey, walletSig)).toBe(true);
    // Not the dev nonce: a real session must be bound to the session, not the
    // match, or one signature would be replayable across every lobby.
    expect(verify(devAuthNonce(GAME_ID), kp.publicKey, walletSig)).toBe(false);
  });

  it("falls back to the game id for anonymous dev sessions", async () => {
    setEnv("dev");
    const kp = mockWallet();
    const { signAuthMessage: sign } =
      await import("../src/client/arena/walletAuth");

    // What getPlayToken() returns with no account: a bare persistentID, which
    // is not a JWT and carries no jti.
    const { walletSig } = await sign(
      "0f9a8b7c-6d5e-4f3a-2b1c-0d9e8f7a6b5c",
      GAME_ID,
    );

    expect(verify(devAuthNonce(GAME_ID), kp.publicKey, walletSig)).toBe(true);
    // Still bound to this match, so a dev signature is not a universal key.
    expect(verify(devAuthNonce("other-game"), kp.publicKey, walletSig)).toBe(
      false,
    );
  });

  it("refuses to prompt the wallet at all when a prod session has no jti", async () => {
    setEnv("prod");
    mockWallet();
    const { signAuthMessage: sign } =
      await import("../src/client/arena/walletAuth");

    // The bypass is dev-only. Failing before the wallet prompt means the player
    // is never asked to sign something the server is going to reject.
    await expect(
      sign("0f9a8b7c-6d5e-4f3a-2b1c-0d9e8f7a6b5c", GAME_ID),
    ).rejects.toThrow(/sign in/i);
  });

  it("keeps the canonical message stable", () => {
    // The prefix is the contract between two files that never import each
    // other's copy any more. Freeze it so a reformat cannot quietly change it.
    expect(authMessage("nonce-1")).toBe("OpenFront Arena\nAuth: nonce-1");
    expect(devAuthNonce(GAME_ID)).toBe(`dev-game:${GAME_ID}`);
  });

  it("exposes dev only through GameEnv.Dev", () => {
    setEnv("dev");
    expect(ClientEnv.env()).toBe(GameEnv.Dev);
    setEnv("prod");
    expect(ClientEnv.env()).not.toBe(GameEnv.Dev);
  });

  it("server-side, the nonce prefers jti and only then falls back", () => {
    // The server half of the same choice the client makes above. Both must pick
    // identically or the signature verifies against the wrong message.
    expect(walletAuthNonce({ jti: "session-nonce" } as never, GAME_ID)).toBe(
      "session-nonce",
    );
    // ServerEnv reads GAME_ENV at import time and vitest runs as dev, so this
    // exercises the bypass branch. The prod branch is covered by the client
    // test above, which is the side that refuses first.
    expect(walletAuthNonce(null, GAME_ID)).toBe(devAuthNonce(GAME_ID));
  });
});
