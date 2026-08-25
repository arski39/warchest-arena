import { getConnectedWallet } from "./WalletProvider";

interface JoinMatchParams {
  matchPDA: string;   // base58 on-chain MatchAccount address
  mint: string;       // base58 SPL token mint
  entryFee: bigint;
}

/**
 * Calls the join_match instruction on-chain, transferring the entry fee into
 * the escrow vault.  Returns the confirmed transaction signature.
 *
 * Full implementation in Phase 2 (tasks 5-6) once the Anchor program is
 * deployed and the IDL is available.  The signature is forwarded to the
 * server in ClientJoinMessage.onchainTxSig for RPC verification.
 */
export async function joinMatchOnChain(
  _params: JoinMatchParams,
): Promise<string | undefined> {
  const wallet = getConnectedWallet();
  if (!wallet) throw new Error("Wallet not connected");

  // TODO (Phase 2): build join_match transaction via @coral-xyz/anchor, sign
  // with wallet adapter, confirm, return signature.
  console.warn("[arena/onchainJoin] on-chain join not yet implemented — skipping");
  return undefined;
}
