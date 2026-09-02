// [ARENA] new file — the two bits of HTTP plumbing this service needs that
// express does not ship: cookie reading/writing and credentialed CORS.
//
// Both are written by hand rather than pulled in as dependencies. They are
// twenty lines each, and every dependency added here is one more thing sitting
// in front of the session key.
import type { NextFunction, Request, Response } from "express";

/** Name of the refresh cookie. Only this service ever reads it. */
export const REFRESH_COOKIE = "of_refresh";

/** Reads one cookie out of a raw Cookie header. */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      // A cookie we cannot decode is a cookie we did not write.
      return undefined;
    }
  }
  return undefined;
}

export type CookieOptions = {
  secure: boolean;
  domain?: string;
  maxAgeSeconds: number;
};

/**
 * Serialises the refresh cookie.
 *
 * SameSite=Lax rather than None: the browser is on https://$DOMAIN and this
 * service on https://api.$DOMAIN, which is cross-*origin* but same-*site*, so
 * Lax already sends the cookie and None would needlessly widen it. The cost is
 * that a genuinely cross-site front end (the desktop app's app:// origin)
 * cannot use the cookie at all -- which is exactly why upstream re-exchanges a
 * platform ticket there instead of refreshing.
 */
export function serialiseRefreshCookie(
  value: string,
  opts: CookieOptions,
): string {
  const parts = [
    `${REFRESH_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Same attributes with a zero lifetime — the only way to reliably clear it. */
export function clearRefreshCookie(opts: Omit<CookieOptions, "maxAgeSeconds">) {
  return serialiseRefreshCookie("", { ...opts, maxAgeSeconds: 0 });
}

/**
 * Whether `origin` may make credentialed requests to this service.
 *
 * The site itself and any of its subdomains are allowed; so is localhost on
 * any port in dev, because the client dev server picks its own. Anything else
 * has to be named in AUTH_ALLOWED_ORIGINS.
 */
export function makeOriginPredicate(
  domain: string,
  isDev: boolean,
  extra: string[],
): (origin: string) => boolean {
  const allowed = new Set(extra);
  return (origin: string): boolean => {
    if (allowed.has(origin)) return true;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (isDev || domain === "localhost") {
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
        return true;
      }
    }
    if (url.protocol !== "https:") return false;
    return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
  };
}

/**
 * Credentialed CORS.
 *
 * Access-Control-Allow-Origin has to echo the exact origin -- "*" is invalid
 * with credentials, and the client sends `credentials: "include"` on every
 * auth call, so getting this wrong makes the whole service unusable from a
 * browser while working perfectly from curl.
 *
 * `Vary: Origin` because the response body for a given URL is identical across
 * origins but this header is not; without it a shared cache can hand one
 * origin another origin's allow header.
 */
export function corsMiddleware(isAllowed: (origin: string) => boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    res.setHeader("Vary", "Origin");
    if (typeof origin === "string" && isAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, x-api-key",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      // 204 whether or not the origin was allowed: a preflight that is missing
      // the allow headers is already a failure the browser reports clearly,
      // and answering with an error status buries that behind a status code.
      res.status(204).end();
      return;
    }
    next();
  };
}

/** The bearer token on a request, if there is a well-formed one. */
export function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}
