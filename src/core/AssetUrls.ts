export type AssetManifest = Record<string, string>;

function safeDecodeAssetSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function assertSafeAssetSegment(segment: string): string {
  const decodedSegment = safeDecodeAssetSegment(segment);
  if (
    segment === "." ||
    segment === ".." ||
    decodedSegment === "." ||
    decodedSegment === ".."
  ) {
    throw new Error(`Invalid asset path segment: ${segment}`);
  }
  return decodedSegment;
}

export function encodeAssetPath(path: string): string {
  return normalizeAssetPath(path)
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function normalizeAssetPath(path: string): string {
  const normalizedPath = path
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => assertSafeAssetSegment(segment))
    .join("/");

  if (normalizedPath.length === 0) {
    throw new Error("Asset path must not be empty");
  }

  return normalizedPath;
}

function isAbsoluteUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

/**
 * @param baseUrl  The CDN origin, when one is configured.
 * @param originBase [ARENA] An origin to make an otherwise root-relative URL
 *   absolute with. Empty — and therefore inert — everywhere a document exists;
 *   see getAssetOrigin() for the one context that needs it.
 */
export function buildAssetUrl(
  path: string,
  assetManifest: AssetManifest = {},
  baseUrl: string = "",
  originBase: string = "",
): string {
  if (isAbsoluteUrl(path)) {
    return path;
  }

  const normalizedPath = normalizeAssetPath(path);

  const directUrl = assetManifest[normalizedPath];
  if (directUrl) {
    return baseUrl
      ? `${baseUrl.replace(/\/+$/, "")}${directUrl}`
      : `${originBase}${directUrl}`;
  }

  return `${originBase}/${encodeAssetPath(normalizedPath)}`;
}

declare global {
  var __ASSET_MANIFEST__: AssetManifest | undefined;
  var __CDN_BASE__: string | undefined;
  // [ARENA] See getAssetOrigin().
  var __ASSET_ORIGIN__: string | undefined;
}

export function getAssetManifest(): AssetManifest {
  if (
    typeof window !== "undefined" &&
    window.BOOTSTRAP_CONFIG?.assetManifest !== undefined
  ) {
    return window.BOOTSTRAP_CONFIG.assetManifest;
  }
  return globalThis.__ASSET_MANIFEST__ ?? {};
}

// Web workers have no `window`, so they read `__CDN_BASE__` off globalThis,
// which Worker.worker.ts sets from the init message before any asset fetches.
// Without this fallback, asset fetches inside workers (e.g. map binaries)
// would silently bypass the CDN.
export function getCdnBase(): string {
  if (
    typeof window !== "undefined" &&
    window.BOOTSTRAP_CONFIG?.cdnBase !== undefined
  ) {
    return window.BOOTSTRAP_CONFIG.cdnBase;
  }
  return globalThis.__CDN_BASE__ ?? "";
}

/**
 * [ARENA] The origin to hang a root-relative asset URL off, or "".
 *
 * Empty for anything with a document, because a page resolves "/x" itself and
 * always has. It is non-empty in exactly one place: the game worker, which is
 * instantiated from a same-origin **Blob** (`?worker&inline` in
 * `WorkerClient.ts`) so that it can be served from a CDN. A blob: URL is not a
 * hierarchical base, so inside that worker `fetch("/_assets/maps/world/
 * manifest.<hash>.json")` does not resolve to the site — it throws
 * `TypeError: Failed to parse URL`, before any request is made.
 *
 * That never surfaced upstream because their production build sets a real
 * `CDN_BASE`, which already made every asset URL absolute. This deployment
 * serves assets same-origin out of `static/` (`CDN_BASE=""` — see the deploy
 * notes), so the CDN prefix that was quietly doing this job is not there, and
 * **every wagered match failed to boot on every client**: game `Rbp2Lxnd`, and
 * almost certainly `EE96ZrfK` before it, whose stakes then sat out the
 * escrow's 24-hour timeout. A configuration upstream does not run, in a code
 * path only a worker takes.
 *
 * Passed in over the init message rather than read from `self.location.origin`
 * for the same reason `cdnBase` is: what the worker needs to know about where
 * it came from is told to it, not inferred from a blob URL.
 */
export function getAssetOrigin(): string {
  if (typeof window !== "undefined") {
    return "";
  }
  return globalThis.__ASSET_ORIGIN__ ?? "";
}

export function assetUrl(path: string): string {
  return buildAssetUrl(
    path,
    getAssetManifest(),
    getCdnBase(),
    getAssetOrigin(),
  );
}

// Rewrites Vite's emitted /assets/... references in the built index.html to
// use the cdnBaseRaw EJS placeholder, so RenderHtml.ts can prefix them with
// CDN_BASE at request time. Scoped to src=/href= attribute values so inline
// scripts containing the literal "/assets/..." can't be mangled. Does NOT
// match /_assets/ (underscore) — source-asset manifest URLs are prefixed via
// buildAssetUrl, not this rewrite. Falls back to "" when cdnBaseRaw is missing
// so a future renderer that forgets to provide it still produces working
// same-origin URLs.
export function rewriteAssetsForCdn(html: string): string {
  return html.replace(
    /(\s(?:src|href)=)(["'])\/assets\//g,
    `$1$2<%- locals.cdnBaseRaw || "" %>/assets/`,
  );
}
