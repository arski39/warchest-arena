import {
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import type { GameID } from "../../core/Schemas";
import {
  buildCreateMatchIx,
  MAX_RAKE_BPS,
} from "../../core/arena/arenaProgram";
import { matchRegistry, type WagerConfig } from "./matchRegistry";
import { getConnection } from "./rpcClient";
import { serverKeypair, serverKeypairPath } from "./serverKeypair";

/** Thrown when the host asks for a wagered lobby the server cannot escrow. */
export class WagerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WagerUnavailableError";
  }
}

/**
 * The `nonce` seed of the match PDA, derived from the game id so the address is
 * reproducible from the lobby alone — no counter to persist, and a retry for
 * the same lobby lands on the same PDA instead of orphaning the first escrow.
 *
 * First 8 bytes of sha256(gameId), read little-endian to match
 * `nonce.to_le_bytes()` in the program's seed list.
 */
export function nonceFromGameId(gameId: string): bigint {
  const digest = createHash("sha256").update(gameId, "utf8").digest();
  return digest.readBigUInt64LE(0);
}

/** Present only when the arena program and server keypair are both configured. */
export function arenaProgramId(): PublicKey | null {
  const raw = process.env.ARENA_PROGRAM_ID;
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}

/**
 * The house cut, in basis points. An operator setting, never a host one — a
 * lobby host must not be able to choose what the house takes, and the program
 * caps it at MAX_RAKE_BPS regardless. Defaults to 0 (no rake).
 */
export function arenaRakeBps(): number {
  const raw = process.env.ARENA_RAKE_BPS;
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_RAKE_BPS) {
    throw new WagerUnavailableError(
      `ARENA_RAKE_BPS must be an integer 0..${MAX_RAKE_BPS}, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * [ARENA] Ceiling on a single seat's stake, in token base units, or null for
 * no ceiling. Operator-set like the rake — a lobby host must not be able to
 * raise the house's exposure.
 *
 * Exists because the accepted-risk section of CLAUDE.md says not to raise
 * stake limits while winner determination is still client-voted, and until now
 * there was no limit to raise: the program bounds `rake_bps` and `max_players`
 * but leaves `entry_fee` unbounded, and the endpoint accepted any non-zero u64.
 *
 * Server-side rather than on-chain on purpose. It is policy, not fund safety —
 * the escrow is equally sound at any stake — and a compiled-in constant could
 * not be denominated sensibly anyway, since the cap is meaningless without the
 * mint's decimals.
 */
export function arenaMaxEntryFee(): bigint | null {
  const raw = process.env.ARENA_MAX_ENTRY_FEE;
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new WagerUnavailableError(
      `ARENA_MAX_ENTRY_FEE must be a non-negative integer, got "${raw}"`,
    );
  }
  const parsed = BigInt(raw);
  if (parsed <= 0n) {
    throw new WagerUnavailableError(
      `ARENA_MAX_ENTRY_FEE must be greater than zero, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * Whether a proposed stake is allowed. `true` when no ceiling is configured.
 *
 * Split out from the endpoint so the boundary — at the cap is fine, one above
 * is not — is testable without standing up express.
 */
export function entryFeeWithinCap(entryFee: bigint): boolean {
  const cap = arenaMaxEntryFee();
  return cap === null || entryFee <= cap;
}

export interface CreateWageredMatchInput {
  mint: string;
  entryFee: bigint;
  maxPlayers: number;
}

/**
 * Creates the on-chain MatchAccount escrow for a wagered game and registers the
 * config in matchRegistry.
 *
 * There is deliberately no dev-mode shortcut here. A game in the registry is
 * treated as wagered everywhere downstream — the join gate demands a wallet
 * signature, the settler tries to pay out — so registering a lobby whose escrow
 * does not exist would advertise a stake nobody can win. If the program is not
 * configured, this throws and the lobby stays free-to-play.
 */
export async function createWageredMatch(
  gameId: GameID,
  config: CreateWageredMatchInput,
): Promise<WagerConfig> {
  const programId = arenaProgramId();
  if (programId === null) {
    throw new WagerUnavailableError(
      "ARENA_PROGRAM_ID is unset or not a valid address",
    );
  }
  if (serverKeypairPath() === undefined) {
    throw new WagerUnavailableError("SERVER_KEYPAIR_PATH env var not set");
  }

  const authority = serverKeypair();
  const mint = new PublicKey(config.mint);
  const nonce = nonceFromGameId(gameId);
  const rakeBps = arenaRakeBps();

  const { ix, matchPda, vault } = buildCreateMatchIx({
    programId,
    authority: authority.publicKey,
    mint,
    entryFee: config.entryFee,
    maxPlayers: config.maxPlayers,
    rakeBps,
    nonce,
  });

  // The authority pays rent for the MatchAccount and the vault ATA. It never
  // custodies stake — that sits in the vault, which only the program can move.
  const txSig = await sendAndConfirmTransaction(
    getConnection(),
    new Transaction().add(ix),
    [authority],
    { commitment: "confirmed" },
  );

  const wager: WagerConfig = {
    matchPDA: matchPda.toBase58(),
    vault: vault.toBase58(),
    mint: config.mint,
    entryFee: config.entryFee,
    maxPlayers: config.maxPlayers,
    rakeBps,
    nonce,
    programId: programId.toBase58(),
  };
  matchRegistry.register(gameId, wager);
  console.log(
    `[arena/matchCreator] created wagered game=${gameId} matchPDA=${wager.matchPDA} tx=${txSig}`,
  );
  return wager;
}
