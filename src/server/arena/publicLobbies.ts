// [ARENA] Whether a wagered lobby may be advertised in the public browser.
//
// ## Why this is a resolved predicate and not a boolean
//
// Wagered lobbies were private-only for one reason: the winner was decided by a
// client-majority vote, and a public queue is the easiest possible place to
// assemble a colluding majority. Phase 4 removed that — the server now derives
// the winner by replaying the match itself — so the restriction can lift.
//
// But it lifts *because* verification works, not because an operator typed
// true. If this deployment cannot actually verify (map data missing from the
// image, the worker thread unable to load its own modules), then every wagered
// match refuses to settle and refunds on the 24h timeout. A public queue on top
// of that fills lobbies that can never pay out, and does it with strangers'
// money.
//
// So ARENA_PUBLIC_WAGER_LOBBIES is treated exactly the way ARENA_DEV_BYPASS is:
// requesting it is necessary and not sufficient. resolveDevBypass() refuses to
// believe the env var until it has asked the cluster for its genesis hash; this
// refuses to believe it until a verification has actually succeeded here (see
// replayProbe.ts). An operator cannot flip it early, and neither can a future
// edit that forgets why it mattered.
//
// ## Scope
//
// Resolved per worker, not in the master. The gate is consulted by the /listing
// and /wager endpoints, which only workers serve, and verification runs in the
// worker that owns the game — so a per-worker proof is the correct scope rather
// than an approximation of one. The master needs nothing from this.
import { wageringOperational } from "./preflight";
import { probeReplayVerification } from "./replayProbe";

type PublicWagerLobbies =
  | { state: "on" }
  /** Not asked for. The default, and not a problem. */
  | { state: "off" }
  | { state: "refused"; reason: string };

let result: PublicWagerLobbies = { state: "off" };

/** Env only, no work. Requesting is necessary but not sufficient. */
export function publicWagerLobbiesRequested(): boolean {
  return process.env.ARENA_PUBLIC_WAGER_LOBBIES === "true";
}

/**
 * Whether a wagered lobby may be listed publicly. **The only thing call sites
 * should consult.**
 *
 * False until resolvePublicWagerLobbies() has run and agreed, so every failure
 * mode — not requested, wagering not configured, probe failed, resolve never
 * called — lands on private-only. That is the direction that cannot lose
 * anyone's stake.
 */
export function publicWagerLobbiesEnabled(): boolean {
  return result.state === "on";
}

/**
 * Why public wagered lobbies are unavailable despite being requested, or null.
 * Null is also returned when they were never asked for; callers that must tell
 * those apart should use publicWagerLobbiesRequested().
 */
export function publicWagerLobbiesRefusedReason(): string | null {
  return result.state === "refused" ? result.reason : null;
}

/** Test seam. Never called by server code. */
export function resetPublicWagerLobbiesForTests(): void {
  result = { state: "off" };
}

/**
 * Decides once, at boot, whether the flag may be honoured. Never throws.
 *
 * Costs nothing on a server that did not ask: the probe only runs past both
 * cheap checks.
 */
export async function resolvePublicWagerLobbies(): Promise<boolean> {
  if (!publicWagerLobbiesRequested()) {
    result = { state: "off" };
    return false;
  }

  if (!wageringOperational()) {
    // Ordering matters: runWagerPreflight() must have run first, which is why
    // Worker.ts calls this after it. Without wagering there is no escrow to
    // stake into, so a public *wagered* queue is a contradiction rather than a
    // degraded mode.
    result = {
      state: "refused",
      reason:
        "wagering is not operational on this server, so there are no wagered " +
        "lobbies to list",
    };
    console.error(
      "[arena/publicLobbies] REFUSING ARENA_PUBLIC_WAGER_LOBBIES: " +
        `${result.reason}.`,
    );
    return false;
  }

  const probe = await probeReplayVerification();
  if (!probe.ok) {
    result = { state: "refused", reason: probe.reason };
    console.error(
      "[arena/publicLobbies] REFUSING ARENA_PUBLIC_WAGER_LOBBIES: this server " +
        `cannot verify a match by replaying it (${probe.reason}). Public ` +
        "wagered lobbies rely on server-side winner verification; without it " +
        "every wagered match would decline to settle and refund on the 24h " +
        "timeout. Wagered lobbies stay private-only.",
    );
    return false;
  }

  result = { state: "on" };
  console.log(
    "[arena/publicLobbies] ENABLED — a replay verification succeeded here in " +
      `${probe.elapsedMs} ms (${probe.hashesCompared} hashes compared), so ` +
      "wagered lobbies may be listed publicly.",
  );
  return true;
}

// --- The two endpoint decisions, kept side by side ---------------------------
//
// A host reaches a listed wagered lobby by two routes: wager then list, or list
// then wager. Both are gated, and the gates have to agree — otherwise the
// restriction is merely an ordering puzzle. They live together here, and are
// tested together, so a change to one that forgets the other is visible.
//
// They are deliberately expressed as *refusals*: the question at each call site
// is "do I reject this", and phrasing them the other way around would put a
// negation between the rule and its use.

/**
 * Whether POST /:id/listing must refuse this lobby because it is wagered.
 *
 * Advertising a staked lobby to strangers is only defensible where the server
 * decides the winner itself. Until Phase 4 it never was.
 */
export function listingRefusedForWager(isWagered: boolean): boolean {
  return isWagered && !publicWagerLobbiesEnabled();
}

/**
 * Whether POST /:id/wager must refuse this lobby because of how it is
 * advertised.
 *
 * `isPublic` is a master-created matchmaking lobby: no host to create the
 * escrow, and nobody in it has staked, so it is refused whatever the gate says.
 * `isListed` is the mirror of listingRefusedForWager.
 */
export function wagerRefusedForVisibility(
  isPublic: boolean,
  isListed: boolean,
): boolean {
  return isPublic || (isListed && !publicWagerLobbiesEnabled());
}
