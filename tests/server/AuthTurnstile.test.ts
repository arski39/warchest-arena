// @vitest-environment node
//
// Node, not the repo-wide jsdom default, for the same reason AuthService.test.ts
// is: this suite builds the real auth app, and that module graph reaches jose.
//
// What is under test is the half of Turnstile this fork never had. The widget
// has always rendered, and JoinVerify.ts has always POSTed to
// `${jwtIssuer()}/join_verify` -- but that endpoint lived in upstream's closed
// api worker, so here it 404'd and every join fell open. These tests pin the
// endpoint's contract, and in particular the two behaviours that would silently
// turn bot protection back off.
import type { Server } from "http";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { makeOriginPredicate } from "../../src/auth/http";
import { createAuthApp } from "../../src/auth/routes";
import { loadSigningKey, type AuthSigningKey } from "../../src/auth/signingKey";
import type { TokenIssuerConfig } from "../../src/auth/tokens";
import {
  hostnameAllowed,
  SITEVERIFY_URL,
  type FetchLike,
} from "../../src/auth/turnstile";

const ISSUER = "http://localhost:8787";
const AUDIENCE = "localhost";
const API_KEY = "test-api-key";
const SECRET = "test-secret";

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

beforeAll(async () => {
  key = await loadSigningKey(undefined, true, silentLog);
});

/** Records what siteverify was asked, and answers with `body`. */
function stubSiteverify(body: unknown): {
  fetchImpl: FetchLike;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as unknown });
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

async function withApp(
  opts: { turnstileSecret?: string; turnstileFetch?: FetchLike },
  run: (base: string) => Promise<void>,
): Promise<void> {
  const app = createAuthApp({
    key,
    tokens: TOKENS,
    cookie: { secure: false },
    apiKey: API_KEY,
    canCreatePublicLobbies: true,
    isOriginAllowed: makeOriginPredicate(AUDIENCE, true, []),
    log: silentLog as never,
    rateLimit: false,
    isDev: true,
    ...opts,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function joinVerify(
  base: string,
  body: unknown,
  apiKey: string = API_KEY,
): Promise<Response> {
  return fetch(`${base}/join_verify`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
}

const A_JOIN = {
  ip: "203.0.113.7",
  token: "a-turnstile-token",
  username: "player",
  clanTag: "ABC",
};

describe("POST /join_verify", () => {
  test("is not served at all when no secret is configured", async () => {
    // The honest default, and the behaviour this fork has always had. An
    // endpoint that existed and approved everything would look like bot
    // protection while being none -- strictly worse than a visible 404.
    await withApp({ turnstileSecret: "" }, async (base) => {
      const res = await joinVerify(base, A_JOIN);
      expect(res.status).toBe(404);
    });
  });

  test("approves a token Cloudflare accepts, passing the name through", async () => {
    const { fetchImpl, calls } = stubSiteverify({
      success: true,
      hostname: AUDIENCE,
    });
    await withApp(
      { turnstileSecret: SECRET, turnstileFetch: fetchImpl },
      async (base) => {
        const res = await joinVerify(base, A_JOIN);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          status: "approved",
          username: "player",
          clanTag: "ABC",
        });
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SITEVERIFY_URL);
    // The secret goes to Cloudflare and nowhere else; the token and remote IP
    // are what it is being asked about.
    expect(calls[0].body).toEqual({
      secret: SECRET,
      response: "a-turnstile-token",
      remoteip: "203.0.113.7",
    });
  });

  test("rejects a token Cloudflare refuses, and says why", async () => {
    const { fetchImpl } = stubSiteverify({
      success: false,
      "error-codes": ["timeout-or-duplicate"],
    });
    await withApp(
      { turnstileSecret: SECRET, turnstileFetch: fetchImpl },
      async (base) => {
        const body = (await (await joinVerify(base, A_JOIN)).json()) as {
          status: string;
          reason: string;
        };
        expect(body.status).toBe("rejected");
        expect(body.reason).toContain("timeout-or-duplicate");
      },
    );
  });

  test("rejects a token solved on someone else's hostname", async () => {
    const { fetchImpl } = stubSiteverify({
      success: true,
      hostname: "evil.example",
    });
    await withApp(
      { turnstileSecret: SECRET, turnstileFetch: fetchImpl },
      async (base) => {
        const body = (await (await joinVerify(base, A_JOIN)).json()) as {
          status: string;
          reason: string;
        };
        expect(body.status).toBe("rejected");
        expect(body.reason).toContain("evil.example");
      },
    );
  });

  test("rejects rather than approves when siteverify is unreachable", async () => {
    // A token is single-use, so this is deliberately not retried. The
    // fail-open decision belongs to JoinVerify.ts on the game server, which
    // treats a non-verdict as its own call; this layer must never invent an
    // approval it did not get.
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await withApp(
      { turnstileSecret: SECRET, turnstileFetch: fetchImpl },
      async (base) => {
        const body = (await (await joinVerify(base, A_JOIN)).json()) as {
          status: string;
        };
        expect(body.status).toBe("rejected");
      },
    );
  });

  test("a null token skips siteverify entirely — the reconnect contract", async () => {
    // SECURITY: this is upstream's contract, not an oversight. A Turnstile
    // token is single-use, so an already-admitted player reconnecting has none
    // left to present. planJoinVerify() on the game server is what guarantees a
    // FIRST join never arrives with a null token; forwarding one would be a
    // full Turnstile bypass.
    const { fetchImpl, calls } = stubSiteverify({ success: true });
    await withApp(
      { turnstileSecret: SECRET, turnstileFetch: fetchImpl },
      async (base) => {
        const res = await joinVerify(base, { ...A_JOIN, token: null });
        expect(await res.json()).toEqual({
          status: "approved",
          username: "player",
          clanTag: "ABC",
        });
      },
    );
    expect(calls).toHaveLength(0);
  });

  test("refuses a caller without the shared api key", async () => {
    const { fetchImpl, calls } = stubSiteverify({ success: true });
    await withApp(
      { turnstileSecret: SECRET, turnstileFetch: fetchImpl },
      async (base) => {
        const res = await joinVerify(base, A_JOIN, "wrong-key");
        expect(res.status).toBe(403);
      },
    );
    expect(calls).toHaveLength(0);
  });

  test("rejects a malformed body without calling Cloudflare", async () => {
    const { fetchImpl, calls } = stubSiteverify({ success: true });
    await withApp(
      { turnstileSecret: SECRET, turnstileFetch: fetchImpl },
      async (base) => {
        const res = await joinVerify(base, { username: 5 });
        expect(res.status).toBe(400);
      },
    );
    expect(calls).toHaveLength(0);
  });
});

describe("hostnameAllowed", () => {
  test("accepts the domain and its subdomains", () => {
    expect(
      hostnameAllowed("warchest-arena.com", "warchest-arena.com", false),
    ).toBe(true);
    expect(
      hostnameAllowed("www.warchest-arena.com", "warchest-arena.com", false),
    ).toBe(true);
  });

  test("rejects a lookalike that merely ends with the domain", () => {
    // The dot in `.${domain}` is what stops notwarchest-arena.com passing.
    expect(
      hostnameAllowed("notwarchest-arena.com", "warchest-arena.com", false),
    ).toBe(false);
  });

  test("accepts localhost only in dev", () => {
    expect(hostnameAllowed("localhost", "warchest-arena.com", true)).toBe(true);
    expect(hostnameAllowed("localhost", "warchest-arena.com", false)).toBe(
      false,
    );
  });
});
