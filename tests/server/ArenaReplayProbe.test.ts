// @vitest-environment node
//
// [ARENA] The boot probe that decides whether public wagered lobbies may open.
//
// ArenaPublicLobbies.test.ts mocks this probe and pins that its verdict is
// obeyed. This file is the other half: it runs the probe for real, with no
// mocks at all, so the thing being obeyed is known to work.
//
// That means two actual worker threads, the real map binaries out of
// resources/maps, and the production verifier — which is the point. The
// failures this exists to catch are deployment failures: an image built without
// the map data, or a thread that cannot load its own TypeScript. Neither is
// visible to tsc, and neither would surface until a wagered match refused to
// settle.
//
// node, not the repo's jsdom default: the probe reads map binaries off the
// filesystem and only ever runs server-side.

import { describe, expect, it } from "vitest";
import { probeReplayVerification } from "../../src/server/arena/replayProbe";

describe("[ARENA] replay availability probe", () => {
  it("records a match and verifies it end to end", async () => {
    // Assert on the reason rather than the boolean: a bare `false` tells
    // whoever hits this nothing about which half broke.
    const result = await probeReplayVerification();
    expect(result.ok ? null : result.reason).toBeNull();
    if (!result.ok) return;
    // A probe that compared no hashes would have proved nothing — verifyReplay
    // refuses that case, and this asserts the probe reaches it rather than
    // passing vacuously.
    expect(result.hashesCompared).toBeGreaterThan(0);
  }, 180_000);

  it("fails, rather than throws, when the map data is missing", async () => {
    // The realistic deployment failure. It has to come back as a reason the
    // gate can log and refuse on, not as an exception that escapes boot.
    const result = await probeReplayVerification("/nonexistent/maps", 60_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/could not run a probe match/);
  }, 120_000);
});
