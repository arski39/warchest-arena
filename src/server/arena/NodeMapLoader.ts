// [ARENA] new file — a filesystem GameMapLoader, so the server can run the
// simulation itself.
//
// The game server has never needed to load a map: the simulation runs on the
// clients and the server only relays intents. Phase 4 changes that — settling a
// wagered match means replaying it server-side — so the server needs the same
// terrain the players had.
//
// Mirrors how BinaryLoaderGameMapLoader resolves map directories, and is the
// same shape as tests/perf/fullgame/NodeGameMapLoader.ts. Kept as its own file
// under src/server rather than imported from tests/, because production code
// must not depend on the test tree.
//
// ⚠️ TWO LAYOUTS, AND THE CONTAINER ONLY HAS THE SECOND ONE.
//
// A checkout has `resources/maps/<map>/map.bin`. The production image does NOT:
// the Dockerfile deletes `resources/maps` because the build already emitted a
// content-hashed copy of every one of those files under `static/_assets/maps/`,
// and shipping both means ~1 GB of duplicated map data. Reading a plain
// directory therefore works everywhere except the one place that settles real
// wagers, and nothing in the type system or the unit suite can see that: the
// symptom is every wagered match failing verification and falling through to
// the escrow's 24 h refund.
//
// So resolution goes through `static/asset-manifest.json` — the semantic
// name -> hashed url mapping the build emits — whenever the plain directory is
// absent. Note this is asset-manifest.json and NOT asset-hashes.json: the
// latter is keyed by the already-hashed emitted path and carries integrity
// data, so it cannot answer "where did map.bin go".
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { type AssetManifest, normalizeAssetPath } from "../../core/AssetUrls";
import { GameMapType } from "../../core/game/Game";
import { GameMapLoader, MapData } from "../../core/game/GameMapLoader";
import { MapManifest } from "../../core/game/TerrainMapLoader";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to `static/`, as laid down by `npm run build-prod`. */
export function defaultStaticDir(): string {
  return path.resolve(HERE, "../../../static");
}

/** Resolves one file of one map to an absolute path on disk. */
export type MapFileResolver = (mapKey: string, fileName: string) => string;

function directoryResolver(mapsDir: string): MapFileResolver {
  return (mapKey, fileName) => path.join(mapsDir, mapKey, fileName);
}

function manifestResolver(staticDir: string): MapFileResolver {
  const manifestPath = path.join(staticDir, "asset-manifest.json");
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  ) as AssetManifest;
  return (mapKey, fileName) => {
    const name = `maps/${mapKey}/${fileName}`;
    const href = manifest[name];
    if (href === undefined) {
      throw new Error(`asset manifest at ${manifestPath} has no entry ${name}`);
    }
    // Manifest hrefs are root-relative and percent-encoded. normalizeAssetPath
    // decodes per segment and rejects `.`/`..`, so a manifest cannot name a
    // path outside staticDir.
    return path.join(staticDir, normalizeAssetPath(href));
  };
}

/**
 * Picks the layout that is actually present, and throws naming both if neither
 * is. Failing loudly here is the point: this used to fail silently, per file,
 * inside a worker thread.
 */
export function resolveMapFiles(
  mapsDir: string,
  staticDir: string = defaultStaticDir(),
): MapFileResolver {
  if (fs.existsSync(mapsDir)) {
    return directoryResolver(mapsDir);
  }
  const manifestPath = path.join(staticDir, "asset-manifest.json");
  if (fs.existsSync(manifestPath)) {
    return manifestResolver(staticDir);
  }
  throw new Error(
    `no map data: neither the directory ${mapsDir} nor the asset manifest ` +
      `${manifestPath} exists`,
  );
}

export class NodeMapLoader implements GameMapLoader {
  private readonly resolve: MapFileResolver;

  constructor(mapsDir: string, staticDir: string = defaultStaticDir()) {
    // Eager, so a container with no map data at all reports that once, up
    // front, instead of once per file read deep inside the simulation.
    this.resolve = resolveMapFiles(mapsDir, staticDir);
  }

  getMapData(map: GameMapType): MapData {
    const key = Object.keys(GameMapType).find(
      (k) => GameMapType[k as keyof typeof GameMapType] === map,
    );
    if (key === undefined) {
      throw new Error(`unknown map: ${map}`);
    }
    const mapKey = key.toLowerCase();
    const readBin = (name: string) => async () =>
      new Uint8Array(fs.readFileSync(this.resolve(mapKey, name)));
    return {
      mapBin: readBin("map.bin"),
      map4xBin: readBin("map4x.bin"),
      map16xBin: readBin("map16x.bin"),
      manifest: async () =>
        JSON.parse(
          fs.readFileSync(this.resolve(mapKey, "manifest.json"), "utf8"),
        ) as MapManifest,
      webpPath: this.resolve(mapKey, "thumbnail.webp"),
      // Only the client renders layers; a headless replay never asks.
      layerPng: async (_layerId: string) => {
        throw new Error("Layer PNGs are not supported in NodeMapLoader");
      },
    };
  }
}
