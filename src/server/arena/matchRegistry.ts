export interface WagerConfig {
  matchPDA: string; // base58 Solana account address
  vault: string; // [ARENA] base58 PDA-owned ATA holding the staked tokens
  mint: string; // base58 SPL token mint
  entryFee: bigint; // lamports / token units
  maxPlayers: number;
  rakeBps: number; // [ARENA] house cut in basis points, 0..1000
  nonce: bigint; // [ARENA] PDA seed, so the address can be re-derived later
  // [ARENA] The program this escrow was created under. Recorded per-match, not
  // read from config at join time: repointing ARENA_PROGRAM_ID must not send a
  // joining player's stake to a different program than the one holding the pot.
  programId: string;
}

/**
 * [ARENA] Wire form of a WagerConfig. `entryFee` and `nonce` are u64s, which
 * JSON cannot carry as numbers without losing precision, so both cross the
 * boundary as decimal strings.
 */
export interface WagerInfo {
  matchPDA: string;
  vault: string;
  mint: string;
  entryFee: string;
  maxPlayers: number;
  rakeBps: number;
  programId: string;
  rpcUrl: string;
}

/**
 * [ARENA] The RPC endpoint handed to joining browsers, which submit their own
 * join_match transaction. Falls back to the server's own SOLANA_RPC_URL, so a
 * deployment whose endpoint embeds an API key must set ARENA_PUBLIC_RPC_URL to
 * a keyless one — this value is public.
 */
export function publicRpcUrl(): string {
  return (
    process.env.ARENA_PUBLIC_RPC_URL ??
    process.env.SOLANA_RPC_URL ??
    "https://api.devnet.solana.com"
  );
}

export function toWagerInfo(config: WagerConfig): WagerInfo {
  return {
    matchPDA: config.matchPDA,
    vault: config.vault,
    mint: config.mint,
    entryFee: config.entryFee.toString(),
    maxPlayers: config.maxPlayers,
    rakeBps: config.rakeBps,
    programId: config.programId,
    rpcUrl: publicRpcUrl(),
  };
}

// gameID → on-chain wager config; set at lobby creation, cleared after settlement.
const registry = new Map<string, WagerConfig>();

export const matchRegistry = {
  register(gameId: string, config: WagerConfig): void {
    registry.set(gameId, config);
  },
  get(gameId: string): WagerConfig | undefined {
    return registry.get(gameId);
  },
  isWagered(gameId: string): boolean {
    return registry.has(gameId);
  },
  unregister(gameId: string): void {
    registry.delete(gameId);
  },
};
