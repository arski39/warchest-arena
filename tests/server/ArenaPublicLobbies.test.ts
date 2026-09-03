// [ARENA] The gate that lets a wagered lobby be advertised publicly.
//
// Public wagered lobbies were forbidden because the winner came from a
// client-majority vote, and a public queue is the easiest possible place to
// assemble a colluding majority. Phase 4 removed that — the server replays the
// match itself — so the restriction can lift.
//
// What this suite is really pinning is that it lifts for the RIGHT REASON.
// `ARENA_PUBLIC_WAGER_LOBBIES=true` is a claim by an operator; the gate only
// believes it once a replay verification has actually succeeded on this
// process. Everything else — unset, wagering not configured, probe failed,
// resolve never called — must read as private-only, because a public queue on
// a server that cannot verify would fill lobbies that can only ever refund.
//
// The probe is mocked here (it is exercised for real in
// ArenaReplayVerifier.test.ts, which runs the actual core); what matters at
// this layer is that its verdict is obeyed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probeReplayVerification = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/replayProbe", () => ({
  probeReplayVerification,
}));

const wageringOperational = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/arena/preflight", () => ({ wageringOperational }));

async function gate() {
  return await import("../../src/server/arena/publicLobbies");
}

const ORIGINAL = process.env.ARENA_PUBLIC_WAGER_LOBBIES;

describe("[ARENA] public wagered lobbies", () => {
  beforeEach(async () => {
    vi.resetModules();
    wageringOperational.mockReturnValue(true);
    probeReplayVerification.mockResolvedValue({
      ok: true,
      elapsedMs: 1234,
      hashesCompared: 4,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ARENA_PUBLIC_WAGER_LOBBIES;
    else process.env.ARENA_PUBLIC_WAGER_LOBBIES = ORIGINAL;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("is off before anything resolves it", async () => {
    // The property that makes every other failure mode safe: a request that
    // races boot sees private-only rather than a half-resolved answer.
    process.env.ARENA_PUBLIC_WAGER_LOBBIES = "true";
    const { publicWagerLobbiesEnabled } = await gate();
    expect(publicWagerLobbiesEnabled()).toBe(false);
  });

  it("stays off when the operator never asked, without paying for a probe", async () => {
    delete process.env.ARENA_PUBLIC_WAGER_LOBBIES;
    const { resolvePublicWagerLobbies, publicWagerLobbiesEnabled } =
      await gate();

    expect(await resolvePublicWagerLobbies()).toBe(false);
    expect(publicWagerLobbiesEnabled()).toBe(false);
    // The default costs a server nothing: no worker threads, no simulation.
    expect(probeReplayVerification).not.toHaveBeenCalled();
  });

  it("refuses when wagering is not operational", async () => {
    // A public *wagered* queue on a server that cannot escrow anything is a
    // contradiction, not a degraded mode.
    process.env.ARENA_PUBLIC_WAGER_LOBBIES = "true";
    wageringOperational.mockReturnValue(false);
    const {
      resolvePublicWagerLobbies,
      publicWagerLobbiesEnabled,
      publicWagerLobbiesRefusedReason,
    } = await gate();

    expect(await resolvePublicWagerLobbies()).toBe(false);
    expect(publicWagerLobbiesEnabled()).toBe(false);
    expect(publicWagerLobbiesRefusedReason()).toMatch(/not operational/);
    expect(probeReplayVerification).not.toHaveBeenCalled();
  });

  it("REFUSES when the server cannot actually verify a match", async () => {
    // The heart of it. The env var is set, wagering works, and the gate still
    // says no — because a deployment that cannot replay a match would settle
    // none of them, and a public queue would recruit strangers into lobbies
    // that can only refund.
    process.env.ARENA_PUBLIC_WAGER_LOBBIES = "true";
    probeReplayVerification.mockResolvedValue({
      ok: false,
      reason: "could not run a probe match: replay worker error: ENOENT",
    });
    const {
      resolvePublicWagerLobbies,
      publicWagerLobbiesEnabled,
      publicWagerLobbiesRefusedReason,
    } = await gate();

    expect(await resolvePublicWagerLobbies()).toBe(false);
    expect(publicWagerLobbiesEnabled()).toBe(false);
    expect(publicWagerLobbiesRefusedReason()).toContain("ENOENT");
  });

  it("enables only after a verification has actually succeeded here", async () => {
    process.env.ARENA_PUBLIC_WAGER_LOBBIES = "true";
    const {
      resolvePublicWagerLobbies,
      publicWagerLobbiesEnabled,
      publicWagerLobbiesRefusedReason,
    } = await gate();

    expect(await resolvePublicWagerLobbies()).toBe(true);
    expect(publicWagerLobbiesEnabled()).toBe(true);
    expect(publicWagerLobbiesRefusedReason()).toBeNull();
    expect(probeReplayVerification).toHaveBeenCalledTimes(1);
  });

  // The two endpoint refusals, tested together on purpose. A host can reach a
  // listed wagered lobby two ways — wager then list, or list then wager — so a
  // gate on only one of them is an ordering puzzle, not a restriction.
  describe("the two endpoint refusals agree", () => {
    it("refuses both orders while the gate is off", async () => {
      delete process.env.ARENA_PUBLIC_WAGER_LOBBIES;
      const {
        resolvePublicWagerLobbies,
        listingRefusedForWager,
        wagerRefusedForVisibility,
      } = await gate();
      await resolvePublicWagerLobbies();

      // list a wagered lobby
      expect(listingRefusedForWager(true)).toBe(true);
      // wager a listed lobby
      expect(wagerRefusedForVisibility(false, true)).toBe(true);
      // and a free private lobby is unaffected either way
      expect(listingRefusedForWager(false)).toBe(false);
      expect(wagerRefusedForVisibility(false, false)).toBe(false);
    });

    it("allows both orders once the gate is on", async () => {
      process.env.ARENA_PUBLIC_WAGER_LOBBIES = "true";
      const {
        resolvePublicWagerLobbies,
        listingRefusedForWager,
        wagerRefusedForVisibility,
      } = await gate();
      expect(await resolvePublicWagerLobbies()).toBe(true);

      expect(listingRefusedForWager(true)).toBe(false);
      expect(wagerRefusedForVisibility(false, true)).toBe(false);
    });

    it("never lets a matchmaking lobby be wagered, gate or no gate", async () => {
      // A master-created lobby has no host to create the escrow and nobody in
      // it has staked. The gate is about advertising a host's lobby, not about
      // wagering ones nobody set up.
      process.env.ARENA_PUBLIC_WAGER_LOBBIES = "true";
      const { resolvePublicWagerLobbies, wagerRefusedForVisibility } =
        await gate();
      expect(await resolvePublicWagerLobbies()).toBe(true);
      expect(wagerRefusedForVisibility(true, false)).toBe(true);
      expect(wagerRefusedForVisibility(true, true)).toBe(true);
    });
  });

  it('treats any value other than "true" as not asked for', async () => {
    // No truthiness, no "1", no "yes". Opening a staked lobby to the public is
    // not something a near-miss in a config file should be able to do.
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      vi.resetModules();
      process.env.ARENA_PUBLIC_WAGER_LOBBIES = value;
      const { resolvePublicWagerLobbies, publicWagerLobbiesEnabled } =
        await gate();
      expect(await resolvePublicWagerLobbies()).toBe(false);
      expect(publicWagerLobbiesEnabled()).toBe(false);
    }
  });
});
