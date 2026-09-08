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

function setEnv(gameEnv: "dev" | "prod", arenaDevBypass = false) {
  (window as any).BOOTSTRAP_CONFIG = {
    gameEnv,
    numWorkers: 1,
    turnstileSiteKey: "x",
    jwtAudience: "localhost",
    instanceId: "desktop",
    gitCommit: "test",
    // [ARENA] The server's *resolved* answer, not something the client infers.
    // Being in dev is no longer sufficient — the server also needs
    // ARENA_DEV_BYPASS set and a cluster it can prove is not mainnet.
    arenaDevBypass,
  };
  ClientEnv.reset();
}

/** Stands in for the injected wallet: signs with a throwaway ed25519 key. */
function mockWallet() {
  const kp = nacl.sign.keyPair();
  vi.doMock("../src/client/arena/WalletProvider", async () => ({
    // [ARENA] The real encoder. It moved here from walletAuth.ts when wallet
    // login needed it too, and it is what turns the signature into the string
    // the server parses — stubbing it would skip the encoding these assertions
    // run through.
    toBase64: (
      await vi.importActual<
        typeof import("../src/client/arena/WalletProvider")
      >("../src/client/arena/WalletProvider")
    ).toBase64,
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

  it("falls back to the game id when the server says the bypass is on", async () => {
    setEnv("dev", true);
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

    // Failing before the wallet prompt means the player is never asked to sign
    // something the server is going to reject.
    await expect(
      sign("0f9a8b7c-6d5e-4f3a-2b1c-0d9e8f7a6b5c", GAME_ID),
    ).rejects.toThrow(/sign in/i);
  });

  it("refuses in dev too when the server has the bypass off", async () => {
    // The case that made this flag necessary. A dev client that assumed dev
    // implies bypass would prompt the wallet, get a signature over the game id,
    // and have the server reject it as unauthorised — a confusing disconnect
    // after an interaction the player should never have been asked for.
    setEnv("dev", false);
    mockWallet();
    const { signAuthMessage: sign } =
      await import("../src/client/arena/walletAuth");

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

  it("the bypass flag is independent of the environment", () => {
    // They were the same thing before Phase 2, and conflating them is exactly
    // what let a dev server pointed at a real cluster seat unpaid players.
    setEnv("dev", false);
    expect(ClientEnv.env()).toBe(GameEnv.Dev);
    expect(ClientEnv.arenaDevBypass()).toBe(false);
  });

  it("defaults the bypass off when the server sends no flag at all", () => {
    // An older shell, or a render that forgot the variable. Absent must never
    // read as permission.
    (window as any).BOOTSTRAP_CONFIG = {
      gameEnv: "dev",
      numWorkers: 1,
      turnstileSiteKey: "x",
      jwtAudience: "localhost",
      instanceId: "desktop",
      gitCommit: "test",
    };
    ClientEnv.reset();
    expect(ClientEnv.arenaDevBypass()).toBe(false);
  });

  it("server-side, the nonce always prefers a real jti", () => {
    // The server half of the same choice the client makes above. Both must pick
    // identically or the signature verifies against the wrong message. The
    // fallback branch depends on the resolved bypass and is covered in
    // tests/server/ArenaDevBypass.test.ts, which can mock the cluster.
    expect(walletAuthNonce({ jti: "session-nonce" } as never, GAME_ID)).toBe(
      "session-nonce",
    );
  });
});
