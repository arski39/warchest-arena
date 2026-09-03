// [ARENA] Phase 2: the single predicate behind both dev bypasses.
//
// Two bypasses used to fire on GameEnv.Dev alone: the jti-nonce fallback in
// walletAuthNonce, and the on-chain membership skip in Worker.ts. Together they
// let a dev player occupy a seat without staking, which flips the escrow to
// InProgress with a partial pot and then settles and pays out. With
// ARENA_PROGRAM_ID pointed anywhere real, that is dev mode moving real tokens.
//
// So the bypass is now opt-in (ARENA_DEV_BYPASS) *and* refuses to activate
// unless the cluster is provably not mainnet.

import { GameEnv } from "../../core/configuration/Config";
import { ServerEnv } from "../ServerEnv";
import { getConnection } from "./rpcClient";

/**
 * Genesis hashes of the public clusters. Only mainnet is disqualifying; the
 * others are listed so the log can name what it found.
 *
 * The genesis hash rather than the URL because the URL proves nothing. A
 * provider endpoint need not contain "devnet", a reverse proxy can hide it
 * entirely, and a typo'd variable pointing at mainnet reads as innocuous text.
 * Asking the chain what it is cannot be fooled by any of that.
 */
const GENESIS = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet-beta",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
} as const;

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** Resolved by resolveDevBypass(). Unresolved reads as off — see below. */
let enabled = false;

/**
 * Whether the operator asked for the bypass at all. Env only, no network.
 *
 * Requesting it is necessary but not sufficient: resolveDevBypass() still has
 * to agree the cluster is safe.
 */
export function devBypassRequested(): boolean {
  return (
    ServerEnv.env() === GameEnv.Dev && process.env.ARENA_DEV_BYPASS === "true"
  );
}

/**
 * Whether the bypass is actually in force. **The only thing call sites should
 * consult**, and it is deliberately synchronous: walletAuthNonce cannot await,
 * and the answer is fixed for the process lifetime anyway.
 *
 * False until resolveDevBypass() has run and agreed, so every failure mode —
 * not requested, mainnet, RPC unreachable, resolve never called — lands on the
 * strict path. That is the safe direction, and it costs nothing in production:
 * the check only runs when the bypass was requested, so a flaky RPC can never
 * affect a server that never asked for it.
 */
export function devBypassEnabled(): boolean {
  return enabled;
}

/**
 * Decides once, at boot, whether the bypass may be honoured. Call before the
 * process starts serving; it is safe to call in both the master and each
 * worker, since module state is per-process.
 */
export async function resolveDevBypass(): Promise<boolean> {
  if (!devBypassRequested()) {
    enabled = false;
    return false;
  }

  let genesis: string;
  try {
    genesis = await getConnection().getGenesisHash();
  } catch (e) {
    // Fail closed. An unreachable RPC means we cannot rule out mainnet, and
    // "the bypass quietly stayed off in dev" is a far better outcome than
    // "we assumed devnet and paid out real tokens".
    enabled = false;
    console.error(
      "[arena/devBypass] ARENA_DEV_BYPASS is set but the cluster could not be " +
        `identified (${e instanceof Error ? e.message : String(e)}). ` +
        "Bypass NOT enabled — wagered joins will require a real signature and " +
        "a real on-chain stake.",
    );
    return false;
  }

  const cluster: string = GENESIS[genesis as keyof typeof GENESIS] ?? "unknown";

  if (genesis === MAINNET_GENESIS) {
    enabled = false;
    console.error(
      "[arena/devBypass] REFUSING to enable ARENA_DEV_BYPASS: SOLANA_RPC_URL " +
        "points at mainnet-beta. The bypass lets a player take a seat without " +
        "staking, which settles a partial pot and pays out real tokens. " +
        "Point SOLANA_RPC_URL at devnet or unset ARENA_DEV_BYPASS.",
    );
    return false;
  }

  // Unknown genesis is allowed on purpose: a local test validator mints a new
  // one every time it starts, and refusing it would make the bypass useless
  // for exactly the case it exists to serve.
  enabled = true;
  console.warn(
    `[arena/devBypass] ENABLED on cluster "${cluster}" (genesis ${genesis}). ` +
      "Wallet signatures fall back to the game id and the on-chain stake check " +
      "is SKIPPED — players can occupy wagered seats without paying. Never run " +
      "this against a cluster whose tokens matter.",
  );
  return true;
}

/** Logs each time a bypass is actually taken, so it is never silent. */
export function logBypassUse(site: string, gameId: string): void {
  console.warn(
    `[arena/devBypass] ${site} bypassed for game ${gameId} — ARENA_DEV_BYPASS is on.`,
  );
}
