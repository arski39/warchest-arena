// [ARENA] new file — minting and checking the three token kinds.
//
// Access, refresh and wallet-challenge tokens are all JWTs signed by the same
// key, and they are kept apart by `aud`, not by a claim anyone could forget to
// check. An access token is audienced to $DOMAIN, a refresh token to
// `<issuer>/auth/refresh`, a challenge to `<issuer>/auth/wallet`. jwtVerify
// enforces the audience itself, so a refresh cookie replayed as a bearer token
// fails verification rather than relying on a hand-written guard.
import { randomUUID } from "crypto";
import { jwtVerify, SignJWT } from "jose";
import { base64urlToUuid, uuidToBase64url } from "../core/Base64";
import { AUTH_JWT_ALG, type AuthSigningKey } from "./signingKey";

export type TokenIssuerConfig = {
  issuer: string;
  audience: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  walletChallengeTtlSeconds: number;
};

export const REFRESH_AUDIENCE_SUFFIX = "/auth/refresh";
export const WALLET_CHALLENGE_AUDIENCE_SUFFIX = "/auth/wallet";

export function refreshAudience(issuer: string): string {
  return issuer + REFRESH_AUDIENCE_SUFFIX;
}

export function walletChallengeAudience(issuer: string): string {
  return issuer + WALLET_CHALLENGE_AUDIENCE_SUFFIX;
}

/** How the session was established. Surfaces as the `provider` claim. */
export type SessionProvider = "guest" | "wallet";

export type AccessToken = {
  jwt: string;
  /** Seconds, matching the {jwt, expiresIn} shape Auth.ts already reads. */
  expiresIn: number;
  /** The `jti`. Also the nonce a wallet signs for a wagered join. */
  jti: string;
};

function sign(key: AuthSigningKey, claims: Record<string, unknown>): SignJWT {
  return new SignJWT(claims).setProtectedHeader({
    alg: AUTH_JWT_ALG,
    kid: key.kid,
  });
}

function providerOf(claim: unknown): SessionProvider {
  return claim === "wallet" ? "wallet" : "guest";
}

/**
 * A 15-minute session token.
 *
 * `sub` is the base64url of the raw UUID bytes, not the UUID string:
 * TokenPayloadSchema decodes it with base64urlToUuid and rejects anything
 * else, and the client derives its persistentID the same way.
 *
 * The `jti` is fresh on every mint. That is load-bearing beyond replay: it is
 * the nonce a wallet signs for a wagered join (core/arena/authMessage.ts), so
 * a signature is only good for the token it was produced under.
 */
export async function mintAccessToken(
  key: AuthSigningKey,
  cfg: TokenIssuerConfig,
  userId: string,
  provider: SessionProvider,
): Promise<AccessToken> {
  const jti = randomUUID();
  const jwt = await sign(key, { provider })
    .setJti(jti)
    .setSubject(uuidToBase64url(userId))
    .setIssuedAt()
    .setIssuer(cfg.issuer)
    .setAudience(cfg.audience)
    .setExpirationTime(`${cfg.accessTtlSeconds}s`)
    .sign(key.privateKey);
  return { jwt, expiresIn: cfg.accessTtlSeconds, jti };
}

/**
 * The httpOnly cookie's contents. Carries the raw UUID (not base64url) because
 * nothing but this service ever reads it, and the provider so a wallet session
 * survives a refresh as a wallet session rather than silently becoming a guest.
 */
export async function mintRefreshToken(
  key: AuthSigningKey,
  cfg: TokenIssuerConfig,
  userId: string,
  provider: SessionProvider,
): Promise<string> {
  return sign(key, { provider, uid: userId })
    .setJti(randomUUID())
    .setIssuedAt()
    .setIssuer(cfg.issuer)
    .setAudience(refreshAudience(cfg.issuer))
    .setExpirationTime(`${cfg.refreshTtlSeconds}s`)
    .sign(key.privateKey);
}

export type RefreshSession = { userId: string; provider: SessionProvider };

/** Null for anything that is not a live refresh token from this issuer. */
export async function verifyRefreshToken(
  key: AuthSigningKey,
  cfg: TokenIssuerConfig,
  token: string,
): Promise<RefreshSession | null> {
  try {
    const { payload } = await jwtVerify(token, key.publicKey, {
      algorithms: [AUTH_JWT_ALG],
      issuer: cfg.issuer,
      audience: refreshAudience(cfg.issuer),
    });
    const uid = payload.uid;
    if (typeof uid !== "string" || uid.length === 0) return null;
    return { userId: uid, provider: providerOf(payload.provider) };
  } catch {
    return null;
  }
}

/**
 * A short-lived, signed nonce for wallet login. Stateless by design: with no
 * store there is nowhere to remember an issued nonce, so the nonce carries its
 * own proof of issuance and its own expiry instead.
 */
export async function mintWalletChallenge(
  key: AuthSigningKey,
  cfg: TokenIssuerConfig,
): Promise<{ nonce: string; challenge: string; expiresIn: number }> {
  const nonce = randomUUID();
  const challenge = await sign(key, { nonce })
    .setJti(randomUUID())
    .setIssuedAt()
    .setIssuer(cfg.issuer)
    .setAudience(walletChallengeAudience(cfg.issuer))
    .setExpirationTime(`${cfg.walletChallengeTtlSeconds}s`)
    .sign(key.privateKey);
  return { nonce, challenge, expiresIn: cfg.walletChallengeTtlSeconds };
}

/** The nonce inside a live challenge, or null. */
export async function verifyWalletChallenge(
  key: AuthSigningKey,
  cfg: TokenIssuerConfig,
  challenge: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(challenge, key.publicKey, {
      algorithms: [AUTH_JWT_ALG],
      issuer: cfg.issuer,
      audience: walletChallengeAudience(cfg.issuer),
    });
    const nonce = payload.nonce;
    return typeof nonce === "string" && nonce.length > 0 ? nonce : null;
  } catch {
    return null;
  }
}

export type AccessSession = {
  userId: string;
  provider: SessionProvider;
  jti: string;
};

/** Verifies a bearer token. Null for anything this service did not issue. */
export async function verifyAccessToken(
  key: AuthSigningKey,
  cfg: TokenIssuerConfig,
  token: string,
): Promise<AccessSession | null> {
  try {
    const { payload } = await jwtVerify(token, key.publicKey, {
      algorithms: [AUTH_JWT_ALG],
      issuer: cfg.issuer,
      audience: cfg.audience,
    });
    const { sub, jti } = payload;
    if (typeof sub !== "string" || typeof jti !== "string") return null;
    // Decode through the same helper the game server uses, so a `sub` this
    // service could mint but TokenPayloadSchema would reject cannot exist.
    const userId = base64urlToUuid(sub);
    if (!userId) return null;
    return { userId, provider: providerOf(payload.provider), jti };
  } catch {
    return null;
  }
}
