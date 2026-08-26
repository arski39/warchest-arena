# proprietary/ — intentionally empty in this fork

Upstream OpenFront keeps its **All Rights Reserved** brand assets here: the
OpenFront wordmark and logos, the favicon, the `OpenFront.ttf` display font, and
the background music. `LICENSING.md` is explicit that these are

> NOT licensed for use, modification, or redistribution

so a fork cannot ship them, and this fork does not. They were removed in the
commit that added this file and remain recoverable from upstream history if you
ever obtain a licence.

The directory itself stays because the build still supports it:
`vite.config.ts` passes it to `buildPublicAssetManifest` as a second source dir
that overrides `resources/`. `listHashedPublicAssetPaths` skips a source dir
that does not exist (`PublicAssetManifest.ts`), so dropping the directory
entirely would also work — keeping it means a licensed copy can be restored by
just adding the files back, and it keeps upstream merges trivial.

Placeholders now live at the same paths under `resources/`. See
`docs/branding.md` for what still needs replacing before launch.
