import { createHash } from "crypto";
import fs from "fs";
import nacl from "tweetnacl";
import { GameEnv } from "../../core/configuration/Config";
import type { ClientSendWinnerMessage } from "../../core/Schemas";
import type { Client } from "../Client";
import { ServerEnv } from "../ServerEnv";
import { matchRegistry } from "./matchRegistry";
import { walletRegistry } from "./walletRegistry";

// Server ed25519 keypair; pubkey is baked into the Anchor program config.
// Path must point to a Uint8Array JSON file ([...bytes]).
function loadServerKeypair(): Uint8Array {
  const path = process.env.SERVER_KEYPAIR_PATH;
  if (!path) {
    throw new Error("SERVER_KEYPAIR_PATH env var not set");
  }
  return new Uint8Array(JSON.parse(fs.readFileSync(path, "utf8")) as number[]);
}

let _keypair: Uint8Array | null = null;
function keypair(): Uint8Array {
  if (!_keypair) _keypair = loadServerKeypair();
  return _keypair;
}

/**
 * Signs sha256(gameID || winnerWallet || standings) and submits the
 * settle_match instruction.  Called from GameServer.archiveGame() after
 * winner consensus is reached.
 *
 * Full Anchor program call is wired in Phase 2 (task 6-7).
 */
export async function settle(
  gameId: string,
  winner: ClientSendWinnerMessage | undefined,
  allClients: ReadonlyMap<string, Client>,
): Promise<void> {
  const wager = matchRegistry.get(gameId);
  if (!wager) return; // free-practice game — nothing to settle

  if (!winner?.winner || winner.winner === undefined) {
    console.error(`[arena/settler] no winner for wagered game ${gameId}`);
    return;
  }

  // Determine winner wallet pubkey.
  const [winnerType, winnerClientId] = winner.winner as [string, string];
  if (winnerType !== "player") {
    console.error(
      `[arena/settler] team wins not yet supported for wagered matches (game ${gameId})`,
    );
    return;
  }

  const winnerClient = allClients.get(winnerClientId);
  const winnerPersistentId = winnerClient?.persistentID;
  const winnerWallet = winnerPersistentId
    ? walletRegistry.get(winnerPersistentId)
    : undefined;

  if (!winnerWallet) {
    console.error(
      `[arena/settler] no wallet registered for winner ${winnerClientId} in game ${gameId}`,
    );
    return;
  }

  // Build standings: [score, score, ...] ordered by clientID for determinism.
  const standings = Object.entries(winner.allPlayersStats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, stats]) => Number(stats.finalTiles ?? 0));

  // Sign: sha256(gameId || winnerWallet || JSON(standings))
  const payload = `${gameId}:${winnerWallet}:${JSON.stringify(standings)}`;
  const digest = createHash("sha256").update(payload).digest();

  if (ServerEnv.env() === GameEnv.Dev) {
    // Skip actual signing/submission in dev — keypair may not be present.
    console.log(
      `[arena/settler][dev] would settle game=${gameId} winner=${winnerWallet} standings=${JSON.stringify(standings)}`,
    );
    matchRegistry.unregister(gameId);
    return;
  }

  const sig = nacl.sign.detached(digest, keypair());

  console.log(
    `[arena/settler] game=${gameId} winner=${winnerWallet} ` +
      `sig=${Buffer.from(sig).toString("hex").slice(0, 16)}…`,
  );

  // TODO (Phase 2, task 14): build and submit settle_match tx via @coral-xyz/anchor.
  // await submitSettleTx(wager.matchPDA, winnerWallet, standings, sig);

  matchRegistry.unregister(gameId);
}
