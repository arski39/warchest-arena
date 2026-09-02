import {
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import nacl from "tweetnacl";
import {
  buildCancelMatchIx,
  buildCloseMatchIx,
  buildCreateAtaIdempotentIx,
  buildEd25519VerifyIx,
  buildSettleMatchIx,
  deriveAta,
  MatchStatus,
  settleMessagePreimage,
  type MatchAccountView,
} from "../../core/arena/arenaProgram";
import type { ClientSendWinnerMessage } from "../../core/Schemas";
import type { Client } from "../Client";
import { matchRegistry, type WagerConfig } from "./matchRegistry";
import { connection, fetchMatchAccount } from "./rpcClient";
import { serverKeypair } from "./serverKeypair";
import { walletRegistry } from "./walletRegistry";

/**
 * [ARENA] Pays out a wagered match, or refunds it if it never started.
 *
 * Called from GameServer.archiveGame() once winner consensus is reached. Note
 * the caveat in CLAUDE.md: the winner is what a majority of clients reported,
 * not something the server computed. This function signs what it is given.
 *
 * There is deliberately no dev-mode short-circuit. A game only appears in
 * matchRegistry if createWageredMatch put a real escrow on chain, so skipping
 * submission in dev would not avoid touching the chain — it would leave real
 * staked tokens locked in a vault with no path out.
 */
export async function settle(
  gameId: string,
  winner: ClientSendWinnerMessage | null | undefined,
  allClients: ReadonlyMap<string, Client>,
): Promise<void> {
  const wager = matchRegistry.get(gameId);
  if (!wager) return; // free-practice game — nothing to settle

  const match = await fetchMatchAccount(wager);
  if (match === null) {
    // Keep the registry entry: the escrow may simply not be visible on this RPC
    // yet, and dropping it discards the only pointer we hold to the pot.
    console.error(
      `[arena/settler] match account ${wager.matchPDA} not found for game ${gameId}`,
    );
    return;
  }

  if (
    match.status === MatchStatus.Settled ||
    match.status === MatchStatus.Cancelled
  ) {
    console.log(
      `[arena/settler] game=${gameId} is already ${MatchStatus[match.status]} on-chain`,
    );
    matchRegistry.unregister(gameId);
    return;
  }

  // join_match only flips Open -> InProgress once player_count reaches
  // max_players, and settle_match accepts nothing but InProgress. A lobby that
  // played out without filling every staked seat therefore cannot be paid out
  // at all, so the honest resolution is to hand everyone their stake back
  // rather than leave the pot sitting in the vault.
  if (match.status === MatchStatus.Open) {
    console.warn(
      `[arena/settler] game=${gameId} never filled (${match.playerCount}/${match.maxPlayers} staked); refunding`,
    );
    await refund(gameId, wager, match);
    return;
  }

  const winnerWallet = winner
    ? resolveWinnerWallet(gameId, winner, allClients, match)
    : null;
  if (winner === null || winner === undefined || winnerWallet === null) {
    // Nobody can be paid, but the stakes are real. Refunding is not available
    // here: the match is InProgress, which cancel_match refuses.
    console.error(
      `[arena/settler] game=${gameId} has no resolvable winner; pot stays in escrow at ${wager.matchPDA}`,
    );
    return;
  }

  await payOut(
    gameId,
    wager,
    match,
    winnerWallet,
    buildScores(match, winner, allClients),
  );
}

/**
 * The winning wallet, or null when it cannot be established. Every failure path
 * leaves the pot untouched rather than guessing — paying the wrong wallet is
 * not recoverable.
 */
function resolveWinnerWallet(
  gameId: string,
  winner: ClientSendWinnerMessage,
  allClients: ReadonlyMap<string, Client>,
  match: MatchAccountView,
): PublicKey | null {
  if (!winner.winner) {
    console.error(`[arena/settler] no winner reported for game ${gameId}`);
    return null;
  }
  const [winnerType, winnerClientId] = winner.winner;
  if (winnerType !== "player") {
    // A team win has no single payee, and settle_match pays exactly one.
    console.error(
      `[arena/settler] ${winnerType} wins are not supported for wagered matches (game ${gameId})`,
    );
    return null;
  }

  const persistentId = allClients.get(winnerClientId)?.persistentID;
  const wallet = persistentId ? walletRegistry.get(persistentId) : undefined;
  if (wallet === undefined) {
    console.error(
      `[arena/settler] no wallet registered for winner ${winnerClientId} in game ${gameId}`,
    );
    return null;
  }

  let winnerKey: PublicKey;
  try {
    winnerKey = new PublicKey(wallet);
  } catch {
    console.error(`[arena/settler] winner wallet ${wallet} is not an address`);
    return null;
  }

  // settle_match enforces this too (WinnerNotInMatch); checking first turns a
  // rejected transaction into a log line that names the problem.
  if (!match.players.some((p) => p.equals(winnerKey))) {
    console.error(
      `[arena/settler] winner ${wallet} did not stake in game ${gameId}`,
    );
    return null;
  }
  return winnerKey;
}

/**
 * Scores aligned with `match.players` — join order, which is the order
 * settle_match hashes them in. Rebuilt from chain state rather than from any
 * server-side ordering so the signed digest is reproducible by anyone holding
 * the match account and the final stats.
 *
 * A staker with no reported stats scores 0 rather than being skipped: the
 * vector is positional, so omitting an entry would shift every later player
 * onto somebody else's score.
 */
export function buildScores(
  match: MatchAccountView,
  winner: ClientSendWinnerMessage,
  allClients: ReadonlyMap<string, Client>,
): bigint[] {
  const byWallet = new Map<string, bigint>();
  for (const [clientId, stats] of Object.entries(winner.allPlayersStats)) {
    const persistentId = allClients.get(clientId)?.persistentID;
    const wallet = persistentId ? walletRegistry.get(persistentId) : undefined;
    if (wallet === undefined) continue;
    byWallet.set(wallet, BigInt(stats?.finalTiles ?? 0));
  }
  return match.players.map((p) => byWallet.get(p.toBase58()) ?? 0n);
}

/**
 * The rake destination. settle_match requires the account even at 0 bps, in
 * which case it transfers nothing to it — so the winner's own token account is
 * a safe stand-in and saves operators configuring something never used.
 */
function treasuryTokenAccount(
  match: MatchAccountView,
  winnerToken: PublicKey,
): PublicKey | null {
  const configured = process.env.TREASURY_TOKEN_ACCOUNT;
  if (configured) {
    try {
      return new PublicKey(configured);
    } catch {
      console.error(
        `[arena/settler] TREASURY_TOKEN_ACCOUNT "${configured}" is not an address`,
      );
      return null;
    }
  }
  if (match.rakeBps > 0) return null; // the rake would go nowhere
  return winnerToken;
}

async function payOut(
  gameId: string,
  wager: WagerConfig,
  match: MatchAccountView,
  winner: PublicKey,
  scores: bigint[],
): Promise<void> {
  const authority = serverKeypair();
  const matchPda = new PublicKey(wager.matchPDA);

  // join_match accepts any token account with the right owner and mint, so a
  // winner who staked from a non-canonical one may have no ATA yet, and
  // settle_match will not create the account it pays into.
  const winnerToken = deriveAta(winner, match.mint);
  await ensureTokenAccount(winnerToken, winner, match.mint);

  const treasuryToken = treasuryTokenAccount(match, winnerToken);
  if (treasuryToken === null) {
    console.error(
      `[arena/settler] rake is ${match.rakeBps} bps but TREASURY_TOKEN_ACCOUNT is unset; refusing to settle game ${gameId}`,
    );
    return;
  }

  const digest = createHash("sha256")
    .update(settleMessagePreimage(matchPda, winner, scores))
    .digest();
  const signature = nacl.sign.detached(digest, authority.secretKey);

  // Order is load-bearing: settle_match reads instruction 0 out of the
  // instructions sysvar and rejects anything that is not the ed25519 verify.
  const tx = new Transaction()
    .add(buildEd25519VerifyIx(authority.publicKey.toBytes(), signature, digest))
    .add(
      buildSettleMatchIx({
        programId: new PublicKey(wager.programId),
        authority: authority.publicKey,
        matchPda,
        vault: new PublicKey(wager.vault),
        winnerToken,
        treasuryToken,
        winner,
        scores,
      }),
    );

  const txSig = await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: "confirmed",
  });
  console.log(
    `[arena/settler] settled game=${gameId} winner=${winner.toBase58()} tx=${txSig}`,
  );
  matchRegistry.unregister(gameId);
}

/**
 * Cancels an escrow and hands every staker their stake back, returning the
 * confirmed transaction signature.
 *
 * Takes chain state and nothing else — no game id, no registry entry — because
 * the H2 sweeper calls it for orphans whose lobby died with the worker process
 * that held them. Keeping one implementation of "how to refund an escrow"
 * matters more than the small awkwardness of the signature: the players[]-order
 * pairing below is the kind of detail that goes wrong quietly in a second copy.
 */
export async function cancelAndRefund(
  programId: PublicKey,
  matchPda: PublicKey,
  match: MatchAccountView,
): Promise<string> {
  const authority = serverKeypair();

  // cancel_match pairs remaining_accounts[i] with stakes[i], so these must be
  // in players[] order, and each must already exist.
  const refundTokenAccounts = match.players.map((p) =>
    deriveAta(p, match.mint),
  );
  for (const [i, account] of refundTokenAccounts.entries()) {
    await ensureTokenAccount(account, match.players[i]!, match.mint);
  }

  return await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      buildCancelMatchIx({
        programId,
        authority: authority.publicKey,
        matchPda,
        // From chain rather than from the registry: the program pins this with
        // `address = match_account.vault`, so this is the only value that can
        // ever succeed, and the sweeper has no registry entry to read anyway.
        vault: match.vault,
        refundTokenAccounts,
      }),
    ),
    [authority],
    { commitment: "confirmed" },
  );
}

/**
 * [ARENA] Closes a finished match and its empty vault, returning both rents to
 * the authority.
 *
 * Worth doing rather than leaving the account behind: nothing else removes a
 * terminal match, so without this every match this key ever created holds its
 * rent forever and stays in the sweeper's getProgramAccounts scan for the life
 * of the key.
 *
 * The program refuses a vault that still holds tokens, which is reachable —
 * cancel_match refunds `stakes`, not the balance, so a match somebody donated
 * into keeps a residue. The caller treats that as a per-match failure.
 */
export async function closeMatchAccount(
  programId: PublicKey,
  matchPda: PublicKey,
  match: MatchAccountView,
): Promise<string> {
  const authority = serverKeypair();
  return await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      buildCloseMatchIx({
        programId,
        authority: authority.publicKey,
        matchPda,
        vault: match.vault,
      }),
    ),
    [authority],
    { commitment: "confirmed" },
  );
}

async function refund(
  gameId: string,
  wager: WagerConfig,
  match: MatchAccountView,
): Promise<void> {
  const txSig = await cancelAndRefund(
    new PublicKey(wager.programId),
    new PublicKey(wager.matchPDA),
    match,
  );
  console.log(
    `[arena/settler] refunded game=${gameId} to ${match.players.length} stakers tx=${txSig}`,
  );
  matchRegistry.unregister(gameId);
}

/**
 * Creates `ata` if it is missing. Sent as its own transaction rather than as a
 * prelude to the settle one, so it can neither push that over the size limit
 * nor disturb the ed25519-at-index-0 requirement.
 */
async function ensureTokenAccount(
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): Promise<void> {
  if ((await connection.getAccountInfo(ata, "confirmed")) !== null) return;
  const authority = serverKeypair();
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      buildCreateAtaIdempotentIx(authority.publicKey, owner, mint),
    ),
    [authority],
    { commitment: "confirmed" },
  );
}
