import type { GameID } from "../../core/Schemas";
import { matchRegistry, type WagerConfig } from "./matchRegistry";

/**
 * Creates the on-chain MatchAccount escrow for a wagered game and registers
 * the config in matchRegistry.
 *
 * Full Anchor program call (create_match instruction) wired in Phase 2.
 */
export async function createWageredMatch(
  gameId: GameID,
  config: Omit<WagerConfig, "matchPDA">,
): Promise<{ matchPDA: string }> {
  // TODO (Phase 2, task 5): derive PDA, call create_match instruction via @coral-xyz/anchor.
  // const matchPDA = await submitCreateMatchTx(config);
  const matchPDA = "TODO_DEPLOY_PROGRAM_AND_REPLACE";

  matchRegistry.register(gameId, { ...config, matchPDA });
  console.log(
    `[arena/matchCreator] registered wagered game=${gameId} matchPDA=${matchPDA}`,
  );
  return { matchPDA };
}
