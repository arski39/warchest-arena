// [ARENA] The menu wordmark: the site's name, large, above the play buttons.
//
// ## The name comes from SITE_NAME, never from a literal
//
// `ClientEnv.siteName()`, which reads the value the server rendered into
// BOOTSTRAP_CONFIG from `SITE_NAME`. The root CLAUDE.md makes this a rule: the
// name lives in exactly one variable, so a rename is that variable plus the
// logo art and nothing else. Hardcoding "Warchest Arena" here would quietly
// make this the second place it lives, and the placeholder name is expected to
// change.
//
// It is also deliberately NOT a translated string, for the same reason the
// <title> is not: a site name is a proper noun, ~40 Crowdin-managed locale
// files hardcode upstream's name, and only en.json is editable here — so
// routing it through translation would have the fork calling itself OpenFront
// in every language but English. That is the AGPL §7 misrepresentation, not a
// cosmetic slip. See docs/branding.md.
//
// ## The face is loaded at runtime, not from a stylesheet
//
// The build content-hashes `resources/fonts/` into `static/_assets/`, so the
// font's final URL is only knowable through the asset manifest — which a static
// CSS file cannot consult. Hence a constructed `FontFace` built from
// `assetUrl()`, the same accessor everything else that fetches an asset must
// use (see the blob-worker rule in the root CLAUDE.md).
//
// A missing or undecodable file is handled rather than thrown: `font-display:
// swap` over an explicit fallback stack means the nameplate renders the name
// either way and the layout does not shift. jsdom has no `FontFace` at all, so
// this path is exercised by every test run.
//
// ## Why this face
//
// Grenze Gotisch ExtraBold (Omnibus-Type, SIL OFL 1.1), shipped as a subset:
// the variable font pinned to wght=800, cut to Latin-1 + Latin Extended-A, and
// re-encoded WOFF2 — 193 kB of TTF down to 15 kB. `GrenzeGotisch-OFL.txt` sits
// beside it because the OFL requires the licence to travel with the font, and
// its copyright line carries no Reserved Font Name, which is what lets a
// modified build keep the family name.
//
// It replaced Hold Money Blackletter, which was the visual reference but is a
// personal-use demo — and this site takes real stakes, so it could not be used
// or committed. Grenze Gotisch was picked over Pirata One, UnifrakturCook,
// Fruktur and Metal Mania by rendering all of them at the sizes used here: it
// matched Hold Money's weight most closely while staying the most legible of
// the blackletters at phone size, and its numerals are clean, which matters on
// a page that quotes stake tiers.
import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { assetUrl } from "../../core/AssetUrls";
import { ClientEnv } from "../ClientEnv";

/** Family name the stylesheet and this component agree on. */
export const DISPLAY_FONT_FAMILY = "Grenze Gotisch";

/** Where the build publishes the face. */
export const DISPLAY_FONT_ASSET = "fonts/GrenzeGotisch-ExtraBold.woff2";

/**
 * Loads the display face once per document.
 *
 * Module-level rather than per-instance because `document.fonts` is
 * document-wide: two nameplates (or a remount) must not register the same
 * family twice. Resolves to whether the face is usable, which is what decides
 * the letter-spacing below — a blackletter and the fallback serif want
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

@customElement("site-nameplate")
export class SiteNameplate extends LitElement {
  @state() private hasFace = false;

  // Light DOM, like every other component here, so the page's Tailwind and
  // design tokens reach it.
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void loadDisplayFont().then((ok) => {
      this.hasFace = ok;
    });
  }

  render() {
    const name = ClientEnv.siteName();
    if (name === "") return html``;

    return html`
      <!-- aria-label carries the plain name: the glyphs are decorative
           blackletter and a screen reader should read the name, not attempt
           the face. role="img" stops it announcing the text twice. -->
      <div
        class="w-full px-2 pt-1 pb-2 lg:pt-3 lg:pb-4 select-none"
        role="img"
        aria-label=${name}
      >
        <h1
          class="m-0 text-center leading-[0.95] text-cyber-yellow
                 [text-wrap:balance] break-words
                 text-[clamp(2.25rem,11vw,5.5rem)]"
          style=${`font-family: ${JSON.stringify(DISPLAY_FONT_FAMILY)}, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;` +
          // Blackletter is drawn tight; the fallback serif is not. Tracking
          // that flatters one makes the other look like a rendering bug.
          (this.hasFace ? "letter-spacing:0.01em;" : "letter-spacing:-0.01em;")}
          aria-hidden="true"
        >
          ${name}
        </h1>
      </div>
    `;
  }
}
