import { includeIgnoreFile } from "@eslint/compat";
import pluginJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, ".gitignore");

/** @type {import('eslint').Linter.Config[]} */
export default [
  includeIgnoreFile(gitignorePath),
  {
    ignores: [
      "src/server/gatekeeper/**",
      "tests/pathfinding/playground/**",
      ".claude/**",
    ],
  },
  { files: ["**/*.{js,mjs,cjs,ts}"] },
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "__mocks__/fileMock.js",
            "eslint.config.js",
            "scripts/sync-assets.mjs",
            "tests/matchmaking/*.mjs",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Disable rules that would fail. The failures should be fixed, and the entries here removed.
      "@typescript-eslint/no-explicit-any": "off",
      "no-unused-vars": "off",
    },
  },
  {
    rules: {
      // Enable rules
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      eqeqeq: "error",
      "no-case-declarations": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
        },
      ],
    },
  },
  {
    // [ARENA] Keep @solana/web3.js out of the MAIN bundle.
    //
    // Main.ts imports WalletProvider at module scope and calls
    // mountWalletProvider() there, so every module below is in the entry chunk
    // for every player -- including the free-to-play ones who will never stake.
    // @solana/web3.js is ~294 kB. The lazy boundary is Main.ts's
    // `await import("./arena/wagerJoinFlow")`, and everything Solana-shaped
    // belongs on the far side of it.
    //
    // This was previously enforced only by comments in walletLogin.ts and
    // onchainJoin.ts. One `import { Transaction }` instead of
    // `import type { Transaction }` would have undone it silently -- nothing in
    // tsc, lint or the test suite would have noticed. Now something does.
    files: [
      "src/client/arena/WalletProvider.ts",
      "src/client/arena/walletStandard.ts",
      "src/client/arena/walletSession.ts",
      "src/client/arena/walletLogin.ts",
      "src/client/arena/WalletPicker.ts",
      "src/client/arena/WalletBalanceCard.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@solana/web3.js",
              message:
                "This module is in the main chunk. Import it lazily from a file behind Main.ts's wagerJoinFlow dynamic import instead -- see the note in WalletProvider.ts.",
            },
          ],
        },
      ],
    },
  },
];
