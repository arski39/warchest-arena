// [ARENA] H1.3: decide at boot whether this server can actually escrow a
// wager, instead of finding out when a host presses the button.
//
// wageringConfigured() only asks whether two env vars are non-empty. Everything
// that can actually be wrong with them — a program id that is not deployed on
// this cluster, a keypair file that does not parse, an authority with no SOL to
// pay rent, a rake with nowhere to send it — surfaced later and worse:
//
//   * a bogus ARENA_PROGRAM_ID or an unfunded authority fails create_match, so
//     the host gets a 500 on a lobby they have already set up;
//   * ARENA_RAKE_BPS > 0 with no TREASURY_TOKEN_ACCOUNT is the bad one. Nothing
//     fails until settlement, by which point the stakes are in the vault and
//     settler.ts refuses to guess where the rake goes. The pot sits there until
//     someone intervenes.
//
// Boot is the right place to catch all of it: the failure mode becomes "this
// server does not offer wagering, and says why", which is the same state as an
// unconfigured server and therefore already safe.

import { PublicKey } from "@solana/web3.js";
import { arenaMaxEntryFee, arenaProgramId, arenaRakeBps } from "./matchCreator";
import { connection } from "./rpcClient";
import { serverKeypair, serverKeypairPath } from "./serverKeypair";

/**
 * Minimum authority balance, in lamports, before wagering is offered.
 *
 * A match costs roughly 0.0084 SOL that is **never reclaimed** — MatchAccount
 * has no close instruction — plus fees and any ATA the settler has to create.
 * 0.05 SOL is about six matches: enough that a server which passes this is not
 * about to fail on its first lobby, low enough not to be a nuisance on devnet.
 *
 * This is a smoke test, not a guarantee. The balance is read once, and nothing
 * re-checks it as it drains; an operational alarm is the real answer.
 */
export const MIN_AUTHORITY_LAMPORTS = 50_000_000; // 0.05 SOL

type Preflight =
  | { state: "ok" }
  /** Wagering was never asked for. The default, and not a problem. */
  | { state: "off" }
  | { state: "broken"; reason: string };

let result: Preflight = { state: "off" };

/** Whether a wagered lobby can be offered. False until preflight has passed. */
export function wageringOperational(): boolean {
  return result.state === "ok";
}

/**
 * Why wagering is unavailable, or null when it is available. `null` is also
 * returned for a deliberately unconfigured server — callers that need to tell
 * the two apart should use wageringOperational().
 */
export function wagerDisabledReason(): string | null {
  return result.state === "broken" ? result.reason : null;
}

/** Runs the checks and records the outcome. Never throws. */
export async function runWagerPreflight(): Promise<Preflight> {
  result = await check();

  if (result.state === "off") {
    console.log(
      "[arena/preflight] ARENA_PROGRAM_ID is unset — wagering disabled, every " +
        "lobby stays free to play.",
    );
  } else if (result.state === "broken") {
    console.error(
      `[arena/preflight] WAGERING DISABLED: ${result.reason}. ` +
        "Lobbies will stay free to play until this is fixed.",
    );
  } else {
    console.log("[arena/preflight] wagering enabled and verified.");
  }
  return result;
}

async function check(): Promise<Preflight> {
  const programId = arenaProgramId();
  if (programId === null) {
    // Distinguish "not asked for" from "asked for, but unparseable" — the
    // latter is a typo the operator wants to hear about, not a default.
    return process.env.ARENA_PROGRAM_ID
      ? {
          state: "broken",
          reason: `ARENA_PROGRAM_ID is not a valid base58 address ("${process.env.ARENA_PROGRAM_ID}")`,
        }
      : { state: "off" };
  }

  if (serverKeypairPath() === undefined) {
    return {
      state: "broken",
      reason:
        "ARENA_PROGRAM_ID is set but SERVER_KEYPAIR_PATH is not — there is no " +
        "authority to create matches or sign results",
    };
  }

  // Env that currently throws only at use. Calling each here converts a 500 on
  // a live lobby into a boot-time refusal.
  let authority: PublicKey;
  let rakeBps: number;
  try {
    authority = serverKeypair().publicKey;
    rakeBps = arenaRakeBps();
    arenaMaxEntryFee();
  } catch (e) {
    return {
      state: "broken",
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  // The one that would otherwise strand a pot: settler.ts refuses to settle a
  // rake it has nowhere to send, and by then the stakes are already escrowed.
  if (rakeBps > 0) {
    const treasury = process.env.TREASURY_TOKEN_ACCOUNT;
    if (!treasury) {
      return {
        state: "broken",
        reason: `ARENA_RAKE_BPS is ${rakeBps} but TREASURY_TOKEN_ACCOUNT is unset — settlement would refuse and leave the pot in escrow`,
      };
    }
    try {
      new PublicKey(treasury);
    } catch {
      return {
        state: "broken",
        reason: `TREASURY_TOKEN_ACCOUNT is not a valid base58 address ("${treasury}")`,
      };
    }
  }

  try {
    const [programInfo, balance] = await Promise.all([
      connection.getAccountInfo(programId),
      connection.getBalance(authority),
    ]);

    if (programInfo === null) {
      return {
        state: "broken",
        reason: `no account at ARENA_PROGRAM_ID ${programId.toBase58()} on this cluster — wrong id, or the program is not deployed here`,
      };
    }
    if (!programInfo.executable) {
      return {
        state: "broken",
        reason: `the account at ARENA_PROGRAM_ID ${programId.toBase58()} is not executable`,
      };
    }
    if (balance < MIN_AUTHORITY_LAMPORTS) {
      return {
        state: "broken",
        reason: `authority ${authority.toBase58()} holds ${balance} lamports, below the ${MIN_AUTHORITY_LAMPORTS} needed to pay match rent`,
      };
    }
  } catch (e) {
    // Fail closed, like the dev-bypass gate: an RPC we cannot reach at boot is
    // one we cannot settle through either.
    return {
      state: "broken",
      reason: `could not reach the RPC to verify the program and authority (${e instanceof Error ? e.message : String(e)})`,
    };
  }

  return { state: "ok" };
}
