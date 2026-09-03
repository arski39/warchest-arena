import { MatchStatus } from "../../core/arena/arenaProgram";
import type { PublicWagerSummary } from "../../core/Schemas";

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
  // [ARENA] Denomination of `entryFee`, recorded per-match for exactly the same
  // reason as `programId` above. It makes toWagerInfo() a pure function of this
  // config rather than a reader of whatever ARENA_STAKE_MINT currently says.
  //
  // Do NOT "simplify" `mint` to a call to stakeMint(): verifyOnchainMembership
  // compares the on-chain match's mint against THIS value, so an operator who
  // repointed the stake token would kick every player of every live match.
  decimals: number;
  /** Display only. Empty when ARENA_STAKE_SYMBOL is unset. */
  symbol: string;
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
  // [ARENA] So the browser can render "5 ARENA" rather than "5000000".
  decimals: number;
  symbol: string;
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
    decimals: config.decimals,
    symbol: config.symbol,
  };
}

/**
 * [ARENA] The lobby-browser form of a wager: what a seat costs and what the
 * winner keeps, and nothing a card does not draw.
 *
 * Separate from toWagerInfo() on purpose. This one is broadcast to every
 * browser watching the lobby list, several times a minute, for lobbies nobody
 * has clicked — so it omits the addresses and the RPC endpoint that only a
 * player actually joining needs. Adding a field here adds it to every
 * broadcast.
 */
export function toPublicWagerSummary(config: WagerConfig): PublicWagerSummary {
  return {
    entryFee: config.entryFee.toString(),
    maxPlayers: config.maxPlayers,
    decimals: config.decimals,
    rakeBps: config.rakeBps,
    symbol: config.symbol,
  };
}

/**
 * [ARENA] The escrow's fill state, as last read from chain by the join gate.
 *
 * Cached rather than fetched on demand because the only consumer — the
 * start-gate in GameServer.handleIntent — is synchronous and cannot await an
 * RPC. The join gate already performs this read for every wagered join, which
 * is also the only moment the fill state can change, so the cache is refreshed
 * exactly when it needs to be.
 */
export interface ObservedChainState {
  status: MatchStatus;
  playerCount: number;
  maxPlayers: number;
  observedAt: number;
}

// gameID → on-chain wager config; set at lobby creation, cleared after settlement.
const registry = new Map<string, WagerConfig>();
// gameID → last observed escrow fill state. Separate map so a stale observation
// can never be mistaken for a registration.
const observed = new Map<string, ObservedChainState>();

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
    observed.delete(gameId);
  },

  /** Records what the join gate just read from chain. */
  recordChainState(gameId: string, state: ObservedChainState): void {
    observed.set(gameId, state);
  },
  chainState(gameId: string): ObservedChainState | undefined {
    return observed.get(gameId);
  },
};

/**
 * [ARENA] Whether this lobby is allowed to start. True for any lobby that is
 * not wagered.
 *
 * The predicate is the escrow's own `InProgress` status, which `join_match`
 * sets exactly when the last seat is staked — and which is precisely what
 * `settle_match` requires. Gating on the same condition the program settles on
 * means the two cannot drift: a lobby this lets start is a lobby that can pay
 * out, and one it blocks is one that could only ever have refunded.
 *
 * Wrong in either direction is safe. Blocking a startable match costs the host
 * a retry; allowing an unstartable one still refunds through settler.ts. That
 * is what makes a cached read acceptable here.
 */
export function wagerReadyToStart(gameId: string): boolean {
  if (!registry.has(gameId)) return true;
  return observed.get(gameId)?.status === MatchStatus.InProgress;
}
