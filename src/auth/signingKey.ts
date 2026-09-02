// [ARENA] new file — the Ed25519 key this service signs sessions with.
import { readFile } from "fs/promises";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  type CryptoKey,
  type JWK,
} from "jose";
import { z } from "zod";
import type { AuthLog } from "./AuthLogger";

/** The only algorithm anything in this codebase accepts. */
export const AUTH_JWT_ALG = "EdDSA";

/**
 * A private Ed25519 JWK on disk. `d` is the private scalar -- its presence is
 * what separates this from the public half, and reading a public-only JWK here
 * would produce a service that boots and then fails to sign anything.
 */
const PrivateJwkSchema = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().min(1),
  d: z.string().min(1),
});

export type AuthSigningKey = {
  /** Signs access, refresh and challenge tokens. */
  privateKey: CryptoKey;
  /** Verifies them. Also what /.well-known/jwks.json serves. */
  publicKey: CryptoKey;
  /** Exactly the shape ServerEnv/ClientEnv's JwksSchema requires. */
  publicJwk: JWK & { alg: "EdDSA"; crv: "Ed25519"; kty: "OKP"; x: string };
  kid: string;
  /** True when the key was generated at boot and dies with the process. */
  ephemeral: boolean;
};

async function fromJwk(jwk: JWK, ephemeral: boolean): Promise<AuthSigningKey> {
  const privateKey = (await importJWK(
    { ...jwk, alg: AUTH_JWT_ALG },
    AUTH_JWT_ALG,
  )) as CryptoKey;
  // Strip `d` rather than deriving a separate public key: for OKP the public
  // half IS the same JWK without the private scalar, and deriving it twice is
  // one more place the two could disagree.
  const publicJwkRaw = { ...jwk };
  delete publicJwkRaw.d;
  const publicKey = (await importJWK(
    { ...publicJwkRaw, alg: AUTH_JWT_ALG },
    AUTH_JWT_ALG,
  )) as CryptoKey;
  // Thumbprint over the bare JWK: RFC 7638 hashes only the required members,
  // so the kid is stable whether or not `alg`/`use` are present.
  const kid = await calculateJwkThumbprint(publicJwkRaw);
  return {
    privateKey,
    publicKey,
    publicJwk: {
      alg: AUTH_JWT_ALG,
      crv: "Ed25519",
      kty: "OKP",
      x: publicJwkRaw.x as string,
      kid,
      use: "sig",
    },
    kid,
    ephemeral,
  };
}

/**
 * Load the signing key from `path`, or generate an ephemeral one in dev.
 *
 * Never generates and writes a key for an absent path. A container that mints
 * a fresh key on every start would invalidate every outstanding session on
 * each deploy, and -- because the game server caches the first JWKS response
 * for the life of its process (ServerEnv.jwkPublicKey) -- would reject every
 * token until it too restarted. Refusing to boot says that immediately;
 * silently rotating says it as an unexplained wave of disconnects.
 */
export async function loadSigningKey(
  path: string | undefined,
  isDev: boolean,
  log: AuthLog,
): Promise<AuthSigningKey> {
  if (path === undefined) {
    if (!isDev) {
      throw new Error(
        "AUTH_SIGNING_KEY_PATH is not set. Generate a key with " +
          "`npx tsx scripts/generateAuthKey.ts <path>` and point this at it. " +
          "An ephemeral key is only allowed in dev, because rotating it logs " +
          "every player out and the game server caches the old public key.",
      );
    }
    const { privateKey } = await generateKeyPair(AUTH_JWT_ALG, {
      crv: "Ed25519",
      extractable: true,
    });
    const jwk = await exportJWK(privateKey);
    const key = await fromJwk(jwk, true);
    log.warn(
      "AUTH_SIGNING_KEY_PATH is unset; generated an ephemeral signing key. " +
        "Every session ends when this process does. Dev only.",
      { kid: key.kid },
    );
    return key;
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    // The cause is folded into the message instead of {cause}, which needs an
    // ES2022 target -- same reason as Privilege.ts:192.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `Failed to read AUTH_SIGNING_KEY_PATH (${path}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    // The parse error itself says nothing useful about a key file; what the
    // operator needs is which file and what it should have contained.
    throw new Error(
      `AUTH_SIGNING_KEY_PATH (${path}) is not JSON. It must be a private ` +
        `Ed25519 JWK, as written by scripts/generateAuthKey.ts.`,
    );
  }

  const result = PrivateJwkSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(
      `AUTH_SIGNING_KEY_PATH (${path}) is not a private Ed25519 JWK: ` +
        z.prettifyError(result.error),
    );
  }

  const key = await fromJwk(result.data, false);
  log.info("Loaded auth signing key", { kid: key.kid, path });
  return key;
}
