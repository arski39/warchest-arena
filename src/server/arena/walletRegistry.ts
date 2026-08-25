// In-memory map: persistentID → Solana wallet pubkey (base58).
// Module-level singleton; safe because each worker process handles
// a disjoint set of games and never shares memory with other workers.
const registry = new Map<string, string>();

export const walletRegistry = {
  set(persistentId: string, walletAddress: string): void {
    registry.set(persistentId, walletAddress);
  },
  get(persistentId: string): string | undefined {
    return registry.get(persistentId);
  },
  getAll(): ReadonlyMap<string, string> {
    return registry;
  },
};
