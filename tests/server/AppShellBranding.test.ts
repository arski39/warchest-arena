// [ARENA] Phase H5: the app shell must not carry upstream's identity, and the
// three fork-identity variables must actually render.
//
// Both halves guard things nothing else catches. index.html is an EJS template
// rendered only at request time, so a variable the server forgets to pass is a
// ReferenceError in production that tsc, lint and every other test are blind
// to -- this suite is the only place the template is actually rendered. And the
// analytics/branding assertions are a merge guard: upstream's tags sit in a
// file we take changes from, so a future merge can quietly reinstate them.

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
    ])("no %s", async (_label, needle) => {
      const html = await renderHtmlContent(templatePath);
      expect(html).not.toContain(needle);
    });
  });
});
