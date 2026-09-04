# Branding, licensing and what still needs replacing

This fork is a modified OpenFront. Three separate licences apply and they pull in
different directions, so this file records what was changed to comply and what is
still a placeholder.

## What the licences actually require

| Covers                | Licence                 | What it obliges us to do                                                                                                                                                                                                                         |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All code              | **AGPL v3**             | Offer users of the network service the source of the version they are running (§13). Preserve copyright notices in visible locations, and do not present a modified version as official OpenFront (§7 additional terms, `LICENSING.md` Phase 5). |
| `resources/` assets   | **CC BY-SA 4.0**        | Attribute, and share modifications alike.                                                                                                                                                                                                        |
| `proprietary/` assets | **All Rights Reserved** | Not usable, modifiable or redistributable. **Removed** — see below.                                                                                                                                                                              |

## Done

- **`proprietary/` emptied.** The OpenFront wordmark, logos, favicon,
  `OpenFront.ttf` and the background music were All Rights Reserved and could not
  ship in a fork. Removed; the directory and its build plumbing stay so a licensed
  copy can be restored. See `proprietary/README.md`.
- **Placeholder logo and favicon** added at `resources/images/OpenFrontLogo.svg`
  and `resources/images/Favicon.svg`, at the same paths upstream used, so no client
  code changed and upstream merges stay trivial.
- **OpenFront's analytics and ad tags removed** from `index.html`: Google Ads
  `AW-16702609763`, GA4 `G-WQGQQ8RDN4`, the `googletag` page_url stub and the
  Playwire RAMP shim. Leaving them would have reported this fork's traffic into
  OpenFront's own accounts.
- **`canonical` / `og:url` / `og:title` un-hardcoded** from `openfront.io`; they now
  derive from `ServerEnv.siteOrigin()` and `ServerEnv.siteName()`.
- **Footer source link parameterised** (`SOURCE_REPO_URL`) — this is the §13
  mechanism. `ServerEnv.warnIfSourceRepoUnset()` complains at boot outside dev.

## Still placeholder — replace before launch

| Thing                       | Where                                               | Note                                                                                                                                                 |
| --------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logo / favicon art          | `resources/images/OpenFrontLogo.svg`, `Favicon.svg` | Neutral geometric mark. Same file names as upstream on purpose.                                                                                      |
| Display font                | —                                                   | `fonts/OpenFront.ttf` is gone; `Main.ts` catches the load failure and falls back to Inter/sans-serif. Ship your own font at that path to restore it. |
| Background music            | —                                                   | Three tracks referenced by `SoundManager.ts` are gone. The loader is wrapped in `safely()`, so music simply does not play.                           |
| `SOURCE_REPO_URL`, `DOMAIN` | `.env`                                              | Both must be set for a public deployment. `SITE_NAME` now carries the placeholder name — see below.                                                  |

## The name

**`Warchest Arena` is a working placeholder, not a settled name.** It is set in
exactly one place — `SITE_NAME` — so replacing it is one env var and a logo, not
a sweep through the tree.

That took a change worth not undoing. The page title used to be
`<title data-i18n="main.title">`, and ~40 Crowdin-managed locale files each
hardcode upstream's name. This repo may only edit `en.json`, so renaming through
the translation system would have left the fork calling itself OpenFront in
every language but English — the misrepresentation §7 forbids, not a cosmetic
slip. **A site name is a proper noun; it is not translated content.** The title
now renders from `siteName`, the same variable `og:title` already used, and
`LangSelector.applyTranslation()` no longer overwrites it.

`main.title` is **removed from `en.json`** — the repo refuses unused keys
(`TranslationSystem.test.ts` → `en.json keys stay in sync with source usage`).
The ~40 Crowdin-managed locale files still carry it, harmlessly. Do not
re-add it to `en.json` and do not re-wire the title through it.
_Guarded by_ `AppShellBranding.test.ts` →
`does not translate the title, so no locale can restore upstream's`.

Still open on the name: the domain, and whether the placeholder becomes final.

## Deliberately left alone

- **`proprietary/LICENSE`** stays. It is a copyright notice, and §7 asks that notices
  be preserved.
- **Upstream attribution** (`CREDITS.md`, the `CONTRIBUTING.md` links, the Reddit and
  Discord links in the footer) stays. §7 requires notices be preserved, not scrubbed.
  What §7 forbids is _misrepresenting_ this as official OpenFront — so the name, logo
  and title must change, while the credit must not.
- **The CrazyGames SDK tag** in `index.html`. It is inert off-portal and removing it
  touches the auth path (`doCrazyGamesLogin`).
