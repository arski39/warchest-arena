// @vitest-environment node
//
// Node, not the repo-wide jsdom default. This suite mints real JWTs and real
// ed25519 signatures, and both jose and tweetnacl type-check with instanceof:
// under jsdom the TextEncoder is a different realm, so every sign() fails with
// "payload must be an instance of Uint8Array". The service itself only ever
// runs in Node, so testing it there is also the honest environment.
import { Keypair } from "@solana/web3.js";
import type { Server } from "http";
import { decodeJwt } from "jose";
import nacl from "tweetnacl";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { makeOriginPredicate, REFRESH_COOKIE } from "../../src/auth/http";
import { publicIdFor, walletUserId } from "../../src/auth/identity";
import { createAuthApp } from "../../src/auth/routes";
import { loadSigningKey, type AuthSigningKey } from "../../src/auth/signingKey";
import {
  mintAccessToken,
  refreshAudience,
  type TokenIssuerConfig,
} from "../../src/auth/tokens";
import {
  TokenPayloadSchema,
  UserMeResponseSchema,
} from "../../src/core/ApiSchemas";
import {
  authMessage,
  walletLoginMessage,
} from "../../src/core/arena/authMessage";
import { PersistentIdSchema } from "../../src/core/Schemas";
import { verifyClientToken } from "../../src/server/jwt";
import { JwksSchema, ServerEnv } from "../../src/server/ServerEnv";

// The issuer both the game server and the browser compute for DOMAIN=localhost
// (ServerEnv.jwtIssuer / ClientEnv.jwtIssuer). Tokens must carry exactly this
// string or they are refused, regardless of the port we happen to listen on.
const ISSUER = "http://localhost:8787";
const AUDIENCE = "localhost";
const API_KEY = "test-api-key";

const TOKENS: TokenIssuerConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  accessTtlSeconds: 900,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  walletChallengeTtlSeconds: 300,
};

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof loadSigningKey>[2];

let key: AuthSigningKey;
let server: Server;
let base: string;

/** Everything the deployed service does, minus the port it happens to get. */
function makeApp(overrides: { canCreatePublicLobbies?: boolean } = {}) {
  return createAuthApp({
    key,
    tokens: TOKENS,
    cookie: { secure: false },
    apiKey: API_KEY,
    canCreatePublicLobbies: overrides.canCreatePublicLobbies ?? true,
    isOriginAllowed: makeOriginPredicate(AUDIENCE, true, [
      "https://example.test",
    ]),
    log: silentLog as never,
    // A shared limiter would let one test's requests exhaust another's budget.
    rateLimit: false,
  });
}

beforeAll(async () => {
  key = await loadSigningKey(undefined, true, silentLog);
  const app = makeApp();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The Set-Cookie value for the refresh cookie, as a request Cookie header. */
function refreshCookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const pair = setCookie!.split(";")[0];
  expect(pair.startsWith(`${REFRESH_COOKIE}=`)).toBe(true);
  return pair;
}

async function refresh(
  cookie?: string,
): Promise<{ res: Response; jwt: string; expiresIn: number }> {
  const res = await fetch(`${base}/auth/refresh`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { jwt: string; expiresIn: number };
  return { res, jwt: body.jwt, expiresIn: body.expiresIn };
}

describe("JWKS", () => {
  test("parses under the schema the game server actually enforces", async () => {
    const res = await fetch(`${base}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    // Not a hand-written shape assertion: ServerEnv.jwkPublicKey() rejects
    // anything JwksSchema rejects, and a JWKS the game refuses breaks every
    // join. Pin the real schema so the two cannot drift.
    const parsed = JwksSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.keys[0].alg).toBe("EdDSA");
    expect(parsed.data?.keys[0].crv).toBe("Ed25519");
  });

  test("does not publish the private scalar", async () => {
    const res = await fetch(`${base}/.well-known/jwks.json`);
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys[0].d).toBeUndefined();
  });
});

describe("POST /auth/refresh", () => {
  test("mints a guest session when there is no cookie", async () => {
    const { res, jwt, expiresIn } = await refresh();
    expect(expiresIn).toBe(900);
    // The claim set the client and the game server both parse.
    const claims = TokenPayloadSchema.parse(decodeJwt(jwt));
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(AUDIENCE);
    // sub is transformed back to a UUID by the schema; the raw claim is the
    // base64url of its 16 bytes.
    expect(PersistentIdSchema.safeParse(claims.sub).success).toBe(true);
    expect(claims.provider).toBe("guest");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    // secure:false in this app — a Secure cookie would never be stored over
    // the http origin dev runs on.
    expect(setCookie).not.toContain("Secure");
  });

  test("the cookie round-trips to the same identity", async () => {
    const first = await refresh();
    const cookie = refreshCookieFrom(first.res);
    const second = await refresh(cookie);
    const a = TokenPayloadSchema.parse(decodeJwt(first.jwt));
    const b = TokenPayloadSchema.parse(decodeJwt(second.jwt));
    expect(b.sub).toBe(a.sub);
  });

  test("issues a fresh jti on every mint", async () => {
    // Load-bearing beyond replay: the jti is the nonce a wallet signs for a
    // wagered join, so a signature must not survive into a later token.
    const first = await refresh();
    const cookie = refreshCookieFrom(first.res);
    const second = await refresh(cookie);
    const a = TokenPayloadSchema.parse(decodeJwt(first.jwt));
    const b = TokenPayloadSchema.parse(decodeJwt(second.jwt));
    expect(b.jti).not.toBe(a.jti);
  });

  test("a forged cookie yields a new guest, not an error", async () => {
    // A 401 here would make Auth.ts log the player out, clearing their flag
    // and pattern settings over a cookie they never controlled.
    const { res, jwt } = await refresh(`${REFRESH_COOKIE}=not-a-jwt`);
    expect(res.status).toBe(200);
    expect(TokenPayloadSchema.parse(decodeJwt(jwt)).provider).toBe("guest");
  });

  test("rejects a wrong api key", async () => {
    const res = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "x-api-key": "wrong" },
    });
    expect(res.status).toBe(403);
  });
});

describe("audience separation", () => {
  test("the refresh cookie is not usable as a bearer token", async () => {
    const { res } = await refresh();
    const cookie = refreshCookieFrom(res);
    const token = decodeURIComponent(cookie.slice(REFRESH_COOKIE.length + 1));
    // Sanity: it really is a token for this issuer, just a different audience.
    expect(decodeJwt(token).aud).toBe(refreshAudience(ISSUER));
    const me = await fetch(`${base}/users/@me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(401);
  });

  test("an access token is not usable as a refresh cookie", async () => {
    const { jwt } = await refresh();
    const first = await refresh(`${REFRESH_COOKIE}=${jwt}`);
    const reused = TokenPayloadSchema.parse(decodeJwt(first.jwt));
    const original = TokenPayloadSchema.parse(decodeJwt(jwt));
    // Falls through to the new-guest path rather than resurrecting the session.
    expect(reused.sub).not.toBe(original.sub);
  });

  test("a wallet challenge is not usable as a bearer token", async () => {
    const res = await fetch(`${base}/auth/wallet/challenge`);
    const { challenge } = (await res.json()) as { challenge: string };
    const me = await fetch(`${base}/users/@me`, {
      headers: { authorization: `Bearer ${challenge}` },
    });
    expect(me.status).toBe(401);
  });
});

describe("GET /users/@me", () => {
  test("returns a body the game server can parse", async () => {
    const { jwt } = await refresh();
    const res = await fetch(`${base}/users/@me`, {
      headers: { authorization: `Bearer ${jwt}`, "x-api-key": API_KEY },
    });
    expect(res.status).toBe(200);
    // Worker.ts closes the socket with "Unauthorized" when this fails to
    // parse, so a missing field takes the site down rather than degrading it.
    const parsed = UserMeResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.player.canCreatePublicLobbies).toBe(true);
    expect(parsed.data?.player.subscription).toBeNull();
  });

  test("publicId is stable and is not the persistentID", async () => {
    const first = await refresh();
    const cookie = refreshCookieFrom(first.res);
    const second = await refresh(cookie);
    const read = async (jwt: string) => {
      const res = await fetch(`${base}/users/@me`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      return UserMeResponseSchema.parse(await res.json()).player.publicId;
    };
    const a = await read(first.jwt);
    expect(await read(second.jwt)).toBe(a);
    const sub = TokenPayloadSchema.parse(decodeJwt(first.jwt)).sub;
    expect(a).not.toBe(sub);
    expect(a).toBe(publicIdFor(sub));
  });

  test("401 without a token, so Api.ts logs the player out", async () => {
    const res = await fetch(`${base}/users/@me`);
    expect(res.status).toBe(401);
  });

  test("a browser request with no api key is allowed", async () => {
    // The browser cannot send x-api-key; requiring it would lock every player
    // out of their own session.
    const { jwt } = await refresh();
    const res = await fetch(`${base}/users/@me`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
  });

  test("a wrong api key is rejected", async () => {
    const { jwt } = await refresh();
    const res = await fetch(`${base}/users/@me`, {
      headers: { authorization: `Bearer ${jwt}`, "x-api-key": "wrong" },
    });
    expect(res.status).toBe(403);
  });

  test("reports canCreatePublicLobbies false when the operator says so", async () => {
    const app = makeApp({ canCreatePublicLobbies: false });
    const s = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    try {
      const address = s.address();
      if (address === null || typeof address === "string") throw new Error();
      const local = `http://127.0.0.1:${address.port}`;
      const r = await fetch(`${local}/auth/refresh`, { method: "POST" });
      const { jwt } = (await r.json()) as { jwt: string };
      const me = await fetch(`${local}/users/@me`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      const parsed = UserMeResponseSchema.parse(await me.json());
      expect(parsed.player.canCreatePublicLobbies).toBe(false);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});

describe("wallet login", () => {
  const wallet = Keypair.generate();
  const address = wallet.publicKey.toBase58();

  async function challenge(): Promise<{ nonce: string; challenge: string }> {
    const res = await fetch(`${base}/auth/wallet/challenge`);
    expect(res.status).toBe(200);
    return (await res.json()) as { nonce: string; challenge: string };
  }

  function sign(message: string): string {
    const sig = nacl.sign.detached(
      Uint8Array.from(new TextEncoder().encode(message)),
      Uint8Array.from(wallet.secretKey),
    );
    return Buffer.from(sig).toString("base64");
  }

  async function login(body: unknown): Promise<Response> {
    return fetch(`${base}/auth/wallet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("the challenge does not hand the wallet a message to blind-sign", async () => {
    const res = await fetch(`${base}/auth/wallet/challenge`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.message).toBeUndefined();
    expect(typeof body.nonce).toBe("string");
  });

  test("a valid signature mints a wallet session", async () => {
    const { nonce, challenge: c } = await challenge();
    const res = await login({
      walletAddress: address,
      challenge: c,
      signature: sign(walletLoginMessage(nonce)),
    });
    expect(res.status).toBe(200);
    const { jwt } = (await res.json()) as { jwt: string };
    const claims = TokenPayloadSchema.parse(decodeJwt(jwt));
    expect(claims.provider).toBe("wallet");
    expect(claims.sub).toBe(walletUserId(address));
  });

  test("the identity is the same on a second, independent login", async () => {
    // The point of deriving it from the address: same wallet, same player,
    // on another device, with nothing stored.
    const one = await challenge();
    const first = await login({
      walletAddress: address,
      challenge: one.challenge,
      signature: sign(walletLoginMessage(one.nonce)),
    });
    const two = await challenge();
    const second = await login({
      walletAddress: address,
      challenge: two.challenge,
      signature: sign(walletLoginMessage(two.nonce)),
    });
    const a = TokenPayloadSchema.parse(
      decodeJwt(((await first.json()) as { jwt: string }).jwt),
    );
    const b = TokenPayloadSchema.parse(
      decodeJwt(((await second.json()) as { jwt: string }).jwt),
    );
    expect(b.sub).toBe(a.sub);
    expect(b.jti).not.toBe(a.jti);
  });

  test("a per-match signature is not a login", async () => {
    // Domain separation: signing authMessage() instead of walletLoginMessage()
    // over the same nonce must not authenticate. If the prefixes are ever
    // unified, this is what fails.
    const { nonce, challenge: c } = await challenge();
    const res = await login({
      walletAddress: address,
      challenge: c,
      signature: sign(authMessage(nonce)),
    });
    expect(res.status).toBe(401);
  });

  test("another wallet's signature is rejected", async () => {
    const other = Keypair.generate();
    const { nonce, challenge: c } = await challenge();
    const sig = nacl.sign.detached(
      Uint8Array.from(new TextEncoder().encode(walletLoginMessage(nonce))),
      Uint8Array.from(other.secretKey),
    );
    const res = await login({
      walletAddress: address,
      challenge: c,
      signature: Buffer.from(sig).toString("base64"),
    });
    expect(res.status).toBe(401);
  });

  test("a forged challenge is rejected", async () => {
    const res = await login({
      walletAddress: address,
      challenge: "not-a-jwt",
      signature: sign(walletLoginMessage("whatever")),
    });
    expect(res.status).toBe(401);
  });

  test("a malformed body is a 400, not a 500", async () => {
    expect((await login({ walletAddress: address })).status).toBe(400);
    expect((await login({})).status).toBe(400);
  });

  test("the derived id is a valid persistentID", async () => {
    // PersistentIdSchema is z.uuid(); a raw hash slice is not guaranteed to
    // satisfy it, which is why identity.ts forces the version/variant nibbles.
    expect(PersistentIdSchema.safeParse(walletUserId(address)).success).toBe(
      true,
    );
  });
});

describe("logout", () => {
  test("clears the cookie", async () => {
    const res = await fetch(`${base}/auth/logout`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("revoke does the same — there is no session store to revoke", async () => {
    const res = await fetch(`${base}/auth/revoke`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("CORS", () => {
  test("echoes an allowed origin with credentials", async () => {
    const res = await fetch(`${base}/health`, {
      headers: { origin: "http://localhost:9000" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:9000",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    // Without Vary a shared cache can serve one origin another's allow header.
    expect(res.headers.get("vary")).toContain("Origin");
  });

  test("never answers with a wildcard, which is invalid with credentials", async () => {
    const res = await fetch(`${base}/health`, {
      headers: { origin: "http://localhost:9000" },
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  test("omits the header for an origin that is not allowed", async () => {
    const res = await fetch(`${base}/health`, {
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("answers preflight with 204", async () => {
    const res = await fetch(`${base}/auth/refresh`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:9000",
        "access-control-request-method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("makeOriginPredicate", () => {
  const isAllowed = makeOriginPredicate("example.com", false, [
    "app://openfront",
  ]);

  test("allows the site and its subdomains over https", () => {
    expect(isAllowed("https://example.com")).toBe(true);
    expect(isAllowed("https://main.example.com")).toBe(true);
  });

  test("refuses http and lookalike domains", () => {
    expect(isAllowed("http://example.com")).toBe(false);
    // The classic suffix bug: notexample.com must not match example.com.
    expect(isAllowed("https://notexample.com")).toBe(false);
    expect(isAllowed("https://example.com.evil.net")).toBe(false);
  });

  test("refuses localhost outside dev", () => {
    expect(isAllowed("http://localhost:9000")).toBe(false);
  });

  test("allows explicitly listed origins", () => {
    expect(isAllowed("app://openfront")).toBe(true);
  });
});

describe("PrivilegeRefresher endpoints", () => {
  test("serves parseable empty catalogues", async () => {
    const cosmetics = await fetch(`${base}/cosmetics.json`);
    expect(cosmetics.status).toBe(200);
    const { CosmeticsSchema } = await import("../../src/core/CosmeticSchemas");
    expect(CosmeticsSchema.safeParse(await cosmetics.json()).success).toBe(
      true,
    );

    const tags = await fetch(`${base}/reserved_clan_tags`);
    expect(tags.status).toBe(200);
    const { ReservedClanTagsResponseSchema } =
      await import("../../src/core/ClanApiSchemas");
    expect(
      ReservedClanTagsResponseSchema.safeParse(await tags.json()).success,
    ).toBe(true);
  });
});

// The one place both halves of the contract are exercised together: a token
// this service minted, verified by the game server's own verifyClientToken --
// JWKS fetch, EdDSA verification, issuer/audience checks and
// TokenPayloadSchema, none of them re-implemented here. fetch is redirected to
// the ephemeral port rather than binding 8787, so the suite cannot collide
// with a running `npm run dev:auth`; nothing else about the path is faked.
describe("end to end against the game server's verifier", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  test("verifyClientToken accepts a token this service issued", async () => {
    vi.stubEnv("DOMAIN", AUDIENCE);
    expect(ServerEnv.jwtIssuer()).toBe(ISSUER);

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      return realFetch(
        url.startsWith(ISSUER) ? base + url.slice(ISSUER.length) : url,
        init,
      );
    }) as typeof fetch;

    const { jwt } = await refresh();
    const result = await verifyClientToken(jwt);
    expect(result.type).toBe("success");
    if (result.type !== "success") return;
    expect(result.claims).not.toBeNull();
    expect(PersistentIdSchema.safeParse(result.persistentId).success).toBe(
      true,
    );
    // The jti the wagered-join gate uses as the wallet-signing nonce.
    expect(result.claims?.jti).toBeTruthy();
  });

  test("rejects a token signed by a different key", async () => {
    vi.stubEnv("DOMAIN", AUDIENCE);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      return realFetch(
        url.startsWith(ISSUER) ? base + url.slice(ISSUER.length) : url,
        init,
      );
    }) as typeof fetch;

    const impostor = await loadSigningKey(undefined, true, silentLog);
    const { jwt } = await mintAccessToken(
      impostor,
      TOKENS,
      "123e4567-e89b-12d3-a456-426614174000",
      "guest",
    );
    const result = await verifyClientToken(jwt);
    expect(result.type).toBe("error");
  });
});
