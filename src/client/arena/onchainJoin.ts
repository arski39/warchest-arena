import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { buildJoinMatchIx, deriveAta } from "../../core/arena/arenaProgram";
import { getConnectedWallet } from "./WalletProvider";

export interface JoinMatchParams {
  programId: string; // base58 arena program id the escrow was created under
  rpcUrl: string; // public RPC endpoint (see ARENA_PUBLIC_RPC_URL)
  matchPDA: string; // base58 on-chain MatchAccount address
  vault: string; // base58 PDA-owned ATA the stake is transferred into
  mint: string; // base58 SPL token mint
  entryFee: bigint;
}

/** The player has no token account for this mint, or not enough in it. */
export class InsufficientStakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientStakeError";
  }
}

/**
 * Submits `join_match`, transferring the entry fee from the player's own token
 * account into the escrow vault. Returns the confirmed transaction signature,
 * which the client forwards to the server as `ClientJoinMessage.onchainTxSig`.
 *
 * The instruction carries no amount: the program transfers
 * `match_account.entry_fee`, read on-chain. `entryFee` here is only used for
 * the balance pre-check, so a client cannot understake by lying about it.
 */
export async function joinMatchOnChain(
  params: JoinMatchParams,
): Promise<string> {
  const wallet = getConnectedWallet();
  if (!wallet) throw new Error("Wallet not connected");

  const connection = new Connection(params.rpcUrl, "confirmed");
  const player = new PublicKey(wallet.publicKey);
  const mint = new PublicKey(params.mint);
  const playerToken = deriveAta(player, mint);

  // Pre-flight the balance. The program enforces this too (ArenaError::
  // FeeMismatch), but failing here means the player never sees a wallet prompt
  // for a transaction that cannot succeed, and gets a message that says why.
  let balance: bigint;
  try {
    const result = await connection.getTokenAccountBalance(playerToken);
    balance = BigInt(result.value.amount);
  } catch {
    throw new InsufficientStakeError(
      "No token account for this match's mint. Acquire the stake token first.",
    );
  }
  if (balance < params.entryFee) {
    throw new InsufficientStakeError(
      `Entry fee is ${params.entryFee} but the wallet holds ${balance}.`,
    );
  }

  const ix = buildJoinMatchIx({
    programId: new PublicKey(params.programId),
    player,
    matchPda: new PublicKey(params.matchPDA),
    vault: new PublicKey(params.vault),
    playerToken,
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: player,
    blockhash,
    lastValidBlockHeight,
  }).add(ix);

  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    preflightCommitment: "confirmed",
  });

  // Confirm before returning: the server verifies the signature against chain
  // state, so handing it back unconfirmed would just fail the join gate.
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (result.value.err !== null) {
    throw new Error(
      `join_match failed on-chain: ${JSON.stringify(result.value.err)}`,
    );
  }
  return signature;
}
