export interface WagerConfig {
  matchPDA: string; // base58 Solana account address
  vault: string; // [ARENA] base58 PDA-owned ATA holding the staked tokens
  mint: string; // base58 SPL token mint
  entryFee: bigint; // lamports / token units
  maxPlayers: number;
  rakeBps: number; // [ARENA] house cut in basis points, 0..1000
  nonce: bigint; // [ARENA] PDA seed, so the address can be re-derived later
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
}

export function toWagerInfo(config: WagerConfig): WagerInfo {
  return {
    matchPDA: config.matchPDA,
    vault: config.vault,
    mint: config.mint,
    entryFee: config.entryFee.toString(),
    maxPlayers: config.maxPlayers,
    rakeBps: config.rakeBps,
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
