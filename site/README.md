# Homepage images

Run `npm run build:site` before serving or publishing this directory. To regenerate
only the homepage screenshots and posters, run `npm run build:site:images`.
GitHub Pages includes this step in its existing site build.

Keep the original PNGs in `assets/screenshots/`. The image build reads references
to `assets/screenshots/lossless/<name>.webp` from `index.html` and `assets/home.css`
and converts the matching `<name>.png` without resizing or lossy compression.
It verifies dimensions, visible pixel values, and transparency before writing
each output. Generated WebP files are ignored by Git. The gallery uses the same
full-resolution WebP files as the previews.

After replacing a PNG, rebuild and update its URL version in the homepage to
invalidate cached images.

## iPhone shortcut downloads

The public install page is `/shortcuts/v1/`. The homepage, Reading documentation,
and app setup link to this page. Its download serves the signed `.shortcut` file
directly from the Crate website.

GitHub releases retain the versioned source artifacts. During deployment, Pages
runs `node scripts/download-release-shortcut.mjs published site/shortcuts/v1 --install-page`
to copy the published shortcut into the site after checking its release metadata,
Apple archive framing, and checksum. Without a published shortcut, it generates
an unavailable page with a manual-save alternative. Incomplete releases or failed
verification stop deployment. Do not commit the generated page or signed file.

Publishing a release triggers the Pages workflow to refresh the download. A local
site build alone does not download release assets or publish the shortcut.

## Changelog

The Pages build writes `changelog/index.html` from published GitHub release notes:

```sh
node scripts/build-changelog.mjs site/changelog
```

Run it locally with an authenticated `gh` to preview the page. It reuses the
homepage's stylesheets, header and footer from `index.html`, so changes there
apply to the changelog on the next build. Do not commit the generated page.
