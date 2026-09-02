// [ARENA] new file — generate the auth service's Ed25519 signing key.
//
// Usage: npx tsx scripts/generateAuthKey.ts <path>
//
// The service deliberately refuses to generate this itself for a missing path.
// A container that minted a key on every start would invalidate every session
// on each deploy, and the game server caches the first JWKS response for the
// life of its process -- so it would keep rejecting tokens until it too
// restarted. Making key creation an explicit, one-time act is what keeps that
// from being a silent operational failure.
import { existsSync } from "fs";
import { chmod, mkdir, writeFile } from "fs/promises";
import { exportJWK, generateKeyPair } from "jose";
import path from "path";

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npx tsx scripts/generateAuthKey.ts <path>");
    process.exit(1);
  }
  if (existsSync(target)) {
    // Never overwrite. Rotating the key logs everyone out, and doing it by
    // accident because a path was reused is not a recoverable mistake.
    console.error(
      `Refusing to overwrite ${target}. Delete it first if you really mean ` +
        `to rotate the key -- every outstanding session dies with the old one.`,
    );
    process.exit(1);
  }

  const { privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const jwk = await exportJWK(privateKey);

  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await writeFile(target, JSON.stringify(jwk, null, 2) + "\n", {
    mode: 0o600,
  });
  // writeFile's mode only applies at creation; set it again so a pre-existing
  // umask cannot leave the private key world-readable.
  await chmod(target, 0o600);

  console.log(`Wrote a private Ed25519 JWK to ${target} (mode 600).`);
  console.log(`Point AUTH_SIGNING_KEY_PATH at it. Never commit it.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
