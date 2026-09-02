// [ARENA] new file — hand-rolled bindings to the Anchor `arena` escrow program.
//
// Lives in core/ rather than server/ because both halves ship: the server
// builds create_match and settle_match, the browser builds join_match. Nothing
// under src/client/ may import from src/server/, so this is the shared home.
//
// Every constant here is transcribed from the generated `target/idl/arena.json`
// (Anchor 0.31 format). Nothing is guessed: `tests/arenaProgram.ts` at the
// project root diffs all of it against that IDL on every `anchor test` run, so
// a program change that shifts a discriminator or a field offset fails the
// suite instead of silently producing a transaction the chain rejects.
//
// Why not `@coral-xyz/anchor`: this module ships to the browser, and pulling
// Anchor's coder in for four instructions is a large bundle for no benefit.
// Keep it free of OpenFrontIO imports (the root test imports it across the repo
// boundary) and of Node built-ins. `buffer` is the one exception and is not
// really an exception: web3.js types instruction data as `Buffer`, and the npm
// `buffer` package resolves in the browser while Node prefers its own builtin
// for the same bare specifier.

import {
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";

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
 * How long after `created_at` an `InProgress` match may be force-cancelled,
 * in seconds. `MATCH_TIMEOUT_SECS` in programs/arena/src/state.rs.
 *
 * The recovery window for a filled match whose server died before settling:
 * `settle_match` needs a winner nobody can supply, so before the timeout that
 * pot has no on-chain path out at all. A sweeper deciding when to attempt
 * `cancel_match` reads this — too low and it spams transactions the program
 * rejects, too high and it leaves money locked longer than it must.
 *
 * Marked `#[constant]` in Rust so it reaches the IDL, and diffed against it in
 * tests/arenaProgram.ts rather than trusted as a hand-copied number.
 */
export const MATCH_TIMEOUT_SECS = 86_400;

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
  close_match: Uint8Array.from([79, 174, 36, 80, 233, 185, 176, 239]),
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

/** Width of the fixed-size `players` / `stakes` slots. */
const PUBKEY_SIZE = 32;
const U64_SIZE = 8;

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

export interface JoinMatchParams {
  programId: PublicKey;
  /** Signs and pays the entry fee. Appended to `match_account.players[]`. */
  player: PublicKey;
  matchPda: PublicKey;
  /** `match_account.vault`; the program pins it with `address = ...`. */
  vault: PublicKey;
  /** The player's own token account for the match mint. */
  playerToken: PublicKey;
}

/**
 * Builds `join_match`. Takes no args — the amount transferred is
 * `match_account.entry_fee`, read on-chain, so a client cannot understake.
 *
 * Account order matches the IDL exactly: player, match_account, vault,
 * player_token, token_program. Data is the bare 8-byte discriminator.
 */
export function buildJoinMatchIx(
  params: JoinMatchParams,
): TransactionInstruction {
  const { programId, player, matchPda, vault, playerToken } = params;

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: playerToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_DISCRIMINATOR.join_match),
  });
}

//
// Account decoding
//

/** A `MatchAccount` that failed validation before any field was trusted. */
export class MatchAccountDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchAccountDecodeError";
  }
}

export interface MatchAccountView {
  authority: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  entryFee: bigint;
  rakeBps: number;
  maxPlayers: number;
  /** Number of populated entries in `players` / `stakes`. */
  playerCount: number;
  status: MatchStatus;
  /**
   * Exactly `playerCount` wallets, in the order they joined. This order is
   * load-bearing for settlement: `settle_match`'s `scores` argument is indexed
   * against it, so standings must be rebuilt from here rather than from any
   * server-side ordering.
   */
  players: PublicKey[];
  /** Aligned with `players`; each is the entry fee at the time of joining. */
  stakes: bigint[];
  createdAt: bigint;
  nonce: bigint;
  bump: number;
}

/**
 * Decodes a `MatchAccount` from raw account bytes at the offsets above.
 *
 * Pure by design: no RPC, no Node built-ins, so bankrun can feed it bytes the
 * real program just wrote (`tests/arenaProgram.ts`) and the browser could
 * decode a match too. `fetchMatchAccount` in the server's rpcClient.ts is the
 * thin wrapper that does the network call.
 *
 * `owner` must be the account's on-chain owner. Checking it against the program
 * is not a formality: without it any account of the right length would decode
 * into a plausible-looking match, so a caller could be pointed at attacker-
 * controlled bytes and read whatever `players[]` they liked out of them.
 */
export function decodeMatchAccount(
  data: Uint8Array,
  owner: PublicKey,
  programId: PublicKey,
): MatchAccountView {
  if (!owner.equals(programId)) {
    throw new MatchAccountDecodeError(
      `account is owned by ${owner.toBase58()}, not the arena program ${programId.toBase58()}`,
    );
  }
  if (data.length !== MATCH_ACCOUNT_SIZE) {
    throw new MatchAccountDecodeError(
      `expected ${MATCH_ACCOUNT_SIZE} bytes, got ${data.length}`,
    );
  }
  for (let i = 0; i < MATCH_ACCOUNT_DISCRIMINATOR.length; i++) {
    if (data[i] !== MATCH_ACCOUNT_DISCRIMINATOR[i]) {
      throw new MatchAccountDecodeError(
        "account discriminator is not MatchAccount",
      );
    }
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const L = MATCH_ACCOUNT_LAYOUT;
  const pubkeyAt = (offset: number) =>
    new PublicKey(data.subarray(offset, offset + PUBKEY_SIZE));

  const statusByte = data[L.status]!;
  if (!(statusByte in MatchStatus)) {
    throw new MatchAccountDecodeError(`unknown MatchStatus ${statusByte}`);
  }

  const maxPlayers = data[L.maxPlayers]!;
  const playerCount = data[L.playerCount]!;
  // player_count indexes into players[]; a corrupt value would read past the
  // populated slots (or, unchecked, past the array) and invent participants.
  if (maxPlayers > MAX_PLAYERS || playerCount > maxPlayers) {
    throw new MatchAccountDecodeError(
      `implausible player counts: ${playerCount} of ${maxPlayers} (max ${MAX_PLAYERS})`,
    );
  }

  const players: PublicKey[] = [];
  const stakes: bigint[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push(pubkeyAt(L.players + i * PUBKEY_SIZE));
    stakes.push(view.getBigUint64(L.stakes + i * U64_SIZE, true));
  }

  return {
    authority: pubkeyAt(L.authority),
    mint: pubkeyAt(L.mint),
    vault: pubkeyAt(L.vault),
    entryFee: view.getBigUint64(L.entryFee, true),
    rakeBps: view.getUint16(L.rakeBps, true),
    maxPlayers,
    playerCount,
    status: statusByte as MatchStatus,
    players,
    stakes,
    createdAt: view.getBigInt64(L.createdAt, true),
    nonce: view.getBigUint64(L.nonce, true),
    bump: data[L.bump]!,
  };
}

//
// Settlement
//

/**
 * The exact bytes `settle_match` hashes to check the server's signature:
 * `match_account.key() || winner || scores.map(u64_le)`, concatenated raw.
 *
 * Not JSON, not the game id, no separators — see the `hashv` call in
 * `settle_match.rs`. Getting this wrong produces a valid-looking signature the
 * program rejects with `InvalidResultSignature`, and the pot stays locked.
 *
 * The hashing itself is left to the caller: sha256 has no synchronous
 * cross-realm implementation, and this module must stay browser-safe. Server
 * side that is `createHash("sha256").update(preimage).digest()`.
 */
export function settleMessagePreimage(
  matchPda: PublicKey,
  winner: PublicKey,
  scores: bigint[],
): Uint8Array {
  return concat([matchPda.toBytes(), winner.toBytes(), ...scores.map(u64LE)]);
}

/**
 * The ed25519 signature-verification instruction that must sit at **index 0**
 * of the settle transaction. `settle_match` reads instruction 0 out of the
 * instructions sysvar and refuses anything else, so this is positional, not
 * merely conventional.
 *
 * Built by web3.js rather than by hand: the program parses the offsets at
 * fixed header positions, and the canonical builder is the thing least likely
 * to drift from what the runtime's verifier expects.
 */
export function buildEd25519VerifyIx(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey,
    signature,
    message,
  });
}

export interface SettleMatchParams {
  programId: PublicKey;
  matchPda: PublicKey;
  vault: PublicKey;
  /** Token account the payout goes to. Must exist; the program will not create it. */
  winnerToken: PublicKey;
  /** Rake destination. Still a required account when rakeBps is 0. */
  treasuryToken: PublicKey;
  /** Match authority. Must sign — see buildSettleMatchIx. */
  authority: PublicKey;
  winner: PublicKey;
  /** Indexed against `MatchAccount.players[0..player_count]`, in join order. */
  scores: bigint[];
}

/**
 * Builds `settle_match`.
 *
 * The authority signs **and** attests through the ed25519 prelude above, and
 * the two prove different things: the prelude proves what was attested, and is
 * checkable by anyone holding the authority's pubkey, while the signature on
 * this instruction proves who submitted it. Without the latter, anyone who saw
 * a settle transaction could rebuild it with the same prelude and their own
 * `winnerToken` — the digest names the winner, not the destination account.
 *
 * Args are Borsh: `winner: pubkey`, then `scores: Vec<u64>` as a u32 length
 * prefix followed by the little-endian elements.
 */
export function buildSettleMatchIx(
  params: SettleMatchParams,
): TransactionInstruction {
  const { programId, authority, matchPda, vault, winnerToken, treasuryToken } =
    params;

  const lengthPrefix = new Uint8Array(4);
  new DataView(lengthPrefix.buffer).setUint32(0, params.scores.length, true);

  const data = concat([
    IX_DISCRIMINATOR.settle_match,
    params.winner.toBytes(),
    lengthPrefix,
    ...params.scores.map(u64LE),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: winnerToken, isSigner: false, isWritable: true },
      { pubkey: treasuryToken, isSigner: false, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface CancelMatchParams {
  programId: PublicKey;
  authority: PublicKey;
  matchPda: PublicKey;
  vault: PublicKey;
  /**
   * One token account per staker, **in `players[]` join order** — the program
   * pairs `remaining_accounts[i]` with `stakes[i]`, so a wrong order refunds
   * the wrong amounts to the wrong people.
   */
  refundTokenAccounts: PublicKey[];
}

/**
 * Builds `cancel_match`: refunds every staker. Authority-only. Accepts `Open`
 * at any age and `InProgress` only past MATCH_TIMEOUT_SECS.
 *
 * The program validates each refund account against `players[i]` — owner and
 * mint both — so a mis-ordered list is rejected rather than silently paying the
 * wrong people.
 */
export function buildCancelMatchIx(
  params: CancelMatchParams,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.matchPda, isSigner: false, isWritable: true },
      { pubkey: params.vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...params.refundTokenAccounts.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
    ],
    data: Buffer.from(IX_DISCRIMINATOR.cancel_match),
  });
}

export interface CloseMatchParams {
  programId: PublicKey;
  authority: PublicKey;
  matchPda: PublicKey;
  vault: PublicKey;
}

/**
 * Builds `close_match`: closes a `Settled` or `Cancelled` match and its empty
 * vault, returning both rents to the authority.
 *
 * Worth calling rather than leaving the account behind. Nothing else ever
 * removes a terminal match, so without this every match the authority creates
 * holds its rent forever and stays in the recovery sweeper's
 * `getProgramAccounts` scan for the life of the key.
 */
export function buildCloseMatchIx(
  params: CloseMatchParams,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: params.matchPda, isSigner: false, isWritable: true },
      { pubkey: params.vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_DISCRIMINATOR.close_match),
  });
}

/**
 * Associated Token Program `CreateIdempotent`. Needed because neither
 * `settle_match` nor `cancel_match` creates the account it pays into, and a
 * player is not obliged to have staked from their canonical ATA — `join_match`
 * only requires the right owner and mint. Without this a payout can fail on an
 * account that simply does not exist yet, leaving the pot locked.
 *
 * Idempotent: succeeds as a no-op if the ATA is already there.
 */
export function buildCreateAtaIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: deriveAta(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    // 0 = Create, 1 = CreateIdempotent.
    data: Buffer.from(Uint8Array.from([1])),
  });
}
