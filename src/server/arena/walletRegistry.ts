// [ARENA] Which wallet each session staked with, per wagered game.
//
// Module-level; safe because each worker process handles a disjoint set of
// games and never shares memory with other workers.
//
// Scoped per game, not per persistentID alone. It used to be one map keyed by
// persistentID, which any later wagered join overwrote: a winner who staked
// into a second match with another wallet while the first was still being
// replay-verified had the first match's payout resolve to the second wallet,
// which is not in that escrow's players[], so the win was voided and the pot
// waited out the 24 h refund.
//
// Cleared with the game's matchRegistry entry, once the escrow is settled or
// refunded.
const registry = new Map<string, Map<string, string>>();

export const walletRegistry = {
  /** Records that `persistentId` proved control of `walletAddress` in this game. */
  bind(gameId: string, persistentId: string, walletAddress: string): void {
    let game = registry.get(gameId);
    if (game === undefined) {
      game = new Map();
      registry.set(gameId, game);
    }
    game.set(persistentId, walletAddress);
  },

  get(gameId: string, persistentId: string): string | undefined {
    return registry.get(gameId)?.get(persistentId);
  },

  /** The session a wallet is bound to in this game, if any. */
  holderOf(gameId: string, walletAddress: string): string | undefined {
    for (const [persistentId, wallet] of registry.get(gameId) ?? []) {
      if (wallet === walletAddress) return persistentId;
    }
    return undefined;
  },

  unbind(gameId: string, persistentId: string): void {
    registry.get(gameId)?.delete(persistentId);
  },

  clearGame(gameId: string): void {
    registry.delete(gameId);
  },
};
