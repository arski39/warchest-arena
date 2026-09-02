// [ARENA] new file — the auth service's HTTP surface.
//
// This replaces the closed-source Cloudflare Worker OpenFrontIO/CLAUDE.md
// calls "API". Only the endpoints the game actually needs are here; the rest
// of upstream's API (matchmaking, leaderboards, cosmetics catalogues, Stripe)
// is deliberately absent, and every caller of those already fails open.
//
// Required, in the sense that the site does not work without them:
//   GET  /.well-known/jwks.json  ServerEnv.jwkPublicKey(); failure rejects
//                                every join.
//   POST /auth/refresh           the browser's only guest path (Auth.ts).
//   GET  /users/@me              Worker.ts closes the socket with
//                                "Unauthorized" when this fails for a
//                                JWT-bearing client.
// Wallet login (/auth/wallet, /auth/wallet/challenge) is additive: the arena
// verifies wallet ownership per match on its own, so a player never needs one
// to stake.
import express, { type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { walletLoginMessage } from "../core/arena/authMessage";
import { verifyEd25519Signature } from "../core/arena/walletSignature";
import type { AuthLog } from "./AuthLogger";
import {
  bearerToken,
  clearRefreshCookie,
  corsMiddleware,
  readCookie,
  REFRESH_COOKIE,
  serialiseRefreshCookie,
} from "./http";
import { guestUserId, walletUserId } from "./identity";
import type { AuthSigningKey } from "./signingKey";
import {
  mintAccessToken,
  mintRefreshToken,
  mintWalletChallenge,
  verifyAccessToken,
  verifyRefreshToken,
  verifyWalletChallenge,
  type SessionProvider,
  type TokenIssuerConfig,
} from "./tokens";
import { buildUserMe } from "./userMe";

export type AuthAppDeps = {
  key: AuthSigningKey;
  tokens: TokenIssuerConfig;
  cookie: { secure: boolean; domain?: string };
  /**
   * Shared secret for server-to-server calls. Empty disables the check. It is
   * a second fence, never the only one: the bearer token authorises every
   * authenticated route on its own, because the browser cannot send this.
   */
  apiKey: string;
  canCreatePublicLobbies: boolean;
  isOriginAllowed: (origin: string) => boolean;
  log: AuthLog;
  /** False in tests, where a shared limiter would couple unrelated cases. */
  rateLimit?: { windowMs: number; limit: number } | false;
};

/** Max JSON body. Every request here is a handful of base64 strings. */
const MAX_BODY = "8kb";

export function createAuthApp(deps: AuthAppDeps): Express {
  const { key, tokens, cookie, log } = deps;
  const app = express();

  // One proxy hop (traefik). Not `true`: express-rate-limit rejects a
  // permissive setting outright, because it lets any client spoof its own key.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(corsMiddleware(deps.isOriginAllowed));
  app.use(express.json({ limit: MAX_BODY }));

  const limiter =
    deps.rateLimit === false
      ? (_req: Request, _res: Response, next: () => void) => next()
      : rateLimit({
          windowMs: deps.rateLimit?.windowMs ?? 60_000,
          limit: deps.rateLimit?.limit ?? 60,
          standardHeaders: true,
          legacyHeaders: false,
        });

  /**
   * Rejects a *wrong* api key, not a missing one. The browser calls
   * /users/@me with only a bearer token, and requiring the key would lock it
   * out of its own session; the game server sends both.
   */
  function apiKeyRejected(req: Request): boolean {
    const provided = req.headers["x-api-key"];
    if (provided === undefined) return false;
    if (deps.apiKey === "") return false;
    return provided !== deps.apiKey;
  }

  function setRefreshCookie(res: Response, token: string): void {
    res.setHeader(
      "Set-Cookie",
      serialiseRefreshCookie(token, {
        secure: cookie.secure,
        domain: cookie.domain,
        maxAgeSeconds: tokens.refreshTtlSeconds,
      }),
    );
  }

  /** Mints the pair and returns the body Auth.ts already knows how to read. */
  async function issueSession(
    res: Response,
    userId: string,
    provider: SessionProvider,
  ): Promise<void> {
    const access = await mintAccessToken(key, tokens, userId, provider);
    const refresh = await mintRefreshToken(key, tokens, userId, provider);
    setRefreshCookie(res, refresh);
    res.json({ jwt: access.jwt, expiresIn: access.expiresIn });
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", kid: key.kid });
  });

  // The game server and the browser each fetch this once and cache the first
  // key for the life of the process, so a rotation needs both restarted. Short
  // max-age rather than none: it is fetched on every worker boot.
  app.get("/.well-known/jwks.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ keys: [key.publicJwk] });
  });

  /**
   * Exchange the refresh cookie for an access token, rotating the cookie.
   *
   * With no cookie this MINTS A NEW GUEST rather than failing. That is not an
   * oversight: /auth/refresh is the browser's only guest path (Auth.ts's
   * doRefreshJwt falls through to it), so refusing here would leave a
   * first-time visitor with no session at all. It is also why this route is
   * rate limited -- each cookieless call creates an identity.
   */
  app.post("/auth/refresh", limiter, async (req, res) => {
    if (apiKeyRejected(req)) {
      res.status(403).json({ error: "invalid_api_key" });
      return;
    }
    const cookieValue = readCookie(req.headers.cookie, REFRESH_COOKIE);
    const existing = cookieValue
      ? await verifyRefreshToken(key, tokens, cookieValue)
      : null;
    if (existing !== null) {
      await issueSession(res, existing.userId, existing.provider);
      return;
    }
    if (cookieValue !== undefined) {
      // Expired or forged. Treat it as a new visitor rather than an error:
      // the outcome the player sees is identical, and a 401 here would make
      // Auth.ts log out and clear their local flag/pattern settings.
      log.debug("Refresh cookie present but not valid; issuing a new guest");
    }
    const userId = guestUserId();
    await issueSession(res, userId, "guest");
  });

  /**
   * Clears the cookie.
   *
   * /auth/revoke is upstream's "log out everywhere". With no session store
   * there is nothing to revoke, so it does what /auth/logout does and says so
   * here rather than pretending: an access token already handed out stays
   * valid for up to its 15-minute lifetime either way. Closing that gap needs
   * a denylist, which needs storage -- see docs/Auth.md.
   */
  function logout(_req: Request, res: Response): void {
    res.setHeader(
      "Set-Cookie",
      clearRefreshCookie({ secure: cookie.secure, domain: cookie.domain }),
    );
    res.json({ ok: true });
  }
  app.post("/auth/logout", logout);
  app.post("/auth/revoke", logout);

  /**
   * A signed nonce for wallet login.
   *
   * Stateless: there is nowhere to remember an issued nonce, so the challenge
   * is a short-lived JWT carrying the nonce and its own expiry. A replayed
   * challenge within that window only ever produces a session for the wallet
   * that actually signed it.
   */
  app.get("/auth/wallet/challenge", limiter, async (_req, res) => {
    const { nonce, challenge, expiresIn } = await mintWalletChallenge(
      key,
      tokens,
    );
    res.setHeader("Cache-Control", "no-store");
    // The message itself is deliberately NOT returned. The client must build
    // it with walletLoginMessage(), so a compromised or spoofed service cannot
    // get a wallet to sign arbitrary bytes.
    res.json({ nonce, challenge, expiresIn });
  });

  /**
   * Exchange a wallet signature for a session, mirroring the {jwt, expiresIn}
   * shape of upstream's /auth/steam and /auth/crazygames exchanges.
   *
   * The resulting identity is derived from the address (identity.ts), so the
   * same wallet is the same player everywhere with nothing stored.
   */
  app.post("/auth/wallet", limiter, async (req, res) => {
    if (apiKeyRejected(req)) {
      res.status(403).json({ error: "invalid_api_key" });
      return;
    }
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const { walletAddress, challenge, signature } = body as Record<
      string,
      unknown
    >;
    if (
      typeof walletAddress !== "string" ||
      typeof challenge !== "string" ||
      typeof signature !== "string"
    ) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const nonce = await verifyWalletChallenge(key, tokens, challenge);
    if (nonce === null) {
      res.status(401).json({ error: "invalid_challenge" });
      return;
    }
    if (
      !verifyEd25519Signature(
        walletLoginMessage(nonce),
        walletAddress,
        signature,
      )
    ) {
      log.warn("Wallet login rejected: bad signature");
      res.status(401).json({ error: "invalid_signature" });
      return;
    }
    await issueSession(res, walletUserId(walletAddress), "wallet");
  });

  app.get("/users/@me", async (req, res) => {
    if (apiKeyRejected(req)) {
      res.status(403).json({ error: "invalid_api_key" });
      return;
    }
    const token = bearerToken(req);
    if (token === undefined) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    const session = await verifyAccessToken(key, tokens, token);
    if (session === null) {
      // 401 specifically: Api.ts's getUserMe() logs the player out on 401 and
      // merely returns false on anything else, and an unverifiable token is
      // exactly the case where logging out is right.
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(
      buildUserMe(session.userId, {
        canCreatePublicLobbies: deps.canCreatePublicLobbies,
      }),
    );
  });

  // PrivilegeRefresher polls these every 3 minutes and treats a failure as
  // fatal-to-the-refresh, retaining the previous checker (and falling open on
  // the very first attempt). Serving the empty answers keeps it from logging
  // an error loop for a catalogue this fork does not have: no cosmetics are
  // sold, and with no reserved tags every clan tag is treated as fictional,
  // which is what the fail-open checker already does.
  app.get("/cosmetics.json", (_req, res) => {
    res.json({ patterns: {}, flags: {} });
  });
  app.get("/reserved_clan_tags", (_req, res) => {
    res.json([]);
  });

  app.use((req, res) => {
    log.debug("Unhandled auth route", { method: req.method, path: req.path });
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
