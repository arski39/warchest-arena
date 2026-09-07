// [ARENA] new file — entrypoint for the auth service.
//
// Runs as its own process in its own container, behind the same proxy at
// api.$DOMAIN. Separate from the game server because it holds the session
// signing key and the game server holds the arena authority key, and one
// compromise should not be both (see the plan's H4 note).
import * as dotenv from "dotenv";
import { AuthEnv } from "./AuthEnv";
import { authLogger } from "./AuthLogger";
import { makeOriginPredicate } from "./http";
import { createAuthApp } from "./routes";
import { loadSigningKey } from "./signingKey";

dotenv.config();

export async function startAuthServer(): Promise<void> {
  const isDev = AuthEnv.isDev();
  const issuer = AuthEnv.issuer();
  const audience = AuthEnv.audience();
  AuthEnv.warnIfPortMismatch(authLogger);

  const key = await loadSigningKey(AuthEnv.signingKeyPath(), isDev, authLogger);

  const app = createAuthApp({
    key,
    tokens: {
      issuer,
      audience,
      accessTtlSeconds: AuthEnv.accessTtlSeconds(),
      refreshTtlSeconds: AuthEnv.refreshTtlSeconds(),
      walletChallengeTtlSeconds: AuthEnv.walletChallengeTtlSeconds(),
    },
    cookie: {
      secure: AuthEnv.cookieSecure(),
      domain: AuthEnv.cookieDomain(),
    },
    apiKey: AuthEnv.apiKey(),
    canCreatePublicLobbies: AuthEnv.allowPublicLobbies(),
    isOriginAllowed: makeOriginPredicate(
      audience,
      isDev,
      AuthEnv.extraAllowedOrigins(),
    ),
    log: authLogger,
    // [ARENA] Empty leaves /join_verify unregistered; see AuthEnv.
    turnstileSecret: AuthEnv.turnstileSecretKey(),
    isDev,
  });

  // [ARENA] Said out loud, because the failure is silent otherwise: with no
  // secret the widget still renders and every join is admitted unverified.
  if (AuthEnv.turnstileSecretKey() === "") {
    authLogger.warn(
      "TURNSTILE_SECRET_KEY is unset — /join_verify is not served, so the " +
        "game server falls open and the Turnstile widget verifies nothing.",
    );
  } else {
    authLogger.info("Turnstile siteverify enabled on /join_verify");
  }

  const port = AuthEnv.port();
  app.listen(port, () => {
    authLogger.info(`Auth service listening on ${port}`, {
      issuer,
      audience,
      kid: key.kid,
      ephemeralKey: key.ephemeral,
    });
  });
}

startAuthServer().catch((e) => {
  authLogger.error(
    `Auth service failed to start: ${e instanceof Error ? e.message : e}`,
  );
  process.exit(1);
});
