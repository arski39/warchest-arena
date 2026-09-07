// [ARENA] Phase H5: the app shell must not carry upstream's identity, and the
// three fork-identity variables must actually render.
//
// All three parts guard things nothing else catches. index.html is an EJS
// template rendered only at request time, so a variable the server forgets to
// pass is a ReferenceError in production that tsc, lint and every other test
// are blind to -- this suite is the only place the template is actually
// rendered. The analytics/branding assertions are a merge guard: upstream's
// tags sit in a file we take changes from, so a future merge can quietly
// reinstate them. And the last describe covers the *second* renderer of the
// same template, vite.config.ts -- see its comment.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHtmlContent } from "../../src/server/RenderHtml";

const repoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
// The source template, not static/index.html: the built copy only exists after
// a vite build, and the EJS this suite cares about is identical in both.
const templatePath = path.join(repoRoot, "index.html");

/** Only the vars ServerEnv throws without; the rest have defaults. */
function stubRequiredEnv() {
  vi.stubEnv("GIT_COMMIT", "0".repeat(40));
  vi.stubEnv("NUM_WORKERS", "2");
  vi.stubEnv("TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
  vi.stubEnv("DOMAIN", "example.com");
}

describe("[ARENA] app shell branding", () => {
  beforeEach(stubRequiredEnv);
  afterEach(() => vi.unstubAllEnvs());

  describe("renders", () => {
    it("renders at all — every EJS variable is supplied", async () => {
      // ejs throws ReferenceError for an unsupplied variable, so reaching a
      // non-empty string is the assertion that matters here.
      const html = await renderHtmlContent(templatePath);
      expect(html).toContain("BOOTSTRAP_CONFIG");
    });

    it("derives canonical and og:url from DOMAIN", async () => {
      const html = await renderHtmlContent(templatePath);
      expect(html).toContain(
        '<link rel="canonical" href="https://example.com/"',
      );
      expect(html).toContain('content="https://example.com/"');
    });

    it("uses SITE_NAME for og:title", async () => {
      vi.stubEnv("SITE_NAME", "Test Arena");
      const html = await renderHtmlContent(templatePath);
      expect(html).toContain('property="og:title" content="Test Arena"');
    });

    it("falls back to the domain when SITE_NAME is unset", async () => {
      const html = await renderHtmlContent(templatePath);
      expect(html).toContain('property="og:title" content="example.com"');
    });

    it("titles the page from SITE_NAME", async () => {
      vi.stubEnv("SITE_NAME", "Test Arena");
      const html = await renderHtmlContent(templatePath);
      expect(html).toContain("<title>Test Arena</title>");
    });

    // The title used to be `data-i18n="main.title"`, and ~40 Crowdin-managed
    // locale files each hardcode "OpenFront (ALPHA)". Only en.json is editable
    // in this repo, so renaming through the translation system would have left
    // the fork calling itself OpenFront in every language but English -- which
    // is the misrepresentation AGPL v3 s7 forbids, not a cosmetic slip. A site
    // name is a proper noun; it is not translated content.
    it("does not translate the title, so no locale can restore upstream's", async () => {
      vi.stubEnv("SITE_NAME", "Test Arena");
      const html = await renderHtmlContent(templatePath);
      expect(html).not.toContain('data-i18n="main.title"');
      expect(html).not.toContain("OpenFront (ALPHA)");
    });

    it("injects SOURCE_REPO_URL into BOOTSTRAP_CONFIG", async () => {
      vi.stubEnv("SOURCE_REPO_URL", "https://github.com/you/fork");
      const html = await renderHtmlContent(templatePath);
      expect(html).toContain('sourceRepoUrl: "https://github.com/you/fork"');
    });

    it("injects an empty sourceRepoUrl when unset", async () => {
      // Empty rather than absent, so ClientEnv.sourceRepoUrl()'s falsy check is
      // what turns it back into the upstream link. `?? ` would not have.
      const html = await renderHtmlContent(templatePath);
      expect(html).toContain('sourceRepoUrl: ""');
    });
  });

  describe("carries none of upstream's identity", () => {
    // Regression guard: these shipped in the app shell before the fork removed
    // them, and index.html is a file upstream merges touch.
    it.each([
      ["Google Ads property", "AW-16702609763"],
      ["GA4 property", "G-WQGQQ8RDN4"],
      ["Google Tag Manager", "googletagmanager"],
      ["Playwire RAMP shim", "window.ramp"],
      ["hard-coded openfront.io URL", "openfront.io"],
      // Missed by the first analytics sweep, which caught the Google tags
      // above: this one sits further down the file under its own "Analytics"
      // heading. The token in it is upstream's, so it reported this fork's
      // visitors into OpenFront's Cloudflare account.
      ["Cloudflare Web Analytics beacon", "cloudflareinsights.com"],
      ["upstream's beacon token", "03d93e6fefb349c28ee69b408fa25a13"],
    ])("no %s", async (_label, needle) => {
      const html = await renderHtmlContent(templatePath);
      expect(html).not.toContain(needle);
    });
  });

  // index.html has TWO renderers, and only one of them is exercised above.
  // RenderHtml.ts renders it in production; vite.config.ts renders it for
  // `npm run dev`, from its own hand-maintained copy of the same data. H5 added
  // siteOrigin/siteName/sourceRepoUrl to the template and to RenderHtml.ts but
  // not to vite.config.ts, and Phase 2's arenaDevBypass went the same way --
  // so every `npm run dev` 500'd with "siteOrigin is not defined" and no test
  // noticed, because no test runs the dev server.
  //
  // This is a static check rather than a render: the vite data lives inside
  // defineConfig's closure and inside createHtmlPlugin's options, so there is
  // nothing to import. Crude, but it fails on exactly the drift that happened.
  describe("the vite dev server supplies every template variable too", () => {
    const viteConfig = fs.readFileSync(
      path.join(repoRoot, "vite.config.ts"),
      "utf-8",
    );
    const template = fs.readFileSync(templatePath, "utf-8");

    // `<%= foo %>` / `<%- foo %>`, first identifier only. `typeof` is the
    // keyword opening a guarded expression, not a variable; serverHost is the
    // variable it guards, and is deliberately server-only.
    const referenced = [
      ...new Set(
        [...template.matchAll(/<%[-=]?\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map(
          (m) => m[1],
        ),
      ),
    ].filter((name) => name !== "typeof" && name !== "serverHost");

    it("references a plausible number of variables", () => {
      // Guards the regex itself: if it silently stopped matching, every
      // it.each below would vacuously pass.
      expect(referenced.length).toBeGreaterThan(10);
      expect(referenced).toContain("siteOrigin");
    });

    it.each(referenced)("vite.config.ts defines %s", (name) => {
      // Plain substring, not a regex: every key in that object literal is
      // written `name:`, and searching for the colon keeps cdnBase from
      // matching cdnBaseRaw.
      expect(viteConfig).toContain(`${name}:`);
    });
  });
});
