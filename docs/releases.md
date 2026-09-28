# Preparing a plugin release

Plugin assets and the public iPhone shortcut share one GitHub release. The shortcut
is signed on a maintainer's Mac using its existing iCloud login. Apple credentials
are never sent to GitHub Actions. Generated binaries stay out of Git.

## Prepare the version

1. Use the Node.js version in `.nvmrc` and install dependencies with `npm ci`.
2. Update `package.json`, `package-lock.json`, `manifest.json`, and `versions.json`
   for the release. Follow the version and acceptance requirements in
   [testing](testing.md#public-release-acceptance).
3. Commit the release changes, push the commit, and push a tag exactly matching
   `manifest.json` (no leading `v`). The tag must include these release scripts and
   workflows. Tag pushes alone no longer start the release job.
4. Check out the tagged commit with a clean working tree. Sign in to iCloud on
   macOS 27 or later and authenticate `gh` with access to this repository's releases
   and Actions workflows.

## Sign and prepare the draft

Run this command with the new version (for example, `0.4.0`):

```sh
npm run release:prepare -- 0.4.0
```

The command verifies that HEAD matches the remote tag and manifest, runs the
shortcut template tests, and signs a fresh pairing shortcut using `--mode anyone`.
It uploads `save-to-crate-ios-27.shortcut` and `reading-shortcut.json` to a draft
release, then dispatches **Release plugin** against the tag. The metadata records
the signed file's SHA-256 and the shortcut source fingerprint. No file is selected
by modification time, and an old file in `dist/` is never reused after a signing
failure. No tag is created or pushed by this command.

The workflow rejects missing shortcut assets, checksum mismatches, source drift,
and published releases. Existing plugin verification, reproducible-build checks,
and plugin provenance attestations still run. Verified plugin assets are added to
the same draft; CI does not claim to have built or signed the local shortcut.

A failed upload or dispatch leaves a draft, not a public release. Rerun the command
to sign and replace the shortcut assets in that draft, then dispatch again. Do not
run preparation concurrently for the same version. If only CI failed, rerun its
failed jobs without signing again. Published releases cannot be changed by this
command.

## Test and publish

Wait for **Release plugin** to succeed. Download the exact shortcut from the draft
and test import, pairing, and saving on iOS 27 or later. Complete the plugin's
[release acceptance checks](testing.md#public-release-acceptance) against its draft
assets. Publish the draft through GitHub only after those checks pass. This remains
an explicit maintainer action; preparing the release does not publish it.

Publishing triggers **Deploy GitHub Pages**. It selects the most recently published
release containing shortcut metadata, including prereleases, verifies the download,
and serves it at the existing `shortcuts/v1/Save to Crate (iOS 27).shortcut` path.
Plugin-only releases do not replace that selection. An incomplete or corrupted
shortcut release fails deployment instead of silently serving another version.

The first deployment using this flow needs a published release prepared this way.
Existing `0.3.0` has no shortcut metadata and is not modified automatically. Until
that first release is published, Pages fails with an explicit missing-release
message and the previously deployed site remains live. Publishing manually through
GitHub triggers Pages; if publishing via a workflow's `GITHUB_TOKEN`, explicitly
run **Deploy GitHub Pages**, because token-created events do not start another
workflow.
