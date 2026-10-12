// @vitest-environment node
//
// Node, not jsdom, for the reason AuthService.test.ts gives: this builds the
// real auth app, whose module graph reaches jose.
//
// What is under test is the store upstream's closed API provided and this fork
// never had. Archive.ts POSTs every finished game to `${jwtIssuer}/game/:id`
// and JoinLobbyModal fetches replays from the same path; with no route here the
// POST died on the 8 kB JSON limit ("Request Entity Too Large") and the GET
// 404'd. The tests that matter most are the ones keeping the write fenced.
import { mkdtempSync, readdirSync, rmSync } from "fs";
import type { Server } from "http";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createFileGameArchive,
  decodeStored,
  type GameArchive,
} from "../../src/auth/gameArchive";
import { makeOriginPredicate } from "../../src/auth/http";
import { createAuthApp } from "../../src/auth/routes";
import { loadSigningKey, type AuthSigningKey } from "../../src/auth/signingKey";
import type { TokenIssuerConfig } from "../../src/auth/tokens";

const AUDIENCE = "localhost";
const API_KEY = "test-api-key";
const GAME_ID = "AbCd1234";

const TOKENS: TokenIssuerConfig = {
  issuer: "http://localhost:8787",
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
const dirs: string[] = [];

beforeAll(async () => {
  key = await loadSigningKey(undefined, true, silentLog);
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempArchive(): { dir: string; store: GameArchive } {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-archive-"));
  dirs.push(dir);
  return { dir, store: createFileGameArchive(dir) };
}

async function withApp(
  opts: { apiKey?: string; isDev?: boolean; gameArchive?: GameArchive },
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
    isDev: false,
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

/** Big enough to be well past the 8 kB limit that used to reject it. */
function aRecord(gameID = GAME_ID): Record<string, unknown> {
  return {
    info: { gameID, players: [] },
    version: "v0.0.2",
    gitCommit: "DEV",
    turns: Array.from({ length: 2000 }, (_, turnNumber) => ({
      turnNumber,
      intents: [{ type: "spawn", tile: turnNumber }],
    })),
  };
}

function post(
  base: string,
  body: unknown,
  opts: { id?: string; apiKey?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const apiKey = opts.apiKey === undefined ? API_KEY : opts.apiKey;
  if (apiKey !== null) headers["x-api-key"] = apiKey;
  return fetch(`${base}/game/${opts.id ?? GAME_ID}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("/game/:id", () => {
  test("is not served at all when no archive is configured", async () => {
    await withApp({}, async (base) => {
      expect((await post(base, aRecord())).status).toBe(404);
      expect((await fetch(`${base}/game/${GAME_ID}`)).status).toBe(404);
    });
  });

  test("stores a record past the old 8 kB limit and serves it back", async () => {
    const { store } = tempArchive();
    const record = aRecord();
    expect(JSON.stringify(record).length).toBeGreaterThan(8 * 1024);
    await withApp({ gameArchive: store }, async (base) => {
      expect((await post(base, record)).status).toBe(200);

      const res = await fetch(`${base}/game/${GAME_ID}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      // fetch decodes Content-Encoding: gzip, exactly as the browser does.
      expect(await res.json()).toEqual(record);
    });
  });

  test("stores the record gzipped on disk, one file per game", async () => {
    const { dir, store } = tempArchive();
    await withApp({ gameArchive: store }, async (base) => {
      await post(base, aRecord());
    });
    expect(readdirSync(dir)).toEqual([`${GAME_ID}.json.gz`]);
    const gz = await store.getGzipped(GAME_ID);
    expect(decodeStored(gz!)).toEqual(aRecord());
  });

  test("the other routes keep the 8 kB body limit", async () => {
    const { store } = tempArchive();
    await withApp({ gameArchive: store }, async (base) => {
      const res = await fetch(`${base}/auth/wallet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(16 * 1024) }),
      });
      expect(res.status).toBe(413);
    });
  });

  describe("the write is fenced", () => {
    test("refuses a missing api key", async () => {
      const { store } = tempArchive();
      await withApp({ gameArchive: store }, async (base) => {
        expect((await post(base, aRecord(), { apiKey: null })).status).toBe(
          403,
        );
      });
      expect(await store.getGzipped(GAME_ID)).toBeNull();
    });

    test("refuses a wrong api key", async () => {
      const { store } = tempArchive();
      await withApp({ gameArchive: store }, async (base) => {
        expect((await post(base, aRecord(), { apiKey: "nope" })).status).toBe(
          403,
        );
      });
      expect(await store.getGzipped(GAME_ID)).toBeNull();
    });

    test("is not registered outside dev when no api key is configured", async () => {
      // apiKeyMissingOrWrong treats an empty key as "check disabled", so a
      // registered route here would be an anonymous, disk-filling write.
      const { store } = tempArchive();
      await withApp(
        { gameArchive: store, apiKey: "", isDev: false },
        async (base) => {
          expect((await post(base, aRecord(), { apiKey: null })).status).toBe(
            404,
          );
        },
      );
      expect(await store.getGzipped(GAME_ID)).toBeNull();
    });

    test("is write-once: a second record for an id cannot replace the first", async () => {
      const { store } = tempArchive();
      const first = aRecord();
      const forged = { ...aRecord(), gitCommit: "forged" };
      await withApp({ gameArchive: store }, async (base) => {
        expect((await post(base, first)).status).toBe(200);
        expect((await post(base, forged)).status).toBe(409);
        expect(await (await fetch(`${base}/game/${GAME_ID}`)).json()).toEqual(
          first,
        );
      });
    });

    test("refuses a record filed under another game's id", async () => {
      const { store } = tempArchive();
      await withApp({ gameArchive: store }, async (base) => {
        expect((await post(base, aRecord("ZzZz9999"))).status).toBe(400);
      });
      expect(await store.getGzipped(GAME_ID)).toBeNull();
    });

    test("refuses a body that is not a record", async () => {
      const { store } = tempArchive();
      await withApp({ gameArchive: store }, async (base) => {
        expect((await post(base, { info: { gameID: GAME_ID } })).status).toBe(
          400,
        );
      });
    });
  });

  test("an id that is not a game id never becomes a path", async () => {
    const { store } = tempArchive();
    await withApp({ gameArchive: store }, async (base) => {
      expect(
        (await post(base, aRecord("..%2F..%2Fx"), { id: "..%2F..%2Fx" }))
          .status,
      ).toBe(400);
      expect((await fetch(`${base}/game/..%2Fsecret`)).status).toBe(404);
    });
    await expect(store.put("../evil12", "{}")).rejects.toThrow();
  });

  test("an unknown id is a 404, which the client reads as not_found", async () => {
    const { store } = tempArchive();
    await withApp({ gameArchive: store }, async (base) => {
      expect((await fetch(`${base}/game/${GAME_ID}`)).status).toBe(404);
    });
  });
});
