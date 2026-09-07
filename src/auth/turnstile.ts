// [ARENA] new file — server-side Turnstile verification.
//
// The widget has always rendered (index.html), and the game server has always
// tried to verify: `verifyJoin` POSTs to `${jwtIssuer()}/join_verify`. But that
// endpoint lived in upstream's CLOSED api worker, which is not in this repo, so
// in this fork it 404'd and `JoinVerify.ts` fell open on every join. The widget
// was decoration.
//
// This is the missing half. It calls Cloudflare's siteverify with the SECRET
// key, which is why it lives in the auth service: the secret must never reach
// the browser, and `src/auth/` is the only process that already handles
// key material.
import { z } from "zod";

export const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Cloudflare's documented response. `hostname` is absent for the testing keys
 * and for some error paths, so it is optional and checked only when present.
 */
const SiteverifyResponseSchema = z.object({
  success: z.boolean(),
  "error-codes": z.array(z.string()).optional(),
  hostname: z.string().optional(),
  action: z.string().optional(),
  challenge_ts: z.string().optional(),
});

export type TurnstileVerdict =
  | { ok: true }
  /** The token is bad, expired, replayed, or for another site. */
  | { ok: false; reason: string };

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Hostnames a token may legitimately have been solved on.
 *
 * The site key is already domain-scoped in the Cloudflare dashboard, so this is
 * defence in depth rather than the primary control — but it is cheap, and it is
 * the check that catches a key accidentally shared with another property.
 *
 * `www.` and other subdomains are accepted because the deployment serves the
 * apex and redirects www; dev adds localhost, matching the CORS predicate's
 * shape rather than inventing a second notion of "our origin".
 */
export function hostnameAllowed(
  hostname: string,
  domain: string,
  isDev: boolean,
): boolean {
  if (hostname === domain) return true;
  if (hostname.endsWith(`.${domain}`)) return true;
  if (isDev && (hostname === "localhost" || hostname === "127.0.0.1")) {
    return true;
  }
  return false;
}

/**
 * Verifies one Turnstile token against Cloudflare.
 *
 * **Every failure is a rejection, never an approval.** A token is single-use,
 * so this is deliberately not retried: re-submitting after a timeout can redeem
 * an already-spent token and turn a transient hiccup into a hard rejection of a
 * legitimate player. The caller (`JoinVerify.ts`) already treats a
 * non-verdict as its own fail-open decision, and that decision belongs there,
 * not here — this function's job is to answer honestly or say it could not.
 */
export async function verifyTurnstileToken(args: {
  secret: string;
  token: string;
  remoteIp?: string;
  domain: string;
  isDev: boolean;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<TurnstileVerdict> {
  const doFetch = (args.fetchImpl ??
    (globalThis.fetch as unknown)) as FetchLike;

  const body: Record<string, string> = {
    secret: args.secret,
    response: args.token,
  };
  // Cloudflare accepts remoteip as an optional extra signal. Omitted rather
  // than sent empty when the game server could not determine one.
  if (args.remoteIp !== undefined && args.remoteIp !== "") {
    body.remoteip = args.remoteIp;
  }

  let parsedBody: unknown;
  try {
    const res = await doFetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
    });
    if (!res.ok) {
      return { ok: false, reason: `siteverify returned ${res.status}` };
    }
    parsedBody = await res.json();
  } catch (e) {
    return {
      ok: false,
      reason: `siteverify unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const parsed = SiteverifyResponseSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return { ok: false, reason: "siteverify returned a malformed response" };
  }

  // Strictly `!== true`, not falsy: a malformed body that Zod happened to
  // accept must not pass by coercion.
  if (parsed.data.success !== true) {
    const codes = parsed.data["error-codes"] ?? [];
    return {
      ok: false,
      reason:
        codes.length > 0
          ? `turnstile: ${codes.join(", ")}`
          : "turnstile: failed",
    };
  }

  const hostname = parsed.data.hostname;
  if (
    hostname !== undefined &&
    !hostnameAllowed(hostname, args.domain, args.isDev)
  ) {
    return {
      ok: false,
      reason: `turnstile: solved on ${hostname}, not ${args.domain}`,
    };
  }

  return { ok: true };
}
