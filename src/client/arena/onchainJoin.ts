import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildJoinMatchIx,
  decodeMatchAccount,
  decodeTokenAccount,
  deriveAta,
  MatchStatus,
} from "../../core/arena/arenaProgram";
import { getConnectedWallet } from "./WalletProvider";

/** Joins simulation log lines. A char code, so no quoting layer can mangle it. */
const LOG_SEPARATOR = String.fromCharCode(10);

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
 * [ARENA] The RPC could not be reached, so nothing is known either way.
 *
 * Kept distinct from InsufficientStakeError because the two call for opposite
 * responses and the wrong one is actively misleading. `ARENA_PUBLIC_RPC_URL` is
 * the *keyless* endpoint handed to every browser — `api.devnet.solana.com` on
 * this deployment — which CLAUDE.md records as rate-limiting hard enough to 429
 * a single test run. Telling a player who holds the token that they do not own
 * it sends them off to acquire one they already have.
 *
 * The server draws the same line for the same reason and it is mutation-tested
 * there (`MembershipCheck.failure === "rpc-unavailable"`, ArenaMembershipRetry.
 * test.ts); this is the client half of it, on the same throttled endpoint.
 */
export class StakeRpcUnavailableError extends Error {
  /** Suffix of the `wager_lobby.error_*` key the panel renders. */
  readonly code = "rpc_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "StakeRpcUnavailableError";
  }
}

/**
 * [ARENA] The stake transaction was submitted but its confirmation could not be
 * established, and a follow-up read found the wallet is NOT in `players[]`.
 *
 * Distinguished from a confirmed failure because the honest statement differs:
 * the transaction may still land. Retrying is safe either way — `join_match`
 * refuses a second stake from the same wallet with `AlreadyJoined` — so the
 * player is told to retry rather than told they were charged.
 */
export class StakeUnconfirmedError extends Error {
  /** Suffix of the `wager_lobby.error_*` key the panel renders. */
  readonly code = "unconfirmed";
  constructor(message: string) {
    super(message);
    this.name = "StakeUnconfirmedError";
  }
}

/**
 * [ARENA] The connected wallet has no usable way to put a transaction on chain.
 *
 * Reachable even though the picker filters for it: a wallet connected for
 * sign-in only is still what `getConnectedWallet()` returns when the stake gate
 * opens later in the same session.
 */
export class WalletCannotStakeError extends Error {
  /** Suffix of the `wager_lobby.error_*` key the panel renders. */
  readonly code = "wallet_cannot_stake";
  constructor(walletName: string) {
    super(`${walletName} cannot sign transactions on this network`);
    this.name = "WalletCannotStakeError";
  }
}

/**
 * Whether `wallet` already appears in the escrow's `players[]`.
 *
 * The program writes a wallet there only after `token::transfer` has moved the
 * entry fee into the vault, so presence is proof of payment — the same fact the
 * server's `verifyOnchainMembership` reads, and for the same reason: a
 * transaction signature proves only that something was sent.
 *
 * Returns null when the answer cannot be established at all, which the caller
 * must not read as "did not pay".
 */
async function alreadyStaked(
  connection: Connection,
  matchPda: PublicKey,
  programId: PublicKey,
  wallet: PublicKey,
): Promise<boolean | null> {
  try {
    const info = await connection.getAccountInfo(matchPda, "confirmed");
    if (info === null) return null;
    const match = decodeMatchAccount(info.data, info.owner, programId);
    return match.players.some((p) => p.equals(wallet));
  } catch {
    return null;
  }
}

/** What the escrow says right now, from the staking player's point of view. */
export interface EscrowState {
  status: MatchStatus;
  /** This wallet is already in `players[]`, so it has already paid. */
  alreadyStaked: boolean;
  playerCount: number;
  maxPlayers: number;
}

/**
 * [ARENA] Reads the escrow before the player is offered a stake button.
 *
 * Without this the prompt offered "JOIN & STAKE" on a match the program would
 * refuse, and the only feedback was the wallet's own failure: Phantom shows
 * "Failed to simulate the results of this request", and the panel printed the
 * raw simulation log ending in `custom program error: 0x1771`. Both of those
 * are the program working correctly — `join_match` pins
 * `match_account.status == Open` — but neither tells the player that the match
 * simply filled up, and one of them looks like the site is broken or hostile.
 *
 * The reload case is the one that matters most. A player who staked and then
 * refreshed is sent back through the gate, and the escrow is `InProgress` by
 * then because their own stake filled it. They were being asked to pay twice
 * for a seat they already own, and the payment could not have succeeded.
 *
 * Returns null when the answer cannot be established. The caller must not read
 * that as "closed": the RPC here is the shared keyless endpoint, so unreachable
 * is a routine outcome and the stake attempt itself is the better fallback.
 */
export async function readEscrowState(
  params: Pick<JoinMatchParams, "programId" | "rpcUrl" | "matchPDA">,
  walletAddress: string,
): Promise<EscrowState | null> {
  let wallet: PublicKey;
  let programId: PublicKey;
  let matchPda: PublicKey;
  try {
    wallet = new PublicKey(walletAddress);
    programId = new PublicKey(params.programId);
    matchPda = new PublicKey(params.matchPDA);
  } catch {
    return null;
  }
  const connection = new Connection(params.rpcUrl, "confirmed");
  try {
    const info = await connection.getAccountInfo(matchPda, "confirmed");
    if (info === null) return null;
    const match = decodeMatchAccount(info.data, info.owner, programId);
    return {
      status: match.status,
      alreadyStaked: match.players.some((p) => p.equals(wallet)),
      playerCount: match.playerCount,
      maxPlayers: match.maxPlayers,
    };
  } catch {
    return null;
  }
}

/** The `join_match` refusals worth naming, as `wager_lobby.error_*` suffixes. */
export type JoinRefusalCode =
  | "match_full"
  | "not_open"
  | "fee_too_low"
  | "already_joined";

/** A refusal the program named, so the panel can say which one in the player's language. */
export class JoinRefusedError extends Error {
  constructor(readonly code: JoinRefusalCode) {
    super(`join_match refused: ${code}`);
    this.name = "JoinRefusedError";
  }
}

/**
 * [ARENA] Which arena error a failed `join_match` carries, or null.
 *
 * web3.js surfaces a refused preflight as a `SendTransactionError` whose
 * message is the entire simulation log — several hundred characters of base58
 * and `invoke [1]` lines ending in `custom program error: 0x1771`. Rendering
 * that to a player is how a correct refusal reads as a broken site.
 *
 * Matched on the hex code rather than on the `AnchorError` prose, because the
 * hex appears in every form of the failure (a refused preflight, a confirmed
 * error, and the bare `custom program error` a raw submission produces) while
 * the prose only appears when logs are attached.
 *
 * Codes are `6000 + variant index` in `errors.rs` declaration order, which is
 * append-only — see the root CLAUDE.md. Only the four `join_match` can produce
 * are named; anything else falls through to the raw message, which is the right
 * outcome for something nobody predicted.
 */
export function describeJoinProgramError(
  message: string,
): JoinRefusalCode | null {
  const hex = /custom program error: (0x[0-9a-fA-F]+)/.exec(message)?.[1];
  if (hex === undefined) return null;
  switch (Number(hex)) {
    case 6000:
      return "match_full";
    case 6001:
      return "not_open";
    case 6002:
      return "fee_too_low";
    case 6003:
      return "already_joined";
    default:
      return null;
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
  const programId = new PublicKey(params.programId);
  const matchPda = new PublicKey(params.matchPDA);
  const playerToken = deriveAta(player, mint);

  // Pre-flight the balance. The program enforces this too (ArenaError::
  // FeeMismatch), but failing here means the player never sees a wallet prompt
  // for a transaction that cannot succeed, and gets a message that says why.
  //
  // getAccountInfo rather than getTokenAccountBalance, because it separates the
  // two outcomes this has to tell apart: a missing account comes back as `null`
  // and only a transport failure throws. getTokenAccountBalance throws for
  // both, and the single catch this replaced therefore reported a 429 from the
  // shared public endpoint as "you do not own the token".
  let info: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    info = await connection.getAccountInfo(playerToken, "confirmed");
  } catch (e) {
    throw new StakeRpcUnavailableError(
      `Could not reach the network to check your balance (${
        e instanceof Error ? e.message : String(e)
      }). Please try again.`,
    );
  }
  if (info === null) {
    throw new InsufficientStakeError(
      "No token account for this match's mint. Acquire the stake token first.",
    );
  }
  let balance: bigint;
  try {
    balance = decodeTokenAccount(info.data, info.owner).amount;
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
    programId,
    player,
    matchPda,
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

  const submit = wallet.submit;
  if (submit === null) {
    // The picker keeps wallets that cannot stake out of the stake gate, but
    // getConnectedWallet() can hand back one connected earlier for sign-in only.
    throw new WalletCannotStakeError(wallet.name);
  }

  // [ARENA] requireAllSignatures/verifySignatures OFF: the transaction is
  // unsigned at this point and a bare tx.serialize() throws "Signature
  // verification failed" on it. This is the sharpest edge in the bytes contract.
  const wire = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  let signature: string;
  if (submit.kind === "sign") {
    const signed = await submit.signTransaction(wire);
    try {
      signature = await connection.sendRawTransaction(signed, {
        preflightCommitment: "confirmed",
      });
    } catch (e) {
      // A refused preflight arrives as the whole simulation log. Say what the
      // program actually objected to, and keep the log only when it is something
      // this does not recognise.
      const raw = e instanceof Error ? e.message : String(e);
      const refusal = describeJoinProgramError(raw);
      if (refusal !== null) throw new JoinRefusedError(refusal);
      throw e;
    }
  } else {
    // [ARENA] The wallet submits this one, and its own UI collapses the
    // program's error into "Transaction failed". Simulating first recovers the
    // `custom program error: 0x177x` that describeJoinProgramError already knows
    // how to read -- before the player is asked to approve anything. One extra
    // RPC call, on a path that only mobile reaches.
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err !== null) {
      const refusal = describeJoinProgramError(
        (sim.value.logs ?? []).join(LOG_SEPARATOR),
      );
      if (refusal !== null) throw new JoinRefusedError(refusal);
    }
    signature = await submit.signAndSend(wire);
  }

  // Confirm before returning: the server verifies membership against chain
  // state, so handing it back unconfirmed would just fail the join gate.
  //
  // A throw here does NOT mean the stake failed. confirmTransaction rejects on
  // blockhash expiry and on any RPC error, and the transaction it was waiting
  // on may have landed anyway — so the escrow is asked directly before anything
  // is reported to the player. Without this read, a rate-limited confirmation
  // told a player who had just paid that their stake failed, and their retry
  // then surfaced the program's own `AlreadyJoined` as a second failure.
  let confirmErr: unknown;
  try {
    const result = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (result.value.err === null) return signature;
    confirmErr = result.value.err;
  } catch (e) {
    confirmErr = e;
  }

  // Presence in players[] is written only after the transfer, so it settles the
  // question the confirmation could not.
  const staked = await alreadyStaked(connection, matchPda, programId, player);
  if (staked === true) return signature;
  if (staked === null) {
    throw new StakeUnconfirmedError(
      "Your stake was submitted but could not be confirmed. Check your wallet, " +
        "then try again — a stake that did land cannot be charged twice.",
    );
  }
  const rawErr =
    confirmErr instanceof Error
      ? confirmErr.message
      : JSON.stringify(confirmErr);
  const refusal = describeJoinProgramError(rawErr);
  if (refusal !== null) throw new JoinRefusedError(refusal);
  throw new Error(`join_match failed on-chain: ${rawErr}`);
}
