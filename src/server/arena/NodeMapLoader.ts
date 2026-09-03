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
import fs from "fs";
import path from "path";
import { GameMapType } from "../../core/game/Game";
import { GameMapLoader, MapData } from "../../core/game/GameMapLoader";
import { MapManifest } from "../../core/game/TerrainMapLoader";

export class NodeMapLoader implements GameMapLoader {
  constructor(private mapsDir: string) {}

  getMapData(map: GameMapType): MapData {
    const key = Object.keys(GameMapType).find(
      (k) => GameMapType[k as keyof typeof GameMapType] === map,
    );
    if (key === undefined) {
      throw new Error(`unknown map: ${map}`);
    }
    const dir = path.join(this.mapsDir, key.toLowerCase());
    const readBin = (name: string) => async () =>
      new Uint8Array(fs.readFileSync(path.join(dir, name)));
    return {
      mapBin: readBin("map.bin"),
      map4xBin: readBin("map4x.bin"),
      map16xBin: readBin("map16x.bin"),
      manifest: async () =>
        JSON.parse(
          fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
        ) as MapManifest,
      webpPath: path.join(dir, "thumbnail.webp"),
      // Only the client renders layers; a headless replay never asks.
      layerPng: async (_layerId: string) => {
        throw new Error("Layer PNGs are not supported in NodeMapLoader");
      },
    };
  }
}
