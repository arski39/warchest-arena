import ejs from "ejs";
import type { Response } from "express";
import fs from "fs/promises";
import { buildAssetUrl } from "../core/AssetUrls";
import { devBypassEnabled } from "./arena/devBypass"; // [ARENA]
import { setNoStoreHeaders } from "./NoStoreHeaders";
import { getRuntimeAssetManifest } from "./RuntimeAssetManifest";
import { ServerEnv } from "./ServerEnv";

const APP_SHELL_CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=86400, stale-if-error=86400";

const appShellContentCache = new Map<string, Promise<string>>();

export async function renderHtmlContent(htmlPath: string): Promise<string> {
  const htmlContent = await fs.readFile(htmlPath, "utf-8");
  const assetManifest = await getRuntimeAssetManifest();
  const cdnBase = ServerEnv.cdnBase();
  return ejs.render(htmlContent, {
    gitCommit: JSON.stringify(ServerEnv.gitCommit()),
    assetManifest: JSON.stringify(assetManifest),
    cdnBase: JSON.stringify(cdnBase),
    // Raw (unquoted) value for use as a URL prefix in the index.html template,
    // e.g. <script src="<%- cdnBaseRaw %>/assets/index-XXX.js">. The Vite
    // build plugin inject-cdn-base-template rewrites Vite's emitted /assets/
    // refs to use this placeholder.
    cdnBaseRaw: cdnBase,
    gameEnv: JSON.stringify(ServerEnv.gameEnvName()),
    numWorkers: JSON.stringify(ServerEnv.numWorkers()),
    turnstileSiteKey: JSON.stringify(ServerEnv.turnstileSiteKey()),
    jwtAudience: JSON.stringify(ServerEnv.jwtAudience()),
    instanceId: JSON.stringify(ServerEnv.instanceId()),
    // [ARENA] Raw (unquoted) -- index.html emits these with <%= %>, which
    // escapes them there. JSON.stringify would embed the quotes as literals.
    siteOrigin: ServerEnv.siteOrigin(),
    siteName: ServerEnv.siteName(),
    sourceRepoUrl: JSON.stringify(ServerEnv.sourceRepoUrl()),
    arenaDevBypass: JSON.stringify(devBypassEnabled()),
    manifestHref: buildAssetUrl("manifest.json", assetManifest, cdnBase),
    faviconHref: buildAssetUrl("images/Favicon.svg", assetManifest, cdnBase),
    gameplayScreenshotUrl: buildAssetUrl(
      "images/GameplayScreenshot.png",
      assetManifest,
      cdnBase,
    ),
    backgroundImageUrl: buildAssetUrl(
      "images/background.webp",
      assetManifest,
      cdnBase,
    ),
    // [ARENA] Both logos pointed at the placeholder SVG. Upstream used
    // images/OpenFront.png and images/OF.png, which lived only in
    // proprietary/ (All Rights Reserved) and so cannot ship in a fork. See
    // docs/branding.md. buildAssetUrl falls back to a bare /path for an
    // unknown key rather than throwing, so a missing asset would 404 quietly
    // instead of failing the render -- easy to miss, hence pointing them
    // somewhere real.
    desktopLogoImageUrl: buildAssetUrl(
      "images/OpenFrontLogo.svg",
      assetManifest,
      cdnBase,
    ),
    mobileLogoImageUrl: buildAssetUrl(
      "images/OpenFrontLogo.svg",
      assetManifest,
      cdnBase,
    ),
  });
}

export async function getAppShellContent(htmlPath: string): Promise<string> {
  let cachedContent = appShellContentCache.get(htmlPath);
  if (!cachedContent) {
    cachedContent = renderHtmlContent(htmlPath).catch((error: unknown) => {
      appShellContentCache.delete(htmlPath);
      throw error;
    });
    appShellContentCache.set(htmlPath, cachedContent);
  }
  return cachedContent;
}

export function clearAppShellContentCache(): void {
  appShellContentCache.clear();
}

export function setAppShellCacheHeaders(res: Response): void {
  res.setHeader("Cache-Control", APP_SHELL_CACHE_CONTROL);
  res.setHeader("Content-Type", "text/html");
}

export function setHtmlNoCacheHeaders(res: Response): void {
  setNoStoreHeaders(res);
  res.setHeader("ETag", "");
  res.setHeader("Content-Type", "text/html");
}

export async function renderAppShell(
  res: Response,
  htmlPath: string,
): Promise<void> {
  const rendered = await getAppShellContent(htmlPath);
  setAppShellCacheHeaders(res);
  res.send(rendered);
}
