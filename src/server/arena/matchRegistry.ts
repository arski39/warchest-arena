export interface WagerConfig {
  matchPDA: string;   // base58 Solana account address
  mint: string;       // base58 SPL token mint
  entryFee: bigint;   // lamports / token units
  maxPlayers: number;
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
