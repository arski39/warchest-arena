// [ARENA] new file — the display face, loadable without the nameplate.
//
// Split out of SiteNameplate.ts when the sign-in picker started setting the
// site's name in the same face. Importing the nameplate module would run its
// @customElement decorator, and a module re-evaluated under vi.resetModules()
// then registers "site-nameplate" twice, which the registry refuses. See
// SiteNameplate.ts for why the face is loaded at runtime and why this face.
import { assetUrl } from "../../core/AssetUrls";

/** Family name the stylesheet and every user of the face agree on. */
export const DISPLAY_FONT_FAMILY = "Grenze Gotisch";

/** Where the build publishes the face. */
export const DISPLAY_FONT_ASSET = "fonts/GrenzeGotisch-ExtraBold.woff2";

/** The face, then the serif fallback it is shown over until (or unless) it loads. */
export const DISPLAY_FONT_STACK = `${JSON.stringify(DISPLAY_FONT_FAMILY)}, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`;

/**
 * Loads the display face once per document.
 *
 * Module-level rather than per-instance because `document.fonts` is
 * document-wide: two users (or a remount) must not register the same family
 * twice. Resolves to whether the face is usable, which is what decides the
 * nameplate's letter-spacing — a blackletter and the fallback serif want
 * different tracking, and applying blackletter tracking to the fallback makes
 * it look broken rather than plain.
 */
let loading: Promise<boolean> | null = null;

export function loadDisplayFont(): Promise<boolean> {
  if (loading !== null) return loading;
  loading = (async () => {
    if (typeof document === "undefined" || !("fonts" in document)) return false;
    try {
      const face = new FontFace(
        DISPLAY_FONT_FAMILY,
        `url(${JSON.stringify(assetUrl(DISPLAY_FONT_ASSET))}) format("woff2")`,
        { display: "swap" },
      );
      await face.load();
      document.fonts.add(face);
      return true;
    } catch {
      // No FontFace (jsdom), a 404, or a decode failure. Either way the
      // fallback stack renders, which is a supported state.
      return false;
    }
  })();
  return loading;
}

/** Test seam: forget that the font was loaded. Never called by app code. */
export function resetDisplayFontForTests(): void {
  loading = null;
}
