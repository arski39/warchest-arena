// [ARENA] new file — hand-rolled bindings to the Anchor `arena` escrow program.
//
// Every constant here is transcribed from the generated `target/idl/arena.json`
// (Anchor 0.31 format). Nothing is guessed: `tests/arenaProgram.ts` at the
// project root diffs all of it against that IDL on every `anchor test` run, so
// a program change that shifts a discriminator or a field offset fails the
// suite instead of silently producing a transaction the chain rejects.
//
// Why not `@coral-xyz/anchor`: the client half of this file (Stage 3's
// join_match) ships to the browser, and pulling Anchor's coder in for four
// instructions is a large bundle for no benefit. Keep this module free of Node
// built-ins and of OpenFrontIO imports — the root test imports it directly.

import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** `MAX_PLAYERS` in programs/arena/src/state.rs. Sizes `players` and `stakes`. */
export const MAX_PLAYERS = 16;

/** Program-enforced ceiling on `rake_bps` (10%). `ArenaError::RakeTooHigh`. */
export const MAX_RAKE_BPS = 1000;

/**
 * Anchor instruction discriminators, verbatim from the IDL.
 *
 * These are `sha256("global:" + name)[0..8]` where `name` is the **snake_case**
 * Rust function name. Anchor 0.31 names instructions in snake_case in the IDL;
 * 0.30 used camelCase. Hashing the camelCase spelling produces eight entirely
 * different bytes that the program rejects, so the values are pinned here
 * rather than computed from whichever spelling happens to be at hand.
 */
export const IX_DISCRIMINATOR = {
  cancel_match: Uint8Array.from([142, 136, 247, 45, 92, 112, 180, 83]),
  create_match: Uint8Array.from([107, 2, 184, 145, 70, 142, 17, 165]),
  join_match: Uint8Array.from([244, 8, 47, 130, 192, 59, 179, 44]),
  settle_match: Uint8Array.from([71, 124, 117, 96, 191, 217, 116, 24]),
} as const;

/** `sha256("account:MatchAccount")[0..8]` — the first 8 bytes of the account. */
export const MATCH_ACCOUNT_DISCRIMINATOR = Uint8Array.from([
  235, 36, 243, 39, 81, 16, 144, 87,
]);

/**
 * Byte offsets into a `MatchAccount`, in Borsh declaration order. Anchor packs
 * with no alignment padding, so each offset is just the sum of what precedes
 * it. Consumed by the Stage 4 decoder in rpcClient.ts.
 */
export const MATCH_ACCOUNT_LAYOUT = {
  discriminator: 0,
  authority: 8,
  mint: 40,
  vault: 72,
  entryFee: 104,
  rakeBps: 112,
  maxPlayers: 114,
  playerCount: 115,
  status: 116,
  players: 117,
  stakes: 629,
  createdAt: 757,
  nonce: 765,
  bump: 773,
} as const;

/** Total on-chain size, matching `MatchAccount::SPACE`. */
export const MATCH_ACCOUNT_SIZE = 774;

/** `MatchStatus` discriminants, in declaration order. */
export enum MatchStatus {
  Open = 0,
  InProgress = 1,
  Settled = 2,
  Cancelled = 3,
}

//
// Encoding helpers
//

function u64LE(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function u16LE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`u16 out of range: ${value}`);
  }
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

//
// Address derivation
//

/**
 * `[b"match", authority, nonce.to_le_bytes()]` — see create_match.rs's
 * `#[account(seeds = ...)]`. Returns the PDA and its bump.
 */
export function deriveMatchPda(
  programId: PublicKey,
  authority: PublicKey,
  nonce: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("match"), authority.toBytes(), u64LE(nonce)],
    programId,
  );
}

/**
 * The vault: an associated token account owned by the match PDA itself. Standard
 * ATA derivation — `[owner, token_program, mint]` under the ATA program — which
 * is exactly what `associated_token::authority = match_account` produces.
 */
export function deriveVaultAta(
  matchPda: PublicKey,
  mint: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [matchPda.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** ATA for an ordinary wallet owner. Used for winner/treasury token accounts. */
export function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

//
// Instruction builders
//

export interface CreateMatchParams {
  programId: PublicKey;
  /** Signs, pays rent, and becomes `match_account.authority`. */
  authority: PublicKey;
  mint: PublicKey;
  entryFee: bigint;
  maxPlayers: number;
  rakeBps: number;
  nonce: bigint;
}

/**
 * Builds `create_match`. Account order is load-bearing and matches the IDL's
 * `accounts` array exactly: authority, match_account, vault, mint,
 * token_program, associated_token_program, system_program, rent.
 *
 * Args are Borsh-encoded in declaration order:
 * `entry_fee: u64, max_players: u8, rake_bps: u16, nonce: u64` — 27 bytes with
 * the discriminator.
 */
export function buildCreateMatchIx(params: CreateMatchParams): {
  ix: TransactionInstruction;
  matchPda: PublicKey;
  vault: PublicKey;
} {
  const { programId, authority, mint, entryFee, maxPlayers, rakeBps, nonce } =
    params;

  if (
    !Number.isInteger(maxPlayers) ||
    maxPlayers < 2 ||
    maxPlayers > MAX_PLAYERS
  ) {
    throw new Error(`maxPlayers must be 2..${MAX_PLAYERS}, got ${maxPlayers}`);
  }
  if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > MAX_RAKE_BPS) {
    throw new Error(`rakeBps must be 0..${MAX_RAKE_BPS}, got ${rakeBps}`);
  }

  const [matchPda] = deriveMatchPda(programId, authority, nonce);
  const vault = deriveVaultAta(matchPda, mint);

  const data = concat([
    IX_DISCRIMINATOR.create_match,
    u64LE(entryFee),
    Uint8Array.from([maxPlayers]),
    u16LE(rakeBps),
    u64LE(nonce),
  ]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  return { ix, matchPda, vault };
}
