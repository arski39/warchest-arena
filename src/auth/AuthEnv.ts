// [ARENA] new file — environment contract for the auth service.
//
// Kept separate from ServerEnv because this process is a separate container
// with a disjoint env: it must not require NUM_WORKERS or GIT_COMMIT, and the
// game server must not require the signing key. The two overlap on exactly
// three values -- DOMAIN, GAME_ENV and API_KEY -- and those are read the same
// way on both sides so the issuer/audience pair cannot drift.
import { GameEnv, parseGameEnv } from "../core/configuration/Config";

/** Default port. Hard-coded into ServerEnv.jwtIssuer()/ClientEnv.jwtIssuer(). */
export const DEFAULT_AUTH_PORT = 8787;

/** Access-token lifetime. docs/Auth.md specifies 15 minutes. */
const ACCESS_TTL_SECONDS = 15 * 60;

/** Refresh-cookie lifetime. docs/Auth.md specifies 30 days. */
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/** How long a wallet-login challenge stays signable. */
const WALLET_CHALLENGE_TTL_SECONDS = 5 * 60;

function boolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new Error(`Expected a boolean, got "${raw}"`);
}

export class AuthEnv {
  static env(): GameEnv {
    return parseGameEnv(process.env.GAME_ENV);
  }

  static isDev(): boolean {
    return AuthEnv.env() === GameEnv.Dev;
  }

  static port(): number {
    const raw = process.env.AUTH_PORT;
    if (!raw) return DEFAULT_AUTH_PORT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
      throw new Error(`Invalid AUTH_PORT: ${raw}`);
    }
    return n;
  }

  /** The `aud` claim. Must equal the game's DOMAIN or the client logs out. */
  static audience(): string {
    const v = process.env.DOMAIN;
    if (!v) throw new Error("DOMAIN not set");
    return v;
  }

  /**
   * The `iss` claim, and the origin this service is reached at.
   *
   * Mirrors ServerEnv.jwtIssuer() and ClientEnv.jwtIssuer() exactly, including
   * their hard-coded localhost port. Deliberately NOT derived from port():
   * both consumers reject a token whose `iss` is not the string they compute
   * themselves, so a non-default AUTH_PORT must still issue for :8787 and be
   * reached through a proxy. warnIfPortMismatch() says so out loud.
   */
  static issuer(): string {
    const audience = AuthEnv.audience();
    return audience === "localhost"
      ? `http://localhost:${DEFAULT_AUTH_PORT}`
      : `https://api.${audience}`;
  }

  static warnIfPortMismatch(log: { warn: (msg: string) => void }): void {
    if (AuthEnv.audience() !== "localhost") return;
    if (AuthEnv.port() === DEFAULT_AUTH_PORT) return;
    log.warn(
      `AUTH_PORT is ${AuthEnv.port()} but the issuer is pinned to ` +
        `${AuthEnv.issuer()} -- both the game server and the browser compute ` +
        `that URL themselves and reject any other. Proxy ${AuthEnv.issuer()} ` +
        `to this port, or tokens will be refused.`,
    );
  }

  /**
   * Path to the Ed25519 private JWK this service signs with. Unset is allowed
   * only in dev, where an ephemeral key is generated instead -- see
   * loadSigningKey().
   */
  static signingKeyPath(): string | undefined {
    const v = process.env.AUTH_SIGNING_KEY_PATH;
    return v && v.length > 0 ? v : undefined;
  }

  /**
   * Shared secret for server-to-server calls. The game server sends it on
   * /users/@me (jwt.ts). Empty disables the check, which is the dev default:
   * the bearer token is the actual authorization on every authenticated
   * route, so the key is a second fence, not the fence.
   */
  static apiKey(): string {
    return process.env.API_KEY ?? "";
  }

  /**
   * [ARENA] Turnstile's SECRET key — the server half of the widget.
   *
   * Empty means `/join_verify` is **not registered at all**, so the route 404s
   * and `JoinVerify.ts` falls open exactly as it does today. That is deliberate
   * and is the honest default: an endpoint that exists but approves everything
   * looks like bot protection while being none, which is strictly worse than
   * an endpoint that is visibly absent.
   *
   * Never reaches the browser. The public site key is `TURNSTILE_SITE_KEY` on
   * the game server; this one is read only here.
   */
  static turnstileSecretKey(): string {
    return process.env.TURNSTILE_SECRET_KEY ?? "";
  }

  static accessTtlSeconds(): number {
    return ACCESS_TTL_SECONDS;
  }

  static refreshTtlSeconds(): number {
    return REFRESH_TTL_SECONDS;
  }

  static walletChallengeTtlSeconds(): number {
    return WALLET_CHALLENGE_TTL_SECONDS;
  }

  /**
   * `Domain` attribute on the refresh cookie. Unset means host-only, scoped to
   * api.$DOMAIN -- which is the only origin that ever reads it, so that is the
   * tighter and correct default. Override only for an unusual proxy layout.
   */
  static cookieDomain(): string | undefined {
    const v = process.env.AUTH_COOKIE_DOMAIN;
    return v && v.length > 0 ? v : undefined;
  }

  /** `Secure` on the refresh cookie. Off in dev, where the origin is http. */
  static cookieSecure(): boolean {
    return boolEnv(process.env.AUTH_COOKIE_SECURE, !AuthEnv.isDev());
  }

  /**
   * Whether /users/@me reports canCreatePublicLobbies. Upstream gates this on a
   * subscription; this fork has no subscription backend, so the operator
   * decides. Wagered lobbies are private-only regardless -- /wager rejects a
   * listed lobby and /listing rejects a wagered one -- so this cannot widen
   * the accepted client-vote risk.
   */
  static allowPublicLobbies(): boolean {
    return boolEnv(process.env.AUTH_ALLOW_PUBLIC_LOBBIES, true);
  }

  /**
   * Extra browser origins allowed to send credentialed requests, comma
   * separated. https://$DOMAIN, https://*.$DOMAIN and the dev localhost ports
   * are allowed without listing them; this is for anything else (the desktop
   * app's app:// origin, a staging front end on another host).
   */
  static extraAllowedOrigins(): string[] {
    const raw = process.env.AUTH_ALLOWED_ORIGINS;
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}
