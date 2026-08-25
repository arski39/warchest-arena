import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection(
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  "confirmed",
);

/**
 * Verifies that txSig is a confirmed transaction that references matchPDA,
 * providing reasonable assurance that the player called join_match on-chain.
 *
 * Full MatchAccount deserialization (reading players[]) is deferred to Phase 2
 * when the program is deployed and the IDL is available.
 */
export async function verifyOnchainMembership(
  matchPDA: string,
  _walletAddress: string,
  txSig: string | undefined,
): Promise<boolean> {
  if (!txSig) return false;
  try {
    const tx = await connection.getTransaction(txSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || tx.meta?.err !== null) return false;

    // Confirm the match PDA is one of the accounts touched by this tx.
    // Works for both legacy and v0 messages.
    const matchKey = new PublicKey(matchPDA).toString();
    const msg = tx.transaction.message;
    const accountKeys: string[] =
      "staticAccountKeys" in msg
        ? (msg.staticAccountKeys as PublicKey[]).map((k) => k.toString())
        : (msg as { accountKeys: PublicKey[] }).accountKeys.map((k) =>
            k.toString(),
          );
    return accountKeys.includes(matchKey);
  } catch {
    return false;
  }
}

export { connection };
