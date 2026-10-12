// [ARENA] new file — the game-record store upstream's closed API provided.
//
// Two callers were already written against it and neither is ours to change:
//   POST ${jwtIssuer}/game/:id   server/Archive.ts, when a game ends
//   GET  ${apiBase}/game/:id     JoinLobbyModal.checkArchivedGame, which is how
//                                a finished game's link becomes a replay
// With no route here the POST died on the 8 kB JSON limit ("Request Entity Too
// Large") and the GET 404'd, so no finished game could ever be replayed and no
// record of a wagered match was kept anywhere.
//
// Files, not a database: records are write-once and read by id, which is what
// a directory already is. Stored gzipped (turn logs compress ~10x) and served
// with Content-Encoding: gzip, so a read never decompresses anything.
//
// Deliberately NOT validated against GameRecordSchema. That schema lives in
// core/Schemas.ts, whose import graph reaches resources/ — more than this
// process should load to hold a file. The writer is the game server, which
// safeParses before sending and is fenced by the api key; the reader
// (checkArchivedGame) parses what it gets. This checks only what the store
// itself relies on: the id is safe as a filename, and the body is the record
// for that id.
import { promises as fs, constants as fsConstants } from "fs";
import path from "path";
import { gunzipSync, gzipSync } from "zlib";

/** Mirrors GAME_ID_REGEX in core/Schemas.ts. Also what makes `id` path-safe. */
export const ARCHIVE_ID_REGEX = /^[A-Za-z0-9]{8}$/;

/**
 * Max POST body. A turn log grows with match length; the game worker already
 * accepts 5 MB from a client, and a 3-hour match with intents every turn is
 * the ceiling this must hold.
 */
export const ARCHIVE_MAX_BODY = "50mb";

export type PutResult = "stored" | "exists";

export interface GameArchive {
  /** Stores `json` for `id`. Write-once: a second put for an id is refused. */
  put(id: string, json: string): Promise<PutResult>;
  /** The stored record, gzipped, or null when there is none. */
  getGzipped(id: string): Promise<Buffer | null>;
}

/** Shape check only; see the header for why this is not the full schema. */
export function recordMatchesId(body: unknown, id: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  const { info, turns } = body as { info?: unknown; turns?: unknown };
  if (typeof info !== "object" || info === null) return false;
  if ((info as { gameID?: unknown }).gameID !== id) return false;
  return Array.isArray(turns);
}

export function createFileGameArchive(dir: string): GameArchive {
  const fileFor = (id: string): string => {
    // Every caller has already checked, but this is the line that turns an id
    // into a path, so it checks again rather than trusting them.
    if (!ARCHIVE_ID_REGEX.test(id)) throw new Error(`invalid game id: ${id}`);
    return path.join(dir, `${id}.json.gz`);
  };

  return {
    async put(id, json) {
      const final = fileFor(id);
      const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, gzipSync(json), { flag: "wx" });
      try {
        // link() fails with EEXIST instead of replacing, so the first record
        // for an id wins and a reader never sees a half-written file.
        await fs.link(tmp, final);
        return "stored";
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw e;
      } finally {
        await fs.unlink(tmp).catch(() => undefined);
      }
    },

    async getGzipped(id) {
      try {
        return await fs.readFile(fileFor(id));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
  };
}

/**
 * Refuses to start on a directory this process cannot write, rather than
 * discovering it when the first game ends. Creates the directory if missing.
 */
export async function assertArchiveWritable(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.access(dir, fsConstants.W_OK | fsConstants.R_OK);
}

/** For tests and tooling: the stored record, decoded. */
export function decodeStored(gz: Buffer): unknown {
  return JSON.parse(gunzipSync(gz).toString("utf8")) as unknown;
}
