// @vitest-environment node
//
// [ARENA] The production image does not contain `resources/maps` -- the
// Dockerfile deletes it, because `build-prod` already emitted a content-hashed
// copy of the same 499 MB under `static/_assets/maps`. NodeMapLoader read the
// plain directory, so Phase 4's replay verification worked in every checkout
// and in every test, and failed in the only place that settles real wagers:
// every wagered match would decline to settle and refund on the escrow's 24 h
// timeout, and `replayProbe` would never let ARENA_PUBLIC_WAGER_LOBBIES be
// honoured.
//
// These tests pin the layout the container actually has. The manifest case is
// the regression test; the directory case proves the checkout path did not
// regress while fixing it.
//
// node, not the repo's jsdom default: this reads files off the filesystem.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { GameMapType } from "../../src/core/game/Game";
import {
  NodeMapLoader,
  defaultStaticDir,
  resolveMapFiles,
} from "../../src/server/arena/NodeMapLoader";

const MAP_FILES = [
  "map.bin",
  "map4x.bin",
  "map16x.bin",
  "manifest.json",
  "thumbnail.webp",
];

const tmpDirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-maps-"));
  tmpDirs.push(dir);
  return dir;
}

/** A `static/` tree shaped like the one `build-prod` emits. */
function buildStaticDir(mapKey: string): string {
  const staticDir = tmp();
  const assetsDir = path.join(staticDir, "_assets", "maps", mapKey);
  fs.mkdirSync(assetsDir, { recursive: true });
  const manifest: Record<string, string> = {};
  for (const name of MAP_FILES) {
    const dot = name.lastIndexOf(".");
    const hashed = `${name.slice(0, dot)}.deadbeef1234${name.slice(dot)}`;
    fs.writeFileSync(path.join(assetsDir, hashed), contentFor(name));
    manifest[`maps/${mapKey}/${name}`] = `/_assets/maps/${mapKey}/${hashed}`;
  }
  fs.writeFileSync(
    path.join(staticDir, "asset-manifest.json"),
    JSON.stringify(manifest),
  );
  return staticDir;
}

function contentFor(name: string): Buffer {
  if (name === "manifest.json") {
    return Buffer.from(JSON.stringify({ name }), "utf8");
  }
  return Buffer.from(name, "utf8");
}

/** A checkout's `resources/maps` tree. */
function buildMapsDir(mapKey: string): string {
  const mapsDir = tmp();
  const dir = path.join(mapsDir, mapKey);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of MAP_FILES) {
    fs.writeFileSync(path.join(dir, name), contentFor(name));
  }
  return mapsDir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("NodeMapLoader", () => {
  it("reads resources/maps when the checkout layout is present", async () => {
    const loader = new NodeMapLoader(buildMapsDir("onion"), tmp());
    const data = loader.getMapData(GameMapType.Onion);
    expect(Buffer.from(await data.mapBin())).toEqual(contentFor("map.bin"));
    expect(await data.manifest()).toEqual({ name: "manifest.json" });
  });

  // THE REGRESSION TEST. Without the manifest fallback this throws ENOENT --
  // which is exactly what happened in the image, inside a worker thread, where
  // it surfaced only as "could not verify" on a live pot.
  it("falls back to the hashed static assets when resources/maps is absent", async () => {
    const missing = path.join(tmp(), "resources", "maps");
    const loader = new NodeMapLoader(missing, buildStaticDir("onion"));
    const data = loader.getMapData(GameMapType.Onion);

    expect(Buffer.from(await data.mapBin())).toEqual(contentFor("map.bin"));
    expect(Buffer.from(await data.map4xBin())).toEqual(contentFor("map4x.bin"));
    expect(Buffer.from(await data.map16xBin())).toEqual(
      contentFor("map16x.bin"),
    );
    expect(await data.manifest()).toEqual({ name: "manifest.json" });
    expect(data.webpPath).toContain("thumbnail.deadbeef1234.webp");
  });

  it("names both layouts when neither is present", () => {
    const missingMaps = path.join(tmp(), "resources", "maps");
    const missingStatic = path.join(tmp(), "static");
    expect(() => new NodeMapLoader(missingMaps, missingStatic)).toThrow(
      /neither the directory .* nor the asset manifest/,
    );
  });

  it("rejects a manifest entry that escapes the static directory", () => {
    const staticDir = tmp();
    fs.writeFileSync(
      path.join(staticDir, "asset-manifest.json"),
      JSON.stringify({ "maps/onion/map.bin": "/_assets/../../etc/passwd" }),
    );
    const resolve = resolveMapFiles(path.join(tmp(), "nope"), staticDir);
    expect(() => resolve("onion", "map.bin")).toThrow();
  });

  it("reports a map the manifest does not carry", () => {
    const resolve = resolveMapFiles(
      path.join(tmp(), "nope"),
      buildStaticDir("onion"),
    );
    expect(() => resolve("world", "map.bin")).toThrow(
      /no entry maps\/world\/map\.bin/,
    );
  });
});

describe("defaultStaticDir", () => {
  // Both the checkout and the image put static/ beside src/, so this one path
  // has to be right in both. It is what the container falls back to, and it is
  // resolved relative to the module rather than to cwd, because the worker
  // thread that runs the verifier inherits nothing about where it was started.
  it("points at static/ beside src/", () => {
    const dir = defaultStaticDir();
    expect(path.basename(dir)).toBe("static");
    expect(fs.existsSync(path.join(path.dirname(dir), "src", "server"))).toBe(
      true,
    );
  });
});
