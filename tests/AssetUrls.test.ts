import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assetUrl,
  buildAssetUrl,
  getAssetOrigin,
  rewriteAssetsForCdn,
} from "../src/core/AssetUrls";

describe("AssetUrls", () => {
  test("returns hashed URLs for direct asset matches", () => {
    expect(
      buildAssetUrl("images/Favicon.svg", {
        "images/Favicon.svg": "/_assets/images/Favicon.hash.svg",
      }),
    ).toBe("/_assets/images/Favicon.hash.svg");
  });

  test("falls back to the unversioned path when manifest has no match", () => {
    expect(buildAssetUrl("images/unknown.svg", {})).toBe("/images/unknown.svg");
  });

  test("falls back to the unversioned path for directory-like paths", () => {
    const manifest = {
      "maps/britanniaclassic/manifest.json":
        "/_assets/maps/britanniaclassic/manifest.hash.json",
      "maps/britanniaclassic/map.bin":
        "/_assets/maps/britanniaclassic/map.hash.bin",
    };

    expect(buildAssetUrl("maps", manifest)).toBe("/maps");
    expect(buildAssetUrl("maps/britanniaclassic", manifest)).toBe(
      "/maps/britanniaclassic",
    );
  });

  test("rejects dot segments in asset paths", () => {
    expect(() => buildAssetUrl("../api/instance", {})).toThrow(
      "Invalid asset path segment: ..",
    );
    expect(() => buildAssetUrl("images/%2e%2e/secret.svg", {})).toThrow(
      "Invalid asset path segment: %2e%2e",
    );
  });

  test("rejects empty asset paths", () => {
    expect(() => buildAssetUrl("", {})).toThrow("Asset path must not be empty");
    expect(() => buildAssetUrl("///", {})).toThrow(
      "Asset path must not be empty",
    );
  });

  test("prefixes baseUrl onto hashed URLs when provided", () => {
    expect(
      buildAssetUrl(
        "images/Favicon.svg",
        { "images/Favicon.svg": "/_assets/images/Favicon.hash.svg" },
        "https://cdn.example.com",
      ),
    ).toBe("https://cdn.example.com/_assets/images/Favicon.hash.svg");
  });

  test("preserves direct URL when baseUrl is empty string", () => {
    expect(
      buildAssetUrl(
        "images/Favicon.svg",
        { "images/Favicon.svg": "/_assets/images/Favicon.hash.svg" },
        "",
      ),
    ).toBe("/_assets/images/Favicon.hash.svg");
  });

  test("returns absolute http(s) URLs unchanged and ignores baseUrl", () => {
    expect(
      buildAssetUrl(
        "https://example.com/foo.png",
        {},
        "https://cdn.example.com",
      ),
    ).toBe("https://example.com/foo.png");
    expect(buildAssetUrl("HTTP://example.com/foo.png", {})).toBe(
      "HTTP://example.com/foo.png",
    );
  });

  // Manifest miss → keep same-origin; the CDN only serves what was explicitly
  // hashed and uploaded, so unknown paths must not be prefixed.
  test("does not prefix baseUrl on manifest misses", () => {
    expect(
      buildAssetUrl("images/unknown.svg", {}, "https://cdn.example.com"),
    ).toBe("/images/unknown.svg");
  });

  test("strips trailing slashes on baseUrl to avoid double slash", () => {
    const manifest = {
      "images/Favicon.svg": "/_assets/images/Favicon.hash.svg",
    };
    expect(
      buildAssetUrl("images/Favicon.svg", manifest, "https://cdn.example.com/"),
    ).toBe("https://cdn.example.com/_assets/images/Favicon.hash.svg");
    expect(
      buildAssetUrl(
        "images/Favicon.svg",
        manifest,
        "https://cdn.example.com///",
      ),
    ).toBe("https://cdn.example.com/_assets/images/Favicon.hash.svg");
  });
});

// [ARENA] The game worker is a Blob (`?worker&inline`), and a blob: URL is not
// a hierarchical base, so a root-relative fetch inside it does not resolve to
// the site -- it throws `TypeError: Failed to parse URL` before any request is
// made. Upstream never sees this because their production build sets a real
// CDN_BASE, which already made every asset URL absolute. This deployment
// serves assets same-origin (CDN_BASE=""), so nothing was, and every match
// failed to boot on every client with the map manifest as the first casualty.
//
// The assertion that matters is `new URL(url)` with NO base: that is exactly
// what the worker's fetch has to do, and it is what a root-relative path
// cannot survive.
describe("asset URLs inside the game worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete globalThis.__ASSET_ORIGIN__;
  });

  test("makes a hashed URL absolute when there is no CDN", () => {
    const url = buildAssetUrl(
      "maps/world/manifest.json",
      { "maps/world/manifest.json": "/_assets/maps/world/manifest.hash.json" },
      "",
      "https://warchest-arena.com",
    );
    expect(url).toBe(
      "https://warchest-arena.com/_assets/maps/world/manifest.hash.json",
    );
    expect(() => new URL(url)).not.toThrow();
  });

  test("makes a manifest miss absolute too", () => {
    // Dev ships no manifest at all, so this is the whole of the worker's asset
    // resolution there -- not an edge case.
    const url = buildAssetUrl(
      "maps/world/map.bin",
      {},
      "",
      "http://localhost:9000",
    );
    expect(url).toBe("http://localhost:9000/maps/world/map.bin");
    expect(() => new URL(url)).not.toThrow();
  });

  test("a CDN still wins, and is still absolute", () => {
    expect(
      buildAssetUrl(
        "maps/world/manifest.json",
        {
          "maps/world/manifest.json": "/_assets/maps/world/manifest.hash.json",
        },
        "https://cdn.example.com",
        "https://warchest-arena.com",
      ),
    ).toBe("https://cdn.example.com/_assets/maps/world/manifest.hash.json");
  });

  test("changes nothing for a page, which resolves its own root-relative URLs", () => {
    expect(getAssetOrigin()).toBe("");
    expect(assetUrl("images/unknown.svg")).toBe("/images/unknown.svg");
  });

  test("reads the origin the init message handed the worker", () => {
    // No window is what makes this a worker; __ASSET_ORIGIN__ is set from the
    // init message before createGameRunner, exactly like __CDN_BASE__.
    vi.stubGlobal("window", undefined);
    globalThis.__ASSET_ORIGIN__ = "https://warchest-arena.com";
    expect(getAssetOrigin()).toBe("https://warchest-arena.com");
    const url = assetUrl("maps/world/map.bin");
    expect(() => new URL(url)).not.toThrow();
    expect(url).toBe("https://warchest-arena.com/maps/world/map.bin");
  });
});

describe("rewriteAssetsForCdn", () => {
  test("rewrites src=/assets/ to EJS placeholder", () => {
    const out = rewriteAssetsForCdn(
      `<script type="module" crossorigin src="/assets/index-XXX.js"></script>`,
    );
    expect(out).toBe(
      `<script type="module" crossorigin src="<%- locals.cdnBaseRaw || "" %>/assets/index-XXX.js"></script>`,
    );
  });

  test("rewrites href=/assets/ for modulepreload and stylesheet links", () => {
    const out = rewriteAssetsForCdn(
      `<link rel="modulepreload" href="/assets/vendor-XXX.js">\n<link rel="stylesheet" href="/assets/index-XXX.css">`,
    );
    expect(out).toBe(
      `<link rel="modulepreload" href="<%- locals.cdnBaseRaw || "" %>/assets/vendor-XXX.js">\n<link rel="stylesheet" href="<%- locals.cdnBaseRaw || "" %>/assets/index-XXX.css">`,
    );
  });

  test("supports single-quoted attribute values", () => {
    expect(rewriteAssetsForCdn(`<script src='/assets/x.js'></script>`)).toBe(
      `<script src='<%- locals.cdnBaseRaw || "" %>/assets/x.js'></script>`,
    );
  });

  test("does not rewrite /_assets/ (underscore manifest paths)", () => {
    const html = `<link rel="icon" href="/_assets/images/Favicon.hash.svg">`;
    expect(rewriteAssetsForCdn(html)).toBe(html);
  });

  test("does not rewrite already-absolute asset URLs", () => {
    const html = `<script src="https://example.com/assets/foo.js"></script>`;
    expect(rewriteAssetsForCdn(html)).toBe(html);
  });

  // Inline scripts containing the literal "/assets/..." string must survive
  // unrewrite — the regex requires whitespace before src=/href=, and inside a
  // JS string literal there's no preceding `src=`/`href=` token at all.
  test("does not mangle /assets/ inside inline script string literals", () => {
    const html = `<script>const url = "/assets/foo";</script>`;
    expect(rewriteAssetsForCdn(html)).toBe(html);
  });

  test("does not match data-src or other custom attributes", () => {
    const html = `<img data-src="/assets/foo.png">`;
    expect(rewriteAssetsForCdn(html)).toBe(html);
  });
});
